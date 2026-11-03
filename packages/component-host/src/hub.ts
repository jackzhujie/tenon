/**
 * Hub 客户端（M6 第 1 步）：把组件包**下载下来、验签、原子落盘**。
 *
 * 三件事分开看，各自都有一种糟糕的错法：
 *
 * 1. **包长什么样**。这里用单文件 JSON（`bundle.json`）：清单 + 每个文件的文本。
 *    官方组件全是文本（esbuild 出来的 JS、manifest.json、README.md），所以不需要
 *    tar/zip —— 而引入一个解压器就多一份"解析别人给的字节"的攻击面。等真有二进制
 *    资源（图片/字体）再换格式，那时再换不迟。
 *
 * 2. **怎么验**。Ed25519 签名，签的是 **payload 的规范 JSON 字节**（键有序、无空白）。
 *    签名覆盖清单与全部文件内容——所以"改一行 JS"与"改版本号"是同一件事：都验不过。
 *    **没有"跳过验签"的开关**：一个能关掉的签名等于没有签名。
 *
 * 3. **怎么落盘**。先写临时目录再 rename，且**路径不许跑出目标目录**——包里写
 *    `../../.ssh/authorized_keys` 是最经典的一类漏洞，而它只需要一行 if 就能挡住。
 *
 * 边界：这一步只做「给一个 bundle 地址 → 装好」。索引、更新检查、界面在下一步。
 */
import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseManifest, type ComponentManifest } from './manifest.js'

/** 包格式版本。改结构就 +1，旧客户端必须明确拒绝而不是猜着读 */
export const BUNDLE_FORMAT = 1

/**
 * 环境变量：
 * - `TENON_HUB_URL` 只认这个源下面的地址（否则一个 RPC 就能装任意 URL 的代码）
 * - `TENON_HUB_PUBLIC_KEY` Ed25519 公钥（PEM）。**没有它 Hub 就是"未配置"**
 */
export const HUB_URL_ENV = 'TENON_HUB_URL'
export const HUB_PUBLIC_KEY_ENV = 'TENON_HUB_PUBLIC_KEY'

export interface HubConfig {
  /** 去掉尾部斜杠的源地址 */
  readonly hubUrl: string
  readonly publicKey: string
}

export interface HubBundle {
  readonly format: number
  readonly manifest: ComponentManifest
  /** 相对路径 → 文本内容。**二进制留到需要时再支持**（见文件头） */
  readonly files: Record<string, string>
  /** base64 的 Ed25519 签名，覆盖 `canonicalJson({ format, manifest, files })` */
  readonly sig: string
}

export type HubProblemCode =
  | 'hub-not-configured'
  | 'bad-bundle'
  | 'bad-signature'
  | 'bad-manifest'
  | 'unsafe-path'
  | 'wrong-source'
  | 'fetch-failed'
  | 'url-outside-hub'

export interface HubProblem {
  readonly code: HubProblemCode
  readonly message: string
  /** 给用户/开发者看的补充（错误原文、哪一行不对） */
  readonly hint: string | null
}

export type HubResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: HubProblem }

function fail<T>(code: HubProblemCode, message: string, hint: string | null = null): HubResult<T> {
  return { ok: false, problem: { code, message, hint } }
}

/**
 * 读取 Hub 配置。**两个都缺 = 未配置**（这是正常的：官方 Hub 上线前就是未配置）。
 * 只配了一个 = 配置错了，此时宁可当"未配置"也不要用一个半截的配置去下载代码。
 */
export function hubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const url = env[HUB_URL_ENV]?.trim()
  const key = env[HUB_PUBLIC_KEY_ENV]?.trim()
  if (url === undefined || url === '' || key === undefined || key === '') return null
  // 环境变量里换行常被写成字面量 \n（systemd / docker compose 都会）——不还原的话 PEM 解不开
  const publicKey = key.includes('\\n') ? key.replaceAll('\\n', '\n') : key
  return { hubUrl: url.replace(/\/+$/, ''), publicKey }
}

/**
 * 规范 JSON：对象键排序、不带空白、数组保持顺序、丢弃 undefined。
 *
 * 为什么必须自己实现：`JSON.stringify` 的输出依赖**属性插入顺序**，而"同一份内容
 * 由不同代码路径构造出来"顺序经常不一样 —— 签名就会时对时错，且只在某些机器上错。
 */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk)
    if (input !== null && typeof input === 'object') {
      const source = input as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue
        out[key] = walk(source[key])
      }
      return out
    }
    return input
  }
  return JSON.stringify(walk(value))
}

/** 被签名的那串字节：**不含 sig 本身**（否则签名里包含自己，永远算不出来） */
export function bundleSigningBytes(bundle: Omit<HubBundle, 'sig'>): Buffer {
  return Buffer.from(canonicalJson({ format: bundle.format, manifest: bundle.manifest, files: bundle.files }), 'utf8')
}

/**
 * 给官方发布脚本与测试用：签一个包。
 *
 * 生产环境里私钥不进这个仓库、也不进安装包 —— 它只在发布流水线上。
 */
export function signBundle(bundle: Omit<HubBundle, 'sig'>, privateKeyPem: string): HubBundle {
  const sig = sign(null, bundleSigningBytes(bundle), privateKeyPem).toString('base64')
  return { ...bundle, sig }
}

export interface VerifyResult {
  readonly bundle: HubBundle
  /** 签名私钥的指纹（sha256 前 16 位）—— 出现"换过 key"时能看出来 */
  readonly keyFingerprint: string
}

/** 公钥指纹（sha256 前 16 位）：界面上显示它，换过 key 时能看出来 */
export function hubKeyFingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

/** 校验结构的顺序很重要：先看形状，再看签名，最后才看清单内容 */
export function verifyBundle(raw: unknown, publicKeyPem: string): HubResult<VerifyResult> {
  if (raw === null || typeof raw !== 'object') return fail('bad-bundle', '组件包不是一个对象')
  const candidate = raw as Partial<HubBundle>

  if (candidate.format !== BUNDLE_FORMAT) {
    return fail('bad-bundle', `组件包格式是 ${String(candidate.format)}，这个版本只认 ${BUNDLE_FORMAT}`)
  }
  if (typeof candidate.sig !== 'string' || candidate.sig === '') {
    // 没有签名就是没有签名 —— 不"宽容通过"，那等于把整个机制变成装饰
    return fail('bad-signature', '组件包没有签名')
  }
  const files = candidate.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    return fail('bad-bundle', '组件包里 files 不是一个对象')
  }
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') return fail('bad-bundle', `files["${path}"] 不是文本`)
  }

  /*
   * 先验签，再解析清单：反过来的话，一个没签名的包也能让我们的 zod 去啃它 ——
   * 那种"先解析再验证"的顺序，历史上出过太多解析器漏洞。
   */
  const signed: Omit<HubBundle, 'sig'> = {
    format: BUNDLE_FORMAT,
    manifest: candidate.manifest as ComponentManifest,
    files: files as Record<string, string>,
  }
  let valid = false
  try {
    const key = createPublicKey(publicKeyPem)
    valid = verify(null, bundleSigningBytes(signed), key, Buffer.from(candidate.sig, 'base64'))
  } catch (error) {
    return fail('bad-signature', '验签失败：公钥读不出来', error instanceof Error ? error.message : String(error))
  }
  if (!valid) return fail('bad-signature', '验签失败：这个包不是用官方私钥签的（或者被改过）')

  const parsed = parseManifest(candidate.manifest)
  if (parsed.manifest === null) {
    return fail('bad-manifest', '组件包里的清单不合法', parsed.issues.join('；'))
  }
  const manifest = parsed.manifest

  return {
    ok: true,
    value: { bundle: { format: BUNDLE_FORMAT, manifest, files: signed.files, sig: candidate.sig }, keyFingerprint: hubKeyFingerprint(publicKeyPem) },
  }
}

/** 包里的路径必须是干净相对路径：不许绝对路径、不许 `..`、不许控制字符 */
function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false
  if (path.includes('\0')) return false
  return !path.split(/[\\/]/).some((segment) => segment === '..' || segment === '')
}

/** 落盘目标：`<hubDir>/<id>/<version>/`（加载器的 hub 布局） */
export function hubBundleDir(hubDir: string, manifest: ComponentManifest): string {
  return join(hubDir, manifest.id, manifest.version)
}

export interface InstallBundleOptions {
  readonly hubDir: string
  /** Hub 上的原始 bundle（未验证） */
  readonly raw: unknown
  readonly publicKeyPem: string
  /** 期望的 id / 版本（索引里写的）。给了就必须对上，挡住"索引说 A、包里是 B" */
  readonly expect?: { readonly id?: string; readonly version?: string }
}

export interface InstalledBundle {
  readonly id: string
  readonly version: string
  readonly dir: string
  readonly keyFingerprint: string
  readonly files: readonly string[]
}

/**
 * 验签 + 落盘。
 *
 * 原子性：先写 `<id>/.<version>.tmp-xxxx`，成功后再 rename 过去。
 * 中途崩了只会留下一个临时目录（无害），不会留下"装了一半、加载器读得进去"的版本 ——
 * 那才是最坏的情况：`manifest.json` 在、`web.js` 少了一半，页面上什么也没有，日志里也没有。
 */
export async function installBundle(options: InstallBundleOptions): Promise<HubResult<InstalledBundle>> {
  const verified = verifyBundle(options.raw, options.publicKeyPem)
  if (!verified.ok) return verified

  const bundle = verified.value.bundle
  const { id, version } = bundle.manifest
  if (options.expect?.id !== undefined && options.expect.id !== id) {
    return fail('bad-manifest', `索引里写的是 ${options.expect.id}，包里是 ${id}`)
  }
  if (options.expect?.version !== undefined && options.expect.version !== version) {
    return fail('bad-manifest', `索引里写的是 ${options.expect.version}，包里是 ${version}`)
  }

  /*
   * 路径检查在写之前一次性做完：写到一半才发现某个路径非法，就得回滚已写的文件。
   */
  const entries = Object.entries(bundle.files)
  if (entries.length === 0) return fail('bad-bundle', '组件包里一个文件都没有')
  for (const [path] of entries) {
    if (!isSafeRelativePath(path)) {
      return fail('unsafe-path', `组件包里有不安全的路径：${path}`, '只能是包内的相对路径，不能有 ..')
    }
    if (path === 'manifest.json') {
      return fail('bad-bundle', '组件包里不许自带 manifest.json', '清单以包里的 manifest 字段为准')
    }
  }
  for (const [host, facet] of Object.entries(bundle.manifest.facets)) {
    if (facet !== undefined && bundle.files[facet] === undefined) {
      return fail('bad-manifest', `清单声明了 ${host} facet「${facet}」，包里却没有这个文件`)
    }
  }

  const manifest: ComponentManifest = {
    ...bundle.manifest,
    /*
     * `source` 由**装在哪**决定，不由包自己说。包说自己是 bundled 也不能改变来源标识 ——
     * 来源标签是给用户看"这段代码从哪来"的，让它自称就不值钱了。
     */
    source: 'hub',
    signature: bundle.sig,
  }

  const target = hubBundleDir(options.hubDir, manifest)
  const staging = join(dirname(target), `.${version}.tmp-${randomUUID().slice(0, 8)}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const [path, content] of entries) {
      const file = join(staging, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content, 'utf8')
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    // 同版本重装：先把旧的挪开，再把新的挪上去（两步窗口比"先删再写"窄）
    const retired = `${target}.old-${randomUUID().slice(0, 8)}`
    await rename(target, retired).catch(() => {})
    await mkdir(dirname(target), { recursive: true })
    await rename(staging, target)
    await rm(retired, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    ok: true,
    value: {
      id,
      version,
      dir: target,
      keyFingerprint: verified.value.keyFingerprint,
      files: entries.map(([path]) => path),
    },
  }
}

export interface InstallFromHubOptions {
  readonly hubDir: string
  readonly config: HubConfig
  /** 只接受这个源下面的地址（`TENON_HUB_URL` 的后缀） */
  readonly bundleUrl: string
  /** 测试注入 */
  readonly fetch?: typeof globalThis.fetch
  readonly expect?: InstallBundleOptions['expect']
  readonly timeoutMs?: number
}

/** 从 Hub 下载并安装。地址必须落在 `TENON_HUB_URL` 之下 —— 否则一个 RPC 就能装任意代码 */
export async function installFromHub(options: InstallFromHubOptions): Promise<HubResult<InstalledBundle>> {
  const target = options.bundleUrl.trim()
  if (!target.startsWith(`${options.config.hubUrl}/`)) {
    return fail(
      'url-outside-hub',
      '只能从配置的 Hub 下载组件',
      `这个地址不在 ${options.config.hubUrl} 之下：${target}`,
    )
  }

  const doFetch = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  let raw: unknown
  try {
    const response = await doFetch(target, { signal: controller.signal })
    if (!response.ok) {
      return fail('fetch-failed', `下载组件包失败：HTTP ${response.status}`, target)
    }
    raw = (await response.json()) as unknown
  } catch (error) {
    return fail('fetch-failed', '下载组件包失败（网络或超时）', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }

  return installBundle({
    hubDir: options.hubDir,
    raw,
    publicKeyPem: options.config.publicKey,
    ...(options.expect === undefined ? {} : { expect: options.expect }),
  })
}
