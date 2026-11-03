/**
 * 装组件（M5 第 4 步）—— `install_component` 工具的全部逻辑都在这里。
 *
 * 放在 `component-host` 而不是 agent 里，有两个理由：
 * 1. 它是**纯业务**（读清单 → 试算 → 写声明 → 同步 AGENTS.md），不需要 pi 的工具运行环境；
 * 2. 这样它能被直接单测，而工具那一层只剩下"把参数搬进来、把结论翻译成一段话"。
 *
 * 顺序是刻意这样排的：**先试算，通过了才落盘**。
 * 反过来（先写再验、错了回滚）在并发下会留下半装状态，而且回滚本身也会失败。
 */
import type { ComponentProblem, InstalledComponent } from '@tenon/protocol'
import { syncAgentsDoc, type AgentsDocSync } from './agents-doc.js'
import {
  assemblyFile,
  readAssembly,
  removeComponent,
  upsertComponent,
  writeAssembly,
  type ComponentAssembly,
  type ComponentEntry,
  type ComponentMountSpec,
} from './assembly.js'
import { findSlot } from './slots.js'
import { buildPlan, type PlanInput } from './plan.js'
import { pickPlugin, type UsablePlugin } from './resolve.js'
import type { PluginRoot } from './roots.js'

export interface InstallRequest {
  readonly repoDir: string
  readonly roots: readonly PluginRoot[]
  readonly tenonVersion: string
  readonly id: string
  /** 不传就用清单声明的第一个插槽（"装上就能看见"的默认） */
  readonly mounts?: readonly ComponentMountSpec[]
  /** 版本区间；不传 = `*`（取当前可用的最高版本） */
  readonly version?: string
}

export type InstallResult =
  | {
      readonly ok: true
      readonly component: InstalledComponent
      /** 磁盘上的装配声明（相对仓库） */
      readonly assemblyFile: string
      readonly agentsDoc: AgentsDocSync
      /** 装之前就已经在了（工具是幂等的） */
      readonly alreadyInstalled: boolean
      /** 装上了，但有些事该告诉用户（权限、依赖） */
      readonly notes: readonly string[]
    }
  | { readonly ok: false; readonly problems: readonly ComponentProblem[] }

/** 默认挂载点：清单里声明的第一个插槽；`app.api` 顺手给一个前缀 */
function defaultMounts(plugin: UsablePlugin): ComponentMountSpec[] {
  const slot = plugin.manifest.slots[0]
  if (slot === undefined) return []
  const spec = findSlot(slot)
  if (spec === undefined) return []
  if (spec.host === 'server') {
    const short = plugin.id.split('.').pop() ?? 'component'
    return [{ slot, order: 100, prefix: `/_c/${short}` }]
  }
  return [{ slot, order: 100 }]
}

function problem(
  code: string,
  componentId: string | null,
  message: string,
  hint: string | null = null,
): ComponentProblem {
  return { code, componentId, message, hint }
}

function fail(...problems: ComponentProblem[]): InstallResult {
  return { ok: false, problems }
}

/**
 * 装一个组件。
 *
 * 幂等：已经装过（同 id）时**整条替换** —— 换版本、换挂载点都走这条路，
 * 所以工具可以被 Agent 反复调用而不会长出两条声明。
 */
export async function installComponent(request: InstallRequest): Promise<InstallResult> {
  const pick = await pickPlugin(request.roots, request.id, request.version ?? '*')
  const plugin = pick.picked
  if (plugin === null) {
    if (pick.broken.length > 0) {
      return fail(
        problem(
          'invalid-manifest',
          request.id,
          `${request.id} 的清单读不出来`,
          pick.broken[0]?.issues.join('；') ?? null,
        ),
      )
    }
    if (pick.found.length === 0) {
      return fail(
        problem(
          'missing',
          request.id,
          `找不到组件 ${request.id}`,
          '它可能没随这个版本发布；用 component.list 看有哪些可装',
        ),
      )
    }
    const found = pick.found.map((item) => `${item.manifest.version}（${item.root.kind}）`).join('、')
    return fail(
      problem(
        'version-unsatisfied',
        request.id,
        `${request.id} 没有满足「${request.version ?? '*'}」的版本，找到的是 ${found}`,
        '换一个版本区间，或更新组件',
      ),
    )
  }

  const read = await readAssembly(request.repoDir)
  if (read.kind === 'invalid') {
    return fail(
      problem(
        'assembly-invalid',
        null,
        `${assemblyFile(request.repoDir)} 读不出来，先修它再装组件`,
        read.issues.join('；'),
      ),
    )
  }

  const alreadyInstalled = read.assembly.components.some((item) => item.id === request.id)
  const entry: ComponentEntry = {
    id: request.id,
    version: request.version ?? `^${plugin.manifest.version}`,
    license: plugin.manifest.pricing.type === 'paid' ? plugin.manifest.pricing.sku : 'free',
    enabled: true,
    mount: [...(request.mounts ?? defaultMounts(plugin))],
  }
  const prospective: ComponentAssembly = upsertComponent(read.assembly, entry)

  // ① 试算：跟真的加载走同一套规则，不另写一份校验（否则必然漂移）
  const plan = await buildPlan({
    repoDir: request.repoDir,
    roots: request.roots,
    tenonVersion: request.tenonVersion,
    assemblyOverride: prospective,
  })
  const planned = plan.components.find((component) => component.id === request.id)
  const own = plan.problems.filter((item) => item.componentId === request.id)
  if (planned === undefined || !planned.loaded) {
    return fail(
      ...(own.length > 0
        ? own
        : [problem('missing', request.id, `${request.id} 试算没通过，但没给出原因（这是个 bug）`)]),
    )
  }

  // ② 落盘：装配声明 + AGENTS.md
  await writeAssembly(request.repoDir, prospective)
  const agentsDoc = await syncAgentsDoc(request.repoDir, plan.components)

  const notes: string[] = []
  if (entry.mount.length === 0) {
    notes.push('这个组件没有挂载点（只有服务端能力），界面上不会出现任何东西')
  }
  if (plugin.manifest.permissions.length > 0) {
    notes.push(`它声明的权限：${plugin.manifest.permissions.join('、')}`)
  }
  if (alreadyInstalled) notes.push('之前就装过，这次按新的参数整条替换')

  return {
    ok: true,
    component: planned,
    assemblyFile: assemblyFile(request.repoDir),
    agentsDoc,
    alreadyInstalled,
    notes,
  }
}

export interface UninstallRequest {
  readonly repoDir: string
  readonly roots: readonly PluginRoot[]
  readonly tenonVersion: string
  readonly id: string
}

export interface UninstallResult {
  readonly removed: boolean
  readonly agentsDoc: AgentsDocSync
  readonly remaining: readonly InstalledComponent[]
}

/**
 * 卸组件（第 5 步的"卸载即清理"从这里开始用）。
 *
 * 只删装配声明 + 重写 AGENTS.md：组件本体是随包发布的只读内容，不该动；
 * 而"应用里还有没有它"的唯一事实就是那份声明。**幂等**：没装过也返回成功。
 */
export async function uninstallComponent(request: UninstallRequest): Promise<UninstallResult> {
  const read = await readAssembly(request.repoDir)
  if (read.kind === 'invalid') {
    throw new Error(`${assemblyFile(request.repoDir)} 读不出来：${read.issues.join('；')}`)
  }
  const next = removeComponent(read.assembly, request.id)
  const removed = next.components.length !== read.assembly.components.length
  if (removed) await writeAssembly(request.repoDir, next)

  const plan: PlanInput = { repoDir: request.repoDir, roots: request.roots, tenonVersion: request.tenonVersion }
  const planned = await buildPlan(plan)
  const agentsDoc = await syncAgentsDoc(request.repoDir, planned.components)
  return { removed, agentsDoc, remaining: planned.components }
}
