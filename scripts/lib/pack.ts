/**
 * 把一个官方组件打包成 Hub 能分发的 `bundle.json`（M6 第 1 步的发布侧）。
 *
 * 为什么抽成模块而不是写成脚本：`pnpm pack:plugin` 是**发布动作**，`pnpm e2e:hub`
 * 是**验收动作**，两者必须走同一段代码。分成两份实现的话，验收脚本验的是"另一套打包器"，
 * 而真实发布链路上的问题（少打一个 facet、清单没改成 hub 来源、索引没重新签名）
 * 一条都测不出来 —— 那种测试比没有测试更危险。
 *
 * 三件硬约束：
 * 1. **没有私钥就不产出包**。客户端只认签名过的，出一个没签名的包等于给用户一个
 *    装不上的文件，而问题要到安装那一刻才暴露。
 * 2. **包与索引同一次产生**。手工维护索引必然出现"包传了索引没写"（用户永远看不到新版）
 *    或"索引写了包没传"（点了更新 404）。
 * 3. **换过密钥不许悄悄覆盖索引**。覆盖会丢掉旧版本的地址，而旧地址是已经发出去的。
 */
import { createPublicKey } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  HUB_INDEX_FORMAT,
  parseManifest,
  signBundle,
  signHubIndex,
  verifyHubIndex,
  type HubIndex,
  type HubIndexComponent,
} from '../../packages/component-host/src/index.js'

export interface PackResult {
  readonly file: string
  readonly version: string
  /** 打进包里的文件数 */
  readonly files: number
  readonly bytes: number
  /** 写了索引就是它的路径；`hubUrl` 为 null 时是 null（见 `PackInput.hubUrl`） */
  readonly indexFile: string | null
  readonly indexComponents: number
}

export interface PackInput {
  /** 组件源目录的父目录（`plugins/bundled`） */
  readonly sourceDir: string
  readonly outDir: string
  readonly id: string
  /** Ed25519 私钥 PEM。**不进仓库、不进安装包** */
  readonly privateKey: string
  /**
   * Hub 的公开地址。索引里必须是**绝对地址**（客户端只认 Hub 源之下的 URL），
   * 所以这里不猜 —— 给 null 就只打包、不写索引。
   */
  readonly hubUrl: string | null
  /**
   * 打包前改一次清单原文。e2e 用它造一个"付费组件"（把 pricing 改成 paid），
   * 也用它造"改了一个字段应该验签失败"的包。
   */
  readonly patchManifest?: (raw: Record<string, unknown>) => Record<string, unknown>
}

/** 发布失败的原因都写成这句话能读的样子 —— 脚本层的 catch 直接打印 */
export class PackError extends Error {}

export async function packComponent(input: PackInput): Promise<PackResult> {
  if (input.privateKey.trim() === '') {
    throw new PackError('缺私钥。没有私钥就不该产出包 —— 客户端只认签名过的。')
  }

  const pluginDir = join(input.sourceDir, input.id)
  const raw = JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const patched = input.patchManifest === undefined ? raw : input.patchManifest(raw)

  const parsed = parseManifest(patched)
  if (parsed.manifest === null) {
    throw new PackError(`清单不合法：\n- ${parsed.issues.join('\n- ')}`)
  }
  const manifest = parsed.manifest
  if (manifest.id !== input.id) {
    throw new PackError(`目录名是 ${input.id}，清单里是 ${manifest.id} —— 两者必须一致（加载器按目录名找）`)
  }

  /*
   * 打进包里的文件：清单声明的 facet + README（agentHints 的完整版，人也要读）。
   * 不打包 `*.ts` 源文件：facet 是构建产物，装上就能跑；带上源码只会让包变大，
   * 还会让人以为"Hub 上的组件是可以就地改的"。
   */
  const files: Record<string, string> = {}
  for (const [host, facet] of Object.entries(manifest.facets)) {
    if (typeof facet !== 'string') continue
    try {
      files[facet] = await readFile(join(pluginDir, facet), 'utf8')
    } catch {
      throw new PackError(`清单声明了 ${host} facet「${facet}」，但文件不存在 —— 先跑 pnpm build:plugins`)
    }
  }
  try {
    files['README.md'] = await readFile(join(pluginDir, 'README.md'), 'utf8')
  } catch {
    // README 是给 Agent 读的用法说明，可选
  }

  const bundle = signBundle(
    {
      format: 1,
      // source 由安装端改写；这里统一写 hub —— 包一旦发出去，它就是从 Hub 来的
      manifest: { ...manifest, source: 'hub' },
      files,
    },
    input.privateKey,
  )

  await mkdir(input.outDir, { recursive: true })
  const outFile = join(input.outDir, `${manifest.id}-${manifest.version}.json`)
  await writeFile(outFile, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')

  const result: PackResult = {
    file: outFile,
    version: manifest.version,
    files: Object.keys(files).length,
    bytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
    indexFile: null,
    indexComponents: 0,
  }

  if (input.hubUrl === null) return result

  const hubUrl = input.hubUrl.replace(/\/+$/, '')
  const indexFile = join(input.outDir, 'index.json')
  const existing = await readExistingIndex(indexFile, input.privateKey)

  const versionEntry = {
    version: manifest.version,
    url: `${hubUrl}/${basename(outFile)}`,
    notes: manifest.description,
    publishedAt: Date.now(),
  }

  /*
   * 索引上要标出付费。**这不是判据**（判据在签名过的包里），但它决定了客户端
   * 会不会在下载前就停下 —— 不标的话 `installFromHubIndex` 的付费早退永远不会触发，
   * 而那条早退正是"别把没买的组件下载到用户磁盘"的唯一关卡。
   */
  const pricing: 'free' | 'paid' = manifest.pricing.type === 'paid' ? 'paid' : 'free'

  const components: HubIndexComponent[] = [...(existing?.components ?? [])]
  const at = components.findIndex((item) => item.id === manifest.id)
  if (at === -1) {
    components.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      pricing,
      versions: [versionEntry],
    })
  } else {
    const current = components[at]!
    components[at] = {
      ...current,
      name: manifest.name,
      description: manifest.description,
      pricing,
      // 同版本重新发布：替换那条（热修必须能用同一个版本号覆盖）
      versions: [...current.versions.filter((entry) => entry.version !== manifest.version), versionEntry],
    }
  }

  const index = signHubIndex({ format: HUB_INDEX_FORMAT, generatedAt: Date.now(), components }, input.privateKey)
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return { ...result, indexFile, indexComponents: components.length }
}

/**
 * 读已经有索引，并且**必须**是这个私钥签的。
 *
 * 换过密钥时直接覆盖会丢掉旧版本的地址 —— 而那些地址已经发出去了。
 * 这里宁可失败并让人明确处理（删掉重发 / 用旧钥匙重发），也不做"悄悄合并"。
 */
async function readExistingIndex(file: string, privateKey: string): Promise<HubIndex | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 第一次发布：没有索引是正常的
    return null
  }
  if (raw === null || typeof raw !== 'object' || (raw as HubIndex).sig === undefined) {
    throw new PackError(`${file} 看起来不是签名过的索引 —— 删掉它再发布，别在坏文件上叠加`)
  }
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  const check = verifyHubIndex(raw, derived)
  if (!check.ok) {
    throw new PackError(
      `${file} 不是用这把私钥签的（${check.problem.message}）。\n` +
        '换过密钥就先删掉它，或者用旧密钥重新生成 —— 直接覆盖会丢掉旧版本的地址。',
    )
  }
  return check.value.index
}
