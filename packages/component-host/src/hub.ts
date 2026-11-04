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
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseManifest, type ComponentManifest } from './manifest.js'
import { discoverRoot } from './resolve.js'
import { compareVersionText, satisfiesRange } from './version.js'

/** 包格式版本。改结构就 +1，旧客户端必须明确拒绝而不是猜着读 */
export const BUNDLE_FORMAT = 1

/**
 * 环境变量：
 * - `TENON_HUB_URL` 只认这个源下面的地址（否则一个 RPC 就能装任意 URL 的代码）
 * - `TENON_HUB_PUBLIC_KEY` Ed25519 公钥（PEM）。**没有它 Hub 就是"未配置"**
 * - `TENON_HUB_CONFIG_FILE` 打包时随包带的那份配置（见 `resolveHubConfig`）
 */
export const HUB_URL_ENV = 'TENON_HUB_URL'
export const HUB_PUBLIC_KEY_ENV = 'TENON_HUB_PUBLIC_KEY'
export const HUB_CONFIG_FILE_ENV = 'TENON_HUB_CONFIG_FILE'

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
  /** 索引说这个组件是付费的，而购买流程还没做（M6 第 5 步：连下载都不给） */
  | 'paid-not-available'

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
 * 把一对原始字符串归一成配置。两边都空 = 未配置（正常）；只给一边 = 配错了（不正常）。
 *
 * 三条校验都在这里做，因为它们**都是"配错了"而不是"装的时候才炸"**：
 * - URL 必须是 http(s)：`file://` 会让"下载"变成"读本机任意文件"，那是另一类问题了
 * - PEM 必须是公钥形状：形状不对时 `createPublicKey` 要到第一次安装才抛，
 *   而那时用户看到的是一句来自 node:crypto 的英文报错
 * - 字面量 `\n` 要还原：systemd / docker compose 写 PEM 都会变成一行
 */
function parseHubPair(
  url: string | undefined,
  key: string | undefined,
): { ok: true; value: HubConfig | null } | { ok: false; message: string } {
  const rawUrl = url?.trim() ?? ''
  const rawKey = key?.trim() ?? ''
  if (rawUrl === '' && rawKey === '') return { ok: true, value: null }
  if (rawUrl === '') return { ok: false, message: '有公钥但没有 URL' }
  if (rawKey === '') return { ok: false, message: '有 URL 但没有公钥' }
  if (!/^https?:\/\//i.test(rawUrl)) {
    return { ok: false, message: `Hub 地址必须是 http(s):// 开头（现在是 ${rawUrl.slice(0, 40)}）` }
  }
  /*
   * 顺序不能反：先把字面量 `\n` 还成真换行，**再** trim。
   * 反过来会留下一个尾换行 —— 而尾换行参与指纹，同一把 key 的两种写法就会给出
   * 两个指纹，界面上看起来像"发布方换过密钥"。
   */
  const publicKey = (rawKey.includes('\\n') ? rawKey.replaceAll('\\n', '\n') : rawKey).trim()
  if (!publicKey.includes('BEGIN') || !publicKey.includes('PUBLIC KEY')) {
    return { ok: false, message: '公钥不是 PEM 形状（应该以 -----BEGIN PUBLIC KEY----- 开头）' }
  }
  return { ok: true, value: { hubUrl: rawUrl.replace(/\/+$/, ''), publicKey } }
}

/**
 * 读取 Hub 配置。**两个都缺 = 未配置**（这是正常的：官方 Hub 上线前就是未配置）。
 * 只配了一个 = 配置错了，此时宁可当"未配置"也不要用一个半截的配置去下载代码。
 *
 * 只管环境变量。要"环境变量 > 随包配置 > 未配置"这个优先级，用 `resolveHubConfig`。
 */
export function hubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const parsed = parseHubPair(env[HUB_URL_ENV], env[HUB_PUBLIC_KEY_ENV])
  return parsed.ok ? parsed.value : null
}

/** 配置从哪来。界面要显示它 —— "为什么我的商店是空的"第一句就该能回答 */
export type HubConfigOrigin = 'env' | 'file'

export interface HubConfigResolution {
  readonly config: HubConfig | null
  readonly origin: HubConfigOrigin | null
  /**
   * 没配上时的原因（配错了 / 文件坏了）。
   * **`null` 且 `config === null` 才是"就是没配"** —— 这一区分是为了让界面能说
   * "你设了 URL 但忘了公钥"，而不是干巴巴一句"未配置"。
   */
  readonly note: string | null
}

/** 随包配置文件的形状。字段名与 manifest 无关，只描述"连哪儿、验谁的签" */
export interface HubConfigFile {
  readonly hubUrl: string
  readonly publicKey: string
}

export interface ResolveHubConfigInput {
  readonly env?: NodeJS.ProcessEnv
  /** 便于测试注入；默认 `readFileSync(utf8)` */
  readonly readFile?: (path: string) => string
}

/**
 * Hub 配置的**唯一**解析入口（M6 第 5 步）。
 *
 * 优先级：`TENON_HUB_URL`+`TENON_HUB_PUBLIC_KEY`（环境变量） > `TENON_HUB_CONFIG_FILE`
 * 指向的 JSON（安装包里那份）> 未配置。
 *
 * 为什么需要"随包配置"这一档：M6 之前 Hub 配置只能靠环境变量，而**用户双击打开
 * `.app` 时没有环境变量** —— 于是商店永远显示"未配置"，且这不是错误，不会有人发现。
 * 官方 Hub 的地址与公钥是公开信息（公钥本来就该随客户端发布，像 VS Code 内置
 * marketplace 公钥那样），所以它应该像模板、插件一样打在包里。
 *
 * 为什么文件由壳指路径、而不是壳读完塞进环境变量：与 `TENON_PLUGINS_DIR` /
 * `TENON_TEMPLATES_DIR` 同一个模式 —— 壳只负责"指一个位置"，内容由业务侧读。
 * 好处是这里能分辨来源并如实报出来（`origin`），而不是让"包里的"和"用户设的"
 * 在环境变量里长得一模一样。
 *
 * 为什么环境变量只设一半时**不**回落到文件：那是"我要换源"，而换源必须连公钥一起换
 * （只换 URL 一定验不过签）。这时候用包里的旧配置会让人以为自己的设置生效了。
 */
export function resolveHubConfig(input: ResolveHubConfigInput = {}): HubConfigResolution {
  const env = input.env ?? process.env
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'))

  const fromEnv = parseHubPair(env[HUB_URL_ENV], env[HUB_PUBLIC_KEY_ENV])
  if (!fromEnv.ok) return { config: null, origin: null, note: fromEnv.message }
  if (fromEnv.value !== null) return { config: fromEnv.value, origin: 'env', note: null }

  const file = env[HUB_CONFIG_FILE_ENV]?.trim() ?? ''
  if (file === '') return { config: null, origin: null, note: null }

  let raw: string
  try {
    raw = readFile(file)
  } catch (error) {
    // 文件是壳指的，指到了不存在的路径说明打包漏了东西 —— 说出来，别当成"没配"
    return {
      config: null,
      origin: null,
      note: `读不到 Hub 配置文件 ${file}：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { config: null, origin: null, note: `${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  const shape = parsed as Partial<Record<keyof HubConfigFile, unknown>> | null
  if (shape === null || typeof shape !== 'object') {
    return { config: null, origin: null, note: `${file} 的内容不是一个对象` }
  }
  /*
   * 两个键都不在 = 文件写错了（字段名拼错）。
   * 两个键都在但都是空串 = **构建时就没配**（`build.mjs` 会写这样一份占位），
   * 那是正常状态，不该报"配置错误"。这个区分能省掉一次"商店为什么是空的"排查。
   */
  if (!('hubUrl' in shape) && !('publicKey' in shape)) {
    return { config: null, origin: null, note: `${file} 里没有 hubUrl / publicKey` }
  }
  const url = typeof shape.hubUrl === 'string' ? shape.hubUrl : undefined
  const key = typeof shape.publicKey === 'string' ? shape.publicKey : undefined
  const fromFile = parseHubPair(url, key)
  if (!fromFile.ok) return { config: null, origin: null, note: `${file}：${fromFile.message}` }
  if (fromFile.value === null) return { config: null, origin: null, note: null }
  return { config: fromFile.value, origin: 'file', note: null }
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

/**
 * 公钥指纹（sha256 前 16 位）：界面上显示它，换过 key 时能看出来。
 *
 * **先 trim**：PEM 的尾换行不该改变指纹。不 trim 的话同一把 key 从环境变量
 * （已归一）与从文件（带尾换行）读出来会得到两个指纹，界面就会误报"发布方换过密钥"。
 */
export function hubKeyFingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem.trim()).digest('hex').slice(0, 16)
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

/* ------------------------------------------------------------------ *
 * 索引（M6 第 2 步）：Hub 上有哪些组件、各自有哪些版本
 * ------------------------------------------------------------------ */

/**
 * 索引格式版本。与 `BUNDLE_FORMAT` 分开：索引是"目录"，包是"货"，
 * 两者的演进节奏不一样（加一个字段 vs 改文件编码），共用一个号会互相绊住。
 */
export const HUB_INDEX_FORMAT = 1

export interface HubIndexVersion {
  readonly version: string
  /** **绝对地址**，必须落在 `TENON_HUB_URL` 之下（安装时还会再判一次） */
  readonly url: string
  /** 这一版改了什么（一句话）。界面上直接显示，所以别写 changelog */
  readonly notes: string | null
  readonly publishedAt: number | null
}

export interface HubIndexComponent {
  readonly id: string
  readonly name: string
  readonly description: string
  /**
   * 付费标记。**只是显示用的提示**，不是判据 ——
   * 判据在包里（清单带签名），所以索引把 paid 写成 free 也不会变成免费：
   * 装上那一刻会按清单拒绝。反过来写错只会让一个免费组件在商店里显示成付费。
   *
   * 缺省当 free：早期索引没有这个字段，不能让它们全部变成"付费"。
   */
  readonly pricing?: 'free' | 'paid' | undefined
  /**
   * 版本列表。**不假设有序** —— 合约里没写"按版本升序"，所以取最新一律走比较，
   * 不取 `versions.at(-1)`。索引是别人生成的，靠顺序假设是最容易崩的一种信任。
   */
  readonly versions: readonly HubIndexVersion[]
}

export interface HubIndex {
  readonly format: number
  readonly generatedAt: number
  readonly components: readonly HubIndexComponent[]
  /** base64 的 Ed25519 签名，覆盖 `canonicalJson({ format, generatedAt, components })` */
  readonly sig: string
}

/**
 * 索引也要签名 —— 这一条不是洁癖。
 *
 * 索引决定"客户端被告知有什么可用、最新是哪个、从哪里下"。包本身有签名，所以篡改索引
 * 装不进恶意代码；但可以**降级**：把"最新"指向一个旧的、确实签过名的版本，用户点"更新"
 * 就退回有漏洞的那一版。没有索引签名，这类攻击在客户端完全看不出来。
 *
 * 同一个密钥签索引与包：多一把密钥就多一处要保护、要轮换、要对齐的地方，
 * 而这里没有任何"索引与包应该分权"的理由。
 */
export function hubIndexSigningBytes(index: Omit<HubIndex, 'sig'>): Buffer {
  return Buffer.from(
    canonicalJson({
      format: index.format,
      generatedAt: index.generatedAt,
      components: index.components,
    }),
    'utf8',
  )
}

export function signHubIndex(index: Omit<HubIndex, 'sig'>, privateKeyPem: string): HubIndex {
  return {
    ...index,
    sig: sign(null, hubIndexSigningBytes(index), privateKeyPem).toString('base64'),
  }
}

function isIndexComponent(value: unknown): value is HubIndexComponent {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  if (typeof item['id'] !== 'string' || item['id'] === '') return false
  if (!Array.isArray(item['versions'])) return false
  return item['versions'].every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false
    const version = entry as Record<string, unknown>
    return typeof version['version'] === 'string' && typeof version['url'] === 'string'
  })
}

/** 验签 + 形状检查。顺序与包一致：先看形状（不然验签函数要对着任意 JSON 干活），再验签 */
export function verifyHubIndex(
  raw: unknown,
  publicKeyPem: string,
): HubResult<{ index: HubIndex; keyFingerprint: string }> {
  if (typeof raw !== 'object' || raw === null) return fail('bad-bundle', '索引不是一个 JSON 对象')
  const data = raw as Record<string, unknown>
  if (data['format'] !== HUB_INDEX_FORMAT) {
    return fail(
      'bad-bundle',
      `索引格式是 ${String(data['format'])}，这个客户端只认 ${String(HUB_INDEX_FORMAT)}`,
      '升级 Tenon 之后再看，或者让 Hub 提供旧格式',
    )
  }
  if (typeof data['sig'] !== 'string' || data['sig'] === '') {
    return fail('bad-signature', '索引没有签名', '不验签的索引可以被降级到任意旧版本')
  }
  if (!Array.isArray(data['components']) || !data['components'].every(isIndexComponent)) {
    return fail('bad-bundle', '索引里的 components 形状不对')
  }

  const index = data as unknown as HubIndex
  let ok = false
  try {
    ok = verify(
      null,
      hubIndexSigningBytes({
        format: index.format,
        generatedAt: typeof data['generatedAt'] === 'number' ? data['generatedAt'] : 0,
        components: index.components,
      }),
      publicKeyPem,
      Buffer.from(index.sig, 'base64'),
    )
  } catch (error) {
    return fail('bad-signature', '索引验签失败（签名不是合法的 base64 或密钥不对）', error instanceof Error ? error.message : String(error))
  }
  if (!ok) return fail('bad-signature', '索引验签失败：内容与签名不一致')
  return { ok: true, value: { index, keyFingerprint: hubKeyFingerprint(publicKeyPem) } }
}

export interface InstallFromIndexOptions {
  readonly hubDir: string
  readonly config: HubConfig
  readonly id: string
  /** 精确版本；不给 = 索引里的最新 */
  readonly version?: string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/**
 * 「按 id 从 Hub 装到本机」—— `hub.install` 与「装组件时本机没有」两处共用。
 *
 * 为什么要经过索引而不是让调用方给地址：校验只剩"是不是同一个源"的时候，
 * "装的是不是用户以为的那个组件"就没人管得着。地址只从签名索引里来。
 */
export async function installFromHubIndex(
  options: InstallFromIndexOptions,
): Promise<HubResult<InstalledBundle>> {
  const fetched = await fetchHubIndex({
    config: options.config,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  if (!fetched.ok) return fetched

  const component = findIndexComponent(fetched.value.index, options.id)
  if (component === undefined) {
    return fail('bad-bundle', `Hub 上没有 ${options.id} 这个组件`, '检查 id 拼写；或者它还没发布')
  }
  /*
   * 付费组件**连下载都不做**（M6 第 5 步补的门）。
   *
   * 之前只有 `installComponent` 拦付费，而那是"装进应用"的入口；`hub.install` 是
   * "装到本机"，它会把包原样落到 `~/.tenon/plugins/` —— 于是"付费组件"变成了
   * "付不了但能下载"。文件是明文的，真要说 DRM 那本来就不成立；但**主动帮用户
   * 把没买的组件下载下来**是另一回事，不做。
   *
   * 为什么可以用索引上的 `pricing` 判：这一层拒错的代价是"用户看到一句'暂未开放'"
   * （可以重试），而漏判的代价是"付费内容已经在本机磁盘上"。宁可误拒。
   * 真判据仍在包里 —— 索引说 free 而包里是 paid 时，装配那一步会拦下来。
   */
  if (component.pricing === 'paid') {
    return fail(
      'paid-not-available',
      `${component.id} 是付费组件，现在还不能下载`,
      '付费与购买流程还没做（DESIGN §21.5）。这里拦的是"下载"，装进应用时还会再拦一次',
    )
  }
  const wanted =
    options.version === undefined
      ? latestVersion(component)
      : component.versions.find((entry) => entry.version === options.version)
  if (wanted === undefined) {
    const known = component.versions.map((entry) => entry.version).join('、')
    return fail(
      'bad-bundle',
      `Hub 上没有 ${options.id}@${options.version ?? '(最新)'}`,
      `现有版本：${known === '' ? '（无）' : known}`,
    )
  }

  return installFromHub({
    hubDir: options.hubDir,
    config: options.config,
    bundleUrl: wanted.url,
    // 索引说 A@1.1.0、包里是别的 → 拒。索引签名只证明"这份索引没被改"，
    // 不证明"这个地址上的包就是它"
    expect: { id: component.id, version: wanted.version },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
}

export interface FetchHubIndexOptions {
  readonly config: HubConfig
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

/** 索引地址固定是 `<hubUrl>/index.json` —— 不让调用方指定，少一个可被利用的参数 */
export function hubIndexUrl(config: HubConfig): string {
  return `${config.hubUrl}/index.json`
}

export async function fetchHubIndex(
  options: FetchHubIndexOptions,
): Promise<HubResult<{ index: HubIndex; keyFingerprint: string }>> {
  const url = hubIndexUrl(options.config)
  const doFetch = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  let raw: unknown
  try {
    const response = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      return fail('fetch-failed', `读不到 Hub 索引：HTTP ${response.status}`, url)
    }
    raw = (await response.json()) as unknown
  } catch (error) {
    return fail('fetch-failed', '读不到 Hub 索引（网络或超时）', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
  return verifyHubIndex(raw, options.config.publicKey)
}

/** 该组件的最新版本。用比较而不是拿最后一个 —— 索引不保证有序 */
export function latestVersion(component: HubIndexComponent): HubIndexVersion | undefined {
  let best: HubIndexVersion | undefined
  for (const entry of component.versions) {
    if (typeof entry.version !== 'string' || entry.version === '') continue
    if (best === undefined || compareVersionText(entry.version, best.version) > 0) best = entry
  }
  return best
}

export function findIndexComponent(index: HubIndex, id: string): HubIndexComponent | undefined {
  return index.components.find((component) => component.id === id)
}

export interface HubInstalled {
  readonly id: string
  readonly version: string
}

/**
 * 本机 hub 根上装了哪些（每个 id 取最高版本）。
 *
 * 为什么取最高而不是"全部列出来"：装配时解析器也是按最高版本选，所以"能升级到哪"
 * 这个问题只关心最高那份。旧版本留着不删（见 `installBundle` 的注释）。
 */
export async function listInstalledHubComponents(hubDir: string): Promise<HubInstalled[]> {
  if (hubDir === '') return []
  const best = new Map<string, string>()
  for (const plugin of await discoverRoot({ kind: 'hub', dir: hubDir })) {
    const version = plugin.manifest?.version
    if (version === undefined) continue
    const current = best.get(plugin.id)
    if (current === undefined || compareVersionText(version, current) > 0) best.set(plugin.id, version)
  }
  return [...best.entries()].map(([id, version]) => ({ id, version }))
}

/** 应用装配声明里的一条（只取判断"能不能用上新版"需要的字段） */
export interface HubDeclaration {
  readonly appId: string
  readonly id: string
  /** 声明里的版本区间（`^1.0.0` 这种） */
  readonly range: string
}

export interface HubUpdate {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 本机最高版本；没装过是 null */
  readonly installedVersion: string | null
  readonly latest: string
  readonly notes: string | null
  /** 付费标记（**显示用**；真判据在包里，见 `HubIndexComponent.pricing`） */
  readonly paid: boolean
  /** 有更新 = 装过、且 latest 比本机高。**降级不算更新**（见函数注释） */
  readonly update: boolean
  /**
   * 声明了这个组件、但版本区间**不接受** latest 的应用。
   *
   * 这些应用就算把新版装到磁盘上也不会用它 —— 解析器只挑满足区间的最高版本。
   * 界面上必须说出来，否则用户点了"更新"，看到版本没变，会以为更新功能坏了。
   */
  readonly blockedBy: readonly string[]
}

/**
 * 对比索引与本机，得出"哪些可以更新"。
 *
 * 三条判断都有具体的错法：
 * 1. **降级不是更新**。索引里的"最新"比本机低时（官方回滚 / 镜像过期），
 *    直接拿 `!==` 判会把人往旧版本推，而那正好是索引签名要防的事。
 * 2. **没装过 ≠ 有更新**。`update` 只在装过时成立；没装过的归"可安装"。
 * 3. **区间不接受就不算能更新**。见 `blockedBy`。
 */
export function planHubUpdates(input: {
  readonly index: HubIndex
  readonly installed: readonly HubInstalled[]
  readonly declarations?: readonly HubDeclaration[]
}): HubUpdate[] {
  const installedOf = new Map(input.installed.map((item) => [item.id, item.version]))
  const updates: HubUpdate[] = []

  for (const component of input.index.components) {
    const latest = latestVersion(component)
    if (latest === undefined) continue
    const installedVersion = installedOf.get(component.id) ?? null
    const update = installedVersion !== null && compareVersionText(latest.version, installedVersion) > 0
    const blockedBy = (input.declarations ?? [])
      .filter((item) => item.id === component.id)
      .filter((item) => {
        try {
          return !satisfiesRange(latest.version, item.range)
        } catch {
          // 区间写法不认识 → 当作"不接受"：宁可少提示，也不要把装不上的版本推给用户
          return true
        }
      })
      .map((item) => item.appId)
    updates.push({
      id: component.id,
      name: component.name,
      description: component.description,
      installedVersion,
      latest: latest.version,
      notes: latest.notes,
      paid: component.pricing === 'paid',
      update,
      blockedBy: [...new Set(blockedBy)],
    })
  }

  // 装过的排在前面（用户更关心自己有的东西），再按 id 稳定排序
  return updates.sort((a, b) => {
    if ((a.installedVersion === null) !== (b.installedVersion === null)) {
      return a.installedVersion === null ? 1 : -1
    }
    return a.id.localeCompare(b.id)
  })
}
