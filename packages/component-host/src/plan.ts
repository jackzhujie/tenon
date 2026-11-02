/**
 * 加载计划：把「装配声明 + 磁盘上的插件 + 宿主版本」算成「这次到底加载谁、按什么顺序」。
 *
 * **这一步不加载任何东西**，只做判断。这样它可以在插件页、安装工具、壳生成器三处共用，
 * 也意味着所有"装不上"的原因在这一层就全部暴露，不必等到运行时报一句看不懂的话。
 *
 * 原则：**一个组件坏，不影响别的组件**。每条装配条目独立解析，失败就落一条 problem，
 * 其余照常加载 —— 反过来（一处坏全盘空）会让用户以为所有组件都被卸载了。
 *
 * 另一个原则：**装不上就明说，不降级**。版本对不上、槽位没声明、宿主太旧，
 * 都不做"尽量加载"。静默降级的表现是"组件在，但点了没反应"，那比装不上更难查。
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AvailableComponent, ComponentMount, ComponentProblem, InstalledComponent } from '@tenon/protocol'
import { ASSEMBLY_FILE, readAssembly, type ComponentAssembly, type ComponentEntry } from './assembly.js'
import type { ComponentManifest } from './manifest.js'
import { COMPONENT_ID_RE } from './manifest.js'
import { discoverAll, pickPlugin, type UsablePlugin } from './resolve.js'
import type { PluginRoot } from './roots.js'
import { findSlot, slotHost } from './slots.js'
import { isRangeValid, meetsMinTenonVersion, satisfiesRange, compareVersionText } from './version.js'

/**
 * problem 的 code 取值 —— **稳定契约**，界面按它决定给什么按钮，改文案可以，改 code 不行。
 *
 * | code | 意思 | 用户该做什么 |
 * |---|---|---|
 * | `assembly-invalid` | 装配声明本身坏了 | 修 JSON（或从 git 回滚） |
 * | `bad-id` / `bad-range` | 声明里的写法不合法 | 改声明 |
 * | `duplicate-entry` | 同一个 id 写了两遍 | 删掉多余的 |
 * | `missing` | 磁盘上没有这个组件 | 更新 Tenon / 在 Hub 下载 |
 * | `version-unsatisfied` | 有，但版本不匹配 | 改区间或更新组件 |
 * | `tenon-too-old` | 组件要求更高的 Tenon | 升级 Tenon |
 * | `invalid-manifest` | 清单字段坏了（含未知权限） | 重装/更新这个组件 |
 * | `id-mismatch` | 目录名与清单 id 不一致 | 修清单或声明 |
 * | `source-mismatch` | 清单说的来源与所在目录不一致 | 修清单（多半是手抄错了） |
 * | `unsigned` | Hub 组件没有签名 | 等签名校验上线（M6）或改回内置版 |
 * | `unknown-slot` / `slot-not-declared` | 挂了不存在的槽位 / 组件不支持 | 改声明 |
 * | `facet-missing` / `facet-file-missing` | 缺对应宿主的实现 / 文件不在 | 重装组件 |
 * | `prefix-on-slot` / `prefix-conflict` | 后端前缀写在了前端槽位上 / 两个组件抢同一前缀 | 改声明 |
 * | `dependency-missing` / `dependency-blocked` / `dependency-cycle` | 依赖没装 / 装不上 / 成环 | 先装依赖 |
 */
export const COMPONENT_PROBLEM_CODES = [
  'assembly-invalid',
  'bad-id',
  'bad-range',
  'duplicate-entry',
  'missing',
  'version-unsatisfied',
  'tenon-too-old',
  'invalid-manifest',
  'id-mismatch',
  'source-mismatch',
  'unsigned',
  'unknown-slot',
  'slot-not-declared',
  'facet-missing',
  'facet-file-missing',
  'prefix-on-slot',
  'prefix-conflict',
  'dependency-missing',
  'dependency-blocked',
  'dependency-cycle',
] as const
export type ComponentProblemCode = (typeof COMPONENT_PROBLEM_CODES)[number]

export interface PlanInput {
  readonly repoDir: string
  /** 解析顺序即优先级：hub 在前 */
  readonly roots: readonly PluginRoot[]
  /** 宿主版本（`health` 里的那个）。`0.0.0` 视为开发构建，见 `meetsMinTenonVersion` */
  readonly tenonVersion: string
}

/**
 * 一个**要被真的加载**的组件：够加载器去磁盘上找文件的信息。
 *
 * 与 `InstalledComponent` 分开，是因为后者是给界面看的（进 RPC、进 JSON），
 * 而 `dir` 是本机路径 —— 界面既用不上，也不该看见。
 */
export interface LoadTarget {
  readonly id: string
  readonly version: string
  /** 插件目录的绝对路径 */
  readonly dir: string
  /** facet 入口（相对 `dir`）；没有的那一侧为 null */
  readonly facets: {
    readonly server: string | null
    readonly web: string | null
    readonly worker: string | null
  }
}

export interface PlanResult {
  /** 装配声明的解析结果。声明坏了是 null —— 此时 `components` 为空、`problems` 有一条 `assembly-invalid` */
  readonly assembly: ComponentAssembly | null
  /** 装配声明里的每一条（按声明顺序），含被关掉的和装不上的。`loaded` 告诉你它到底会不会加载 */
  readonly components: readonly InstalledComponent[]
  /** **加载顺序**（依赖在前）。只含 `loaded` 的那些 */
  readonly loadOrder: readonly string[]
  /** 与 `loadOrder` 一一对应：加载器照着它去 `import()` */
  readonly targets: readonly LoadTarget[]
  readonly problems: readonly ComponentProblem[]
}

interface ResolvedEntry {
  readonly entry: ComponentEntry
  readonly manifest: ComponentManifest
  /** 插件目录（加载时要按它找 facet 文件） */
  readonly dir: string
  readonly component: InstalledComponent
  blocked: boolean
  /** 依赖的组件 id（只记能在装配声明里找到的那些） */
  readonly dependsOn: string[]
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function indexOfComponents(components: readonly { entry: ComponentEntry }[]): Map<string, number> {
  return new Map(components.map((c, index) => [c.entry.id, index]))
}

/** 依赖在前、同层按声明顺序 —— Kahn，队列按声明下标排序，保证结果稳定 */
function topoSort(
  entries: readonly ResolvedEntry[],
): { order: string[]; cycles: string[][] } {
  const index = indexOfComponents(entries)
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const item of entries) {
    indegree.set(item.entry.id, 0)
    dependents.set(item.entry.id, [])
  }
  for (const item of entries) {
    for (const dep of item.dependsOn) {
      if (!indegree.has(dep)) continue
      indegree.set(item.entry.id, (indegree.get(item.entry.id) ?? 0) + 1)
      dependents.get(dep)?.push(item.entry.id)
    }
  }
  const ready = entries
    .filter((item) => (indegree.get(item.entry.id) ?? 0) === 0)
    .sort((a, b) => (index.get(a.entry.id) ?? 0) - (index.get(b.entry.id) ?? 0))
    .map((item) => item.entry.id)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()
    if (id === undefined) break
    order.push(id)
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1
      indegree.set(next, left)
      if (left === 0) {
        ready.push(next)
        ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0))
      }
    }
  }
  const stuck = entries.map((i) => i.entry.id).filter((id) => !order.includes(id))
  // 环里只可能是"剩下的这些"，整组报一次比逐个报好读
  return { order, cycles: stuck.length === 0 ? [] : [stuck] }
}

export async function buildPlan(input: PlanInput): Promise<PlanResult> {
  const problems: ComponentProblem[] = []
  const push = (
    code: ComponentProblemCode,
    componentId: string | null,
    message: string,
    hint: string | null = null,
  ): void => {
    problems.push({ code, componentId, message, hint })
  }

  const read = await readAssembly(input.repoDir)
  if (read.kind === 'invalid') {
    push(
      'assembly-invalid',
      null,
      `${ASSEMBLY_FILE} 读不出来，这次不会加载任何组件`,
      read.issues.join('；'),
    )
    return { assembly: null, components: [], loadOrder: [], targets: [], problems }
  }
  const assembly = read.assembly

  const resolved: ResolvedEntry[] = []
  const seen = new Set<string>()

  for (const entry of assembly.components) {
    const id = entry.id
    if (!COMPONENT_ID_RE.test(id)) {
      push('bad-id', id, `组件 id「${id}」不是合法的反向域名`, 'id 要写成 tenon.official.ai-assistant 这样')
      continue
    }
    if (seen.has(id)) {
      push('duplicate-entry', id, `${id} 在装配声明里出现了不止一次`, '删掉多余的那条（只有第一条生效）')
      continue
    }
    seen.add(id)

    if (!isRangeValid(entry.version)) {
      push(
        'bad-range',
        id,
        `${id} 的版本区间「${entry.version}」不认识`,
        '可用 ^1.2.0 / ~1.2.0 / >=1.0.0 / 1.2.3 / *',
      )
      continue
    }

    const pick = await pickPlugin(input.roots, id, entry.version)
    const plugin: UsablePlugin | null = pick.picked
    if (plugin === null) {
      const broken = pick.broken[0]
      if (broken !== undefined) {
        push('invalid-manifest', id, `${id} 的清单读不出来`, broken.issues.join('；'))
      } else if (pick.found.length === 0) {
        push('missing', id, `磁盘上找不到组件 ${id}`, '它可能没随这个版本发布，或者 Hub 上还没下载')
      } else {
        const found = pick.found.map((p) => `${p.manifest.version}（${p.root.kind}）`).join('、')
        push(
          'version-unsatisfied',
          id,
          `${id} 没有满足「${entry.version}」的版本，找到的是 ${found}`,
          '把 version 改成能匹配的区间，或更新这个组件',
        )
      }
      continue
    }

    const manifest = plugin.manifest
    if (manifest.id !== id) {
      push(
        'id-mismatch',
        id,
        `清单里的 id 是「${manifest.id}」，与装配的「${id}」不一致`,
        `把 ${plugin.dir} 的 manifest.id 改成 ${id}，或修正装配声明`,
      )
      continue
    }
    if (manifest.source !== plugin.root.kind) {
      push(
        'source-mismatch',
        id,
        `${id} 的清单声明 source=${manifest.source}，但它来自 ${plugin.root.kind} 目录`,
        '来源必须与所在目录一致，否则签名校验会被绕过',
      )
      continue
    }
    if (manifest.source === 'hub' && manifest.signature === null) {
      push('unsigned', id, `${id} 来自 Hub 但没有签名`, '签名校验在 M6 落地；在此之前只用内置版')
      continue
    }
    if (!meetsMinTenonVersion(input.tenonVersion, manifest.minTenonVersion)) {
      push(
        'tenon-too-old',
        id,
        `${manifest.name} 要求 Tenon ≥ ${manifest.minTenonVersion}，当前 ${input.tenonVersion}`,
        '升级 Tenon，或换一个兼容的组件版本',
      )
      continue
    }

    let broken = false
    const mounts: ComponentMount[] = []
    for (const spec of entry.mount) {
      const slot = findSlot(spec.slot)
      if (slot === undefined) {
        push('unknown-slot', id, `${manifest.name} 挂在不存在的槽位「${spec.slot}」上`, '见 DESIGN §21.3 的六个插槽')
        broken = true
        continue
      }
      if (!manifest.slots.includes(spec.slot)) {
        push(
          'slot-not-declared',
          id,
          `${manifest.name} 没有声明支持槽位「${spec.slot}」`,
          `它支持：${manifest.slots.join('、') || '（无）'}`,
        )
        broken = true
        continue
      }
      const host = slotHost(spec.slot)
      if (host === null || manifest.facets[host] === undefined) {
        push(
          'facet-missing',
          id,
          `${manifest.name} 没有 ${host ?? '对应'} facet，装不到「${spec.slot}」`,
          '重装这个组件',
        )
        broken = true
        continue
      }
      if (spec.prefix !== undefined && slot.host !== 'server') {
        push('prefix-on-slot', id, `「${spec.slot}」是前端槽位，不该写 prefix`, 'prefix 只用于 app.api')
        broken = true
        continue
      }
      mounts.push({ slot: spec.slot, order: spec.order, prefix: spec.prefix ?? null })
    }

    for (const [host, path] of Object.entries(manifest.facets)) {
      if (path === undefined) continue
      if (!(await fileExists(join(plugin.dir, path)))) {
        push('facet-file-missing', id, `清单说 ${host} facet 在「${path}」，但文件不存在`, '重装这个组件')
        broken = true
      }
    }

    resolved.push({
      entry,
      manifest,
      dir: plugin.dir,
      blocked: broken,
      dependsOn: Object.keys(manifest.dependencies),
      component: {
        id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        source: manifest.source,
        license: entry.license,
        enabled: entry.enabled,
        loaded: false,
        permissions: manifest.permissions,
        pricing: manifest.pricing,
        slots: manifest.slots,
        mounts,
        facets: {
          server: manifest.facets.server ?? null,
          web: manifest.facets.web ?? null,
          worker: manifest.facets.worker ?? null,
        },
        agentHints: manifest.agentHints,
      },
    })
  }

  const byIdMap = new Map(resolved.map((item) => [item.entry.id, item]))

  // 依赖：不存在 / 版本不满足 —— 都按"这条装不上"处理，不降级
  for (const item of resolved) {
    for (const [depId, range] of Object.entries(item.manifest.dependencies)) {
      const dep = byIdMap.get(depId)
      if (dep === undefined) {
        push(
          'dependency-missing',
          item.entry.id,
          `${item.manifest.name} 需要 ${depId}（${range}），但它没在装配声明里`,
          `先装配 ${depId}`,
        )
        item.blocked = true
        continue
      }
      let ok = true
      try {
        ok = satisfiesRange(dep.manifest.version, range)
      } catch {
        ok = false
      }
      if (!ok) {
        push(
          'dependency-missing',
          item.entry.id,
          `${item.manifest.name} 需要 ${depId} ${range}，实际装的是 ${dep.manifest.version}`,
          '调整依赖区间，或换个版本',
        )
        item.blocked = true
      }
    }
  }

  // 环：整组都不加载（加载器拿到半条链只会崩）
  const { order, cycles } = topoSort(resolved)
  for (const cycle of cycles) {
    for (const id of cycle) {
      const item = byIdMap.get(id)
      if (item !== undefined) item.blocked = true
    }
    push(
      'dependency-cycle',
      cycle[0] ?? null,
      `组件依赖成环：${cycle.join(' → ')}`,
      '拆掉其中一条依赖',
    )
  }

  // 前缀冲突：两个组件抢同一个后端前缀，路由会打架
  const byPrefix = new Map<string, string[]>()
  for (const item of resolved) {
    for (const mount of item.component.mounts) {
      if (mount.prefix === null) continue
      const list = byPrefix.get(mount.prefix) ?? []
      list.push(item.entry.id)
      byPrefix.set(mount.prefix, list)
    }
  }
  for (const [prefix, ids] of byPrefix) {
    if (ids.length < 2) continue
    for (const id of ids) {
      const item = byIdMap.get(id)
      if (item !== undefined) item.blocked = true
      push('prefix-conflict', id, `后端前缀「${prefix}」被 ${ids.join('、')} 同时占用`, '改成一个专属前缀')
    }
  }

  // 依赖装不上 → 依赖它的也装不上（跑不动点，链多长都能传到）
  let changed = true
  while (changed) {
    changed = false
    for (const item of resolved) {
      if (item.blocked) continue
      const down = item.dependsOn
        .map((depId) => byIdMap.get(depId))
        .find((dep) => dep !== undefined && dep.blocked)
      if (down === undefined) continue
      item.blocked = true
      changed = true
      push(
        'dependency-blocked',
        item.entry.id,
        `${item.manifest.name} 依赖的 ${down.entry.id} 装不上`,
        '先修好上面那条',
      )
    }
  }

  for (const item of resolved) {
    item.component.loaded = item.entry.enabled && !item.blocked
  }

  // 加载顺序只留真正会加载的，且依赖在前
  const loadOrder = order.filter((id) => byIdMap.get(id)?.component.loaded === true)

  return {
    assembly,
    components: resolved.map((item) => item.component),
    loadOrder,
    targets: loadOrder.map((id) => {
      const item = byIdMap.get(id)
      if (item === undefined) throw new Error(`加载顺序里出现了未知组件 ${id}`)
      return {
        id,
        version: item.component.version,
        dir: item.dir,
        facets: item.component.facets,
      }
    }),
    problems,
  }
}

/**
 * 磁盘上有哪些组件可以装（插件页的"可安装"列表）。
 *
 * 同 id 多个版本时按 `hub > bundled`、同根取最高版本 —— 与 `pickPlugin` 一致，
 * 否则会出现"列表里看到的版本，装上去却是另一个"。
 */
export async function listAvailable(input: {
  readonly roots: readonly PluginRoot[]
  readonly installed: readonly string[]
}): Promise<AvailableComponent[]> {
  const best = new Map<string, AvailableComponent>()
  for (const root of input.roots) {
    const perId = new Map<string, UsablePlugin[]>()
    for (const plugin of await discoverAll([root])) {
      if (plugin.manifest === null) continue
      const list = perId.get(plugin.id) ?? []
      list.push(plugin as UsablePlugin)
      perId.set(plugin.id, list)
    }
    for (const [id, list] of perId) {
      // 已经由更高优先级的根给出了这个组件，就不要再被 bundled 版盖掉
      if (best.has(id)) continue
      const top = list.sort((a, b) => compareVersionText(b.manifest.version, a.manifest.version))[0]
      if (top === undefined) continue
      best.set(id, {
        id,
        name: top.manifest.name,
        description: top.manifest.description,
        version: top.manifest.version,
        source: top.manifest.source,
        pricing: top.manifest.pricing,
        installed: input.installed.includes(id),
      })
    }
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id))
}
