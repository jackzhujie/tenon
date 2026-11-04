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
import { installFromHubIndex, type HubConfig } from './hub.js'
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

  /*
   * 付费门禁（M6 第 3 步）。
   *
   * 这里是**唯一**的安装入口（Agent 的 install_component 与插件页的「装到此应用」
   * 都走它），所以一道门就够，不需要在两处各写一遍 —— 那种"两个入口一个忘加"的漏洞
   * 是最常见的付费绕过方式。
   *
   * 为什么是"装不了"而不是"装了但跑不起来"：我们还没有购买流程，所以"装上了"只会
   * 让用户以为能用了。宁可现在直说"付费组件暂未开放"。
   *
   * 为什么不做成 DRM：组件的文件是明文落盘的（esbuild 产物），谁拿到目录都能读。
   * 在"加载"那一层再拦只是把可读的代码当成加密的，属于自我安慰。所以门禁只放在
   * 安装这一步，并且**明说这一点**，免得后来有人以为这里有防护。
   */
  if (plugin.manifest.pricing.type === 'paid') {
    return fail(
      problem(
        'paid-not-available',
        request.id,
        `${request.id} 是付费组件（${plugin.manifest.pricing.sku}），现在还不能装`,
        '付费与购买流程还没做。等它上线之后这里会有「购买」按钮',
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
    // 上面的付费门禁已经把 paid 挡掉了，所以走到这里必然是 free —— 类型检查也这么认为
    license: 'free',
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

export interface SetEnabledRequest {
  readonly repoDir: string
  readonly roots: readonly PluginRoot[]
  readonly tenonVersion: string
  readonly id: string
  readonly enabled: boolean
}

export interface SetEnabledResult {
  readonly components: readonly InstalledComponent[]
  /** 声明里没有这个 id（没装过）时为 false */
  readonly found: boolean
}

/** 插件页的开关：只改 `enabled`，声明与挂载点都保留 */
export async function setComponentEnabled(request: SetEnabledRequest): Promise<SetEnabledResult> {
  const read = await readAssembly(request.repoDir)
  if (read.kind === 'invalid') {
    throw new Error(`${assemblyFile(request.repoDir)} 读不出来：${read.issues.join('；')}`)
  }
  const entry = read.assembly.components.find((item) => item.id === request.id)
  if (entry === undefined) {
    const planned = await buildPlan({
      repoDir: request.repoDir,
      roots: request.roots,
      tenonVersion: request.tenonVersion,
    })
    return { components: planned.components, found: false }
  }
  const next = upsertComponent(read.assembly, { ...entry, enabled: request.enabled })
  await writeAssembly(request.repoDir, next)
  const planned = await buildPlan({
    repoDir: request.repoDir,
    roots: request.roots,
    tenonVersion: request.tenonVersion,
  })
  await syncAgentsDoc(request.repoDir, planned.components)
  return { components: planned.components, found: true }
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
  const plan: PlanInput = { repoDir: request.repoDir, roots: request.roots, tenonVersion: request.tenonVersion }
  if (!removed) {
    /*
     * 什么都没删就别动磁盘：卸一个从来没装过的组件，不该凭空造出一份 AGENTS.md
     * （那会让"这个项目装过组件"变成一句假话）。
     */
    const planned = await buildPlan(plan)
    return { removed: false, agentsDoc: { file: '', changed: false }, remaining: planned.components }
  }
  await writeAssembly(request.repoDir, next)
  const planned = await buildPlan(plan)
  const agentsDoc = await syncAgentsDoc(request.repoDir, planned.components)
  return { removed: true, agentsDoc, remaining: planned.components }
}

/**
 * 装组件，**本机没有就先去 Hub 拿**。
 *
 * 两个入口（Agent 的 `install_component` 与插件页的「装到此应用」）都走这里：
 * 各写一份的话，一边改了另一边忘，表现是"商店能装、Agent 装不了"（或反过来），
 * 而用户看到的只是"装不上"。
 *
 * 三条判断刻意分开报：
 * - **下载失败**（网络 / 验签 / Hub 上没有）→ `downloadError`，调用方该按这种情况说话；
 * - **装失败**（版本区间、槽位、付费门禁）→ `result.ok === false` 的 problems；
 * - 两者都有时以**下载失败**为先 —— 那是更根本的一层，装的问题在这种情况下没机会发生。
 */
export interface InstallWithHubRequest extends InstallRequest {
  /**
   * Hub。\`config\` 为 null（未配置）时退化成"只装本机"，与不传完全一样 ——
   * 因为官方 Hub 上线前就是这个状态，不该因此报错。
   */
  readonly hub?: { readonly config: HubConfig | null; readonly dir: string } | undefined
}

export interface InstallWithHubResult {
  readonly result: InstallResult
  /** 这个包是这一次从 Hub 下的吗 */
  readonly downloaded: boolean
  /** 下载失败的原因（没下载、或下载成功时为 null） */
  readonly downloadError: { readonly code: 'HUB_BAD_BUNDLE' | 'HUB_BAD_SIGNATURE'; readonly message: string; readonly hint: string | null } | null
}

export async function installComponentWithHub(
  request: InstallWithHubRequest,
): Promise<InstallWithHubResult> {
  const first = await installComponent(request)
  const missing = !first.ok && first.problems.some((item) => item.code === 'missing')
  if (!missing || request.hub?.config == null) {
    return { result: first, downloaded: false, downloadError: null }
  }

  /*
   * 只对 `missing` 重试。\`version-unsatisfied\` 时下载也没用（区间已经不接受了），
   * 白等一次网络只会让"装不上"变得更慢。
   */
  const fetched = await installFromHubIndex({
    hubDir: request.hub.dir,
    config: request.hub.config,
    id: request.id,
    ...(request.version === undefined ? {} : { version: exactVersion(request.version) }),
  })
  if (!fetched.ok) {
    return {
      result: first,
      downloaded: false,
      downloadError: {
        code: fetched.problem.code === 'bad-signature' ? 'HUB_BAD_SIGNATURE' : 'HUB_BAD_BUNDLE',
        message: fetched.problem.message,
        hint: fetched.problem.hint,
      },
    }
  }
  return { result: await installComponent(request), downloaded: true, downloadError: null }
}

/**
 * 装配声明里的 `version` 是**区间**（`^1.0.0`），而 Hub 的索引里只有精确版本。
 *
 * 所以这里只在"看起来就是个精确版本"时才把它当版本传给索引；区间一律交给
 * `installComponent` 自己的区间判断（下载最新的，装的时候再按区间挑）。
 * 硬把 `^1.0.0` 当成版本号去索引里找，只会得到"Hub 上没有 ^1.0.0"这种莫名其妙的错。
 */
function exactVersion(value: string): string | undefined {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim()) ? value.trim() : undefined
}
