/**
 * 在磁盘上找插件，并按装配声明选出**一个版本**。
 *
 * 两种目录布局都要认，因为 Phase 2 会把 Hub 版按版本号平铺：
 *
 * ```
 * bundled root:  <root>/<id>/manifest.json
 * hub root:      <root>/<id>/<version>/manifest.json
 * ```
 *
 * 扫描规则写成一件事：**看两层，谁有 `manifest.json` 谁是插件**。这样两种布局共用一段代码，
 * 也不会因为 M6 改用平铺就重写解析（同一套 manifest、同一个加载器的承诺靠这个兑现）。
 *
 * 目录名是 id 的权威来源：`manifest.id` 与目录名不一致时由 `plan.ts` 报错 ——
 * 否则一个放错位置的目录会让"装配了 A、实际装上了 B"。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComponentManifest } from './manifest.js'
import { readManifest } from './manifest.js'
import type { PluginRoot } from './roots.js'
import { compareVersionText, satisfiesRange } from './version.js'

export interface DiscoveredPlugin {
  /** 目录名（`<root>/<id>/` 里的 `id`） */
  readonly id: string
  /** 插件目录的绝对路径 */
  readonly dir: string
  readonly root: PluginRoot
  /** 清单读不出来时是 null，原因在 `issues`（照样列出来，用户要能看见"这个包坏了"）*/
  readonly manifest: ComponentManifest | null
  readonly issues: readonly string[]
}

/** 清单读得出来的那些 —— 只有这样才谈得上"能不能装" */
export interface UsablePlugin extends DiscoveredPlugin {
  readonly manifest: ComponentManifest
}

const IGNORED = new Set(['node_modules', 'dist'])

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED.has(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    // 根目录不存在是正常状态：hub 目录要等第一次下载才有，bundled 目录也许还没放插件
    return []
  }
}

async function readAt(dir: string, id: string, root: PluginRoot): Promise<DiscoveredPlugin | null> {
  const read = await readManifest(dir)
  if (read.kind === 'missing') return null
  if (read.kind === 'invalid') {
    return { id, dir, root, manifest: null, issues: read.issues }
  }
  return { id, dir, root, manifest: read.manifest, issues: [] }
}

export async function discoverRoot(root: PluginRoot): Promise<DiscoveredPlugin[]> {
  const found: DiscoveredPlugin[] = []
  for (const id of await listDirs(root.dir)) {
    const flat = await readAt(join(root.dir, id), id, root)
    if (flat !== null) {
      found.push(flat)
      continue
    }
    // 平铺布局：`<id>/<version>/manifest.json`
    for (const version of await listDirs(join(root.dir, id))) {
      const nested = await readAt(join(root.dir, id, version), id, root)
      if (nested !== null) found.push(nested)
    }
  }
  return found
}

export async function discoverAll(roots: readonly PluginRoot[]): Promise<DiscoveredPlugin[]> {
  const out: DiscoveredPlugin[] = []
  for (const root of roots) out.push(...(await discoverRoot(root)))
  return out
}

export interface VersionPick {
  /** 选中的那个（null = 没有可用版本，原因见 `found` / `broken`）*/
  readonly picked: UsablePlugin | null
  /** 所有找到的版本，给"版本对不上"的提示用 */
  readonly found: readonly UsablePlugin[]
  /** 找到的候选里，清单本身就坏了的那些 */
  readonly broken: readonly DiscoveredPlugin[]
}

/**
 * 选版本：按根的优先级（hub 先）找，**第一个有满足版本的根胜出**；同一个根里取最高的。
 *
 * 为什么"根优先"而不是"全局最高版本"：Hub 版的唯一目的就是覆盖 bundled 版。
 * 若按最高版本选，一个 bundled 1.3 会把 hub 1.2 盖掉，热更新就永远不生效。
 *
 * 区间不合法时会抛 `UnsupportedRangeError`，调用方先 `isRangeValid` 拦一道。
 */
export async function pickPlugin(
  roots: readonly PluginRoot[],
  id: string,
  range: string,
): Promise<VersionPick> {
  const found: UsablePlugin[] = []
  const broken: DiscoveredPlugin[] = []
  for (const root of roots) {
    const candidates = (await discoverRoot(root)).filter((p) => p.id === id)
    const usable = candidates.filter((p): p is UsablePlugin => p.manifest !== null)
    found.push(...usable)
    broken.push(...candidates.filter((p) => p.manifest === null))
    const best = usable
      .filter((p) => {
        try {
          return satisfiesRange(p.manifest.version, range)
        } catch {
          return false
        }
      })
      .sort((a, b) => compareVersionText(b.manifest.version, a.manifest.version))[0]
    if (best !== undefined) return { picked: best, found, broken }
  }
  return { picked: null, found, broken }
}
