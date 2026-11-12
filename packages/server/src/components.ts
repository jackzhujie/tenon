/**
 * 组件宿主（M5 第 3 步）：按**加载计划**把组件的 server facet 真的挂起来。
 *
 * 分工很清楚：
 * - `@tenon/component-host` 只**判断**（谁该加载、为什么装不上）；
 * - 这里才**动手**（`import()` 插件的 `server.js`、建 chord host、调 `activate`）。
 *
 * 三条原则，都是前面几步踩出来的：
 *
 * 1. **一个组件加载失败，不影响别的组件**。与 `buildPlan` 的逐条判定同一条哲学：
 *    报一条 problem，继续装下一个。
 * 2. **每个应用一个 chord host**。对象按 `(type, input, principal)` 认身份，host 是这台
 *    "机器"的边界 —— 混用一个 host 会让两个应用的对象有被互相取到的可能。
 * 3. **没配模型也要能加载**。组件本身（界面、状态）不依赖模型，只有 `ask` 才需要。
 *    所以没模型时注入一个"一调就抛 AGENT_NO_MODEL"的 brain，而不是让组件装不上 ——
 *    否则插件页会说"装不上"，而真正的原因是没配模型，因果关系完全错位。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHost, type Host } from '@earendil-works/chord'
import {
  buildPlan,
  createComponentStorage,
  type ComponentStorage,
  type PlanResult,
  type PluginRoot,
} from '@tenon/component-host'
import { appPaths, type ComponentStore, type TenonHome } from '@tenon/core'
import { msg, TenonError, type ComponentProblem } from '@tenon/protocol'
import { createAssistant, type AgentRuntime, type AssistantCapability } from '@tenon/agent'

/**
 * 宿主交给组件的模型能力 —— **只给组件它需要的那一个方法**。
 *
 * 类型上刻意比 `AssistantCapability` 窄：组件不该看见 `close()`，那会让人以为它能
 * 决定宿主的会话生命周期。宽类型传窄类型是安全的，反过来不是。
 */
export interface BrainCapability {
  complete(input: { appId: string; text: string }): Promise<string>
}

/**
 * 组件的 principal。V1 一个应用一个身份 —— 收费/授权分流是 Phase 3 的事，
 * 但**判断必须写在 factory 里**（返回哪个 variant），这条 Spike 5 已经钉住了。
 */
export interface Principal {
  readonly appId: string
}

/**
 * server facet 模块必须导出的入口（**组件与宿主之间的 ABI**）。
 *
 * 长这样而不是 `export const facet = …`，是为了让宿主在激活时把**能力**交进去：
 * 模型、日志，以及将来的数据库/文件句柄。组件自己拿不到这些，也就不可能滥用。
 */
export interface FacetActivation {
  readonly host: Host<Principal>
  readonly appId: string
  readonly brain: BrainCapability
  /**
   * 组件自己的键值存储（M6 第 4 步）。
   *
   * **清单里没声明 `db:read` / `db:write` 时这里是 undefined** —— 组件连"试一试"的
   * 机会都没有，于是它必须在类型层面处理这种情况（而不是写个 try/catch 静默降级）。
   *
   * 命名空间由宿主绑定成 `(appId, componentId)`：组件看不见也改不了这个边界。
   */
  readonly storage?: ComponentStorage
  readonly log: (line: string) => void
}

export interface FacetModule {
  activate?: (input: FacetActivation) => void | Promise<void>
}

export interface ActivateOptions {
  readonly appId: string
  readonly repoDir: string
  readonly roots: readonly PluginRoot[]
  readonly tenonVersion: string
  readonly brain: BrainCapability
  /**
   * 按 (组件, 权限) 造存储门面。**由调用方给**，因为"数据库在哪"是 server 的事，
   * 而"要不要给"是清单的事 —— 两件事在宿主这里汇合。
   * 不给 = 所有组件都拿不到 storage（纯 RPC 测试不需要数据库）。
   */
  readonly storage?: (componentId: string, permissions: readonly string[]) => ComponentStorage | undefined
  readonly log?: (line: string) => void
}

export interface ActivatedComponents {
  readonly appId: string
  readonly plan: PlanResult
  readonly host: Host<Principal>
  /** 真的挂起来的组件 id（顺序即加载顺序） */
  readonly loaded: readonly string[]
  /**
   * 装载期的问题（`import()` 失败、模块没导出 `activate`、插件编译不兼容……）。
   *
   * 与 `plan.problems` 分开：那些是"判断阶段就知道装不上"，这些是"以为能装、装的时候炸了"。
   * 两者都要能让界面看见，但修法不同。
   */
  readonly problems: readonly ComponentProblem[]
}

function problem(componentId: string | null, message: string, hint: string): ComponentProblem {
  return { code: 'load-failed', componentId, message, hint }
}

/** 走文件 URL 而不是路径：Windows 上 `import('C:\\…')` 会直接报协议错 */
function moduleUrl(file: string): string {
  return pathToFileURL(file).href
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 加载一个应用的组件。**不抛异常**：装不上的都变成 `problems` 里的一条。
 *
 * 连"建 host"都不抛，是因为预览要能起来。带着一个坏组件启动，用户至少看得见界面和
 * 那条错误；直接抛出去的表现是"这个应用打不开了"，什么问题都看不出来。
 */
export async function activateComponents(options: ActivateOptions): Promise<ActivatedComponents> {
  const log = options.log ?? ((line: string): void => void process.stderr.write(`${line}\n`))
  const plan = await buildPlan({
    repoDir: options.repoDir,
    roots: options.roots,
    tenonVersion: options.tenonVersion,
  })

  /*
   * ★ 名字必须与契约里的 `hostNamed('server')` 一致，否则 `serve` 当场抛
   * 「declared for server, but <别的名字> serves it」（Spike 5 撞过同一类约束）。
   * 它不是"这个 host 的标识"，而是**路由名**：一个进程里多个应用的 host 都叫 server，
   * 彼此靠链路区分，不靠名字。
   */
  const host = createHost<Principal>({
    name: 'server',
    self: { appId: options.appId },
    principalKey: (principal) => principal.appId,
    // dev 打开 schema 校验：宁可早点炸，也不要让一个写错的 state 静默上线
    dev: true,
    onError: (error) => {
      log(`[components] ${options.appId} background task failed: ${describe(error)}`)
    },
  })

  const loaded: string[] = []
  const problems: ComponentProblem[] = []

  for (const target of plan.targets) {
    const facet = target.facets.server
    if (facet === null) continue // 纯前端组件：没有服务端半边，不需要激活
    try {
      const module = (await import(moduleUrl(join(target.dir, facet)))) as FacetModule
      if (typeof module.activate !== 'function') {
        problems.push(
          problem(
            target.id,
            msg('error.component.noActivate', { id: target.id }),
            msg('error.component.incompatibleHint'),
          ),
        )
        continue
      }
      const storage = options.storage?.(target.id, target.permissions)
      await module.activate({
        host,
        appId: options.appId,
        brain: options.brain,
        // 没权限时**不传这个字段**，而不是传 undefined：组件拿到的是"没有这个属性"
        ...(storage === undefined ? {} : { storage }),
        log,
      })
      loaded.push(target.id)
    } catch (error) {
      const message = describe(error)
      log(`[components] ${options.appId} failed to load ${target.id}: ${message}`)
      problems.push(
        problem(
          target.id,
          msg('error.component.loadFailed', { id: target.id, detail: message }),
          msg('error.component.loadFailedHint'),
        ),
      )
    }
  }

  return { appId: options.appId, plan, host, loaded, problems }
}

export interface ComponentRuntimeOptions {
  readonly home: TenonHome
  readonly agent: AgentRuntime
  readonly roots: readonly PluginRoot[]
  readonly tenonVersion: string
  /** 组件的键值存储。不给 = 组件拿不到 storage（纯逻辑测试用） */
  readonly store?: ComponentStore
  readonly log?: (line: string) => void
}

/**
 * 每个应用一份激活结果，懒加载、幂等。
 *
 * 为什么要缓存：预览会反复起停（改配置、切库、崩溃重启）。每起一次就 `import()` 一遍插件、
 * 建一个 host，等于把同一个组件的对象重建 N 次 —— 状态全丢，而那正是 Spike 5 第 4 条
 * 警告的"静默归零"。激活跟着**应用**走，不跟着预览走。
 */
export class ComponentRuntime {
  private readonly apps = new Map<string, Promise<ActivatedComponents>>()
  private readonly brain: AssistantCapability

  constructor(private readonly options: ComponentRuntimeOptions) {
    const { agent } = options
    this.brain =
      agent.pool === undefined || agent.model === undefined
        ? {
            complete: async () => {
              throw new TenonError(
                'AGENT_NO_MODEL',
                msg('error.model.noneConfigured'),
              )
            },
            close: () => {},
          }
        : // createAssistant 本身是懒的：真正开会话发生在第一次 ask
          createAssistant({ pool: agent.pool, model: agent.model, home: options.home })
  }

  /**
   * 组件能不能持久化。
   *
   * 单独暴露出来，是因为"没给 store"时的表现**完全静默**：组件照常加载、照常工作，
   * 只是数据一重启就没（审批流会退化成内存版）。这种"少传一个参数就悄悄降级"的错
   * 光看日志发现不了 —— 而它恰好是最容易在重构里丢掉的一行。
   */
  get storageReady(): boolean {
    return this.options.store !== undefined
  }

  /** 幂等：同一个应用只激活一次 */
  async ensure(appId: string): Promise<ActivatedComponents> {
    const existing = this.apps.get(appId)
    if (existing !== undefined) return existing
    const activating = activateComponents({
      appId,
      repoDir: appPaths(this.options.home, appId).repoDir,
      roots: this.options.roots,
      tenonVersion: this.options.tenonVersion,
      brain: this.brain,
      /*
       * 命名空间在这里绑定：组件 id 从加载计划来，appId 从这次激活来。
       * 组件拿到的 storage 上没有 appId / componentId 可用 —— 边界在闭包里。
       */
      storage: (componentId, permissions) => {
        const store = this.options.store
        if (store === undefined) return undefined
        return createComponentStorage({
          backend: {
            read: (key) => store.get(appId, componentId, key),
            write: (key, value) => store.set(appId, componentId, key, value),
            remove: (key) => store.delete(appId, componentId, key),
            keys: (prefix) => store.keys(appId, componentId, prefix),
          },
          permissions,
          componentId,
        })
      },
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    })
    this.apps.set(appId, activating)
    try {
      return await activating
    } catch (error) {
      // 激活失败不要留下"永远失败"的缓存：修好组件之后要能重试
      this.apps.delete(appId)
      throw error
    }
  }

  /**
   * 装配声明变了（装/卸组件）之后重新激活。
   *
   * 必须把旧 host 关掉：它的对象还在内存里，继续用会让"装完了但界面还是老样子"。
   * 关掉之后重新 ensure —— 新声明、新 facet，用户下一次请求就是新的了。
   */
  async reload(appId: string): Promise<ActivatedComponents> {
    const existing = this.apps.get(appId)
    this.apps.delete(appId)
    if (existing !== undefined) {
      try {
        const activated = await existing
        await activated.host.close()
      } catch {
        // 旧的那份本来就坏了：关不掉不该阻止新的装上去
      }
    }
    return this.ensure(appId)
  }

  /** 已经激活过就返回；没有就 undefined（传输层接链路时用） */
  find(appId: string): Promise<ActivatedComponents> | undefined {
    return this.apps.get(appId)
  }

  async close(): Promise<void> {
    const all = [...this.apps.values()]
    this.apps.clear()
    this.brain.close()
    for (const pending of all) {
      try {
        const activated = await pending
        await activated.host.close()
      } catch {
        // 关不干净的 host 不该阻止进程退出
      }
    }
  }
}
