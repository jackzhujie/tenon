/**
 * 每应用一个 harness（DESIGN §4.3）。
 *
 * 三个必须记住的点：
 * 1. **`resume()` 每个进程启动必须调**。少了它，崩溃中断的任务永远不会继续（SPIKES §2）。
 * 2. 一个 storage 只能被一个进程独占，所以同应用重复 acquire 必须复用同一个会话。
 * 3. 模型/目录/工具集变了（用户改了设置、我们升级了工具层）要 `configure` 到根会话上，
 *    否则已有会话仍用旧的 —— 但只在真的变了才写，避免每次启动都产生一次无意义的 commit。
 */
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { TenonHome } from '@tenon/core'
import { appPaths } from '@tenon/core'
import type { HubConfig, PluginRoot } from '@tenon/component-host'
import type { ModelChoice, ResolvedModel } from './models.js'
import { codingExtension } from './tools/coding.js'
import { codeactExtension } from './tools/codeact.js'
import { previewExtension, type PageDriverProvider } from './tools/preview.js'
import { reviewExtension } from './tools/review.js'
import { componentsExtension } from './tools/components.js'
import { subagentExtension } from './tools/subagent.js'

const ctx = BACKGROUND_CONTEXT

export type RootConversation = Awaited<ReturnType<Harness['root']>>

export interface HarnessSession {
  readonly appId: string
  readonly harness: Harness
  readonly root: RootConversation
  readonly conversationId: RootConversation['id']
  /**
   * registry 里**全部**可用的工具（含只给子角色的）。
   *
   * 注意它与"主角色实际拿到的"不是一回事：`preview_*` / `git_diff` / `typecheck` / `codemode`
   * 只进 registry、不进根会话的配置，主角色要靠 `subagent` 派给 e2e / reviewer / codeact 角色
   * 才用得到（见 `open()` 里的 rootTools）。
   */
  readonly tools: readonly ToolRegistration[]
  /** 主角色实际拿到的工具（`configure` 时选中的那一份，是 `tools` 的子集） */
  readonly rootTools: readonly ToolRegistration[]
  close(): Promise<void>
}

export interface HarnessPoolOptions {
  home: TenonHome
  model: ResolvedModel
  /**
   * 组件工具（M5 第 4 步）：roots 决定"能装什么"，onChanged 让装完立刻生效。
   * 不给就没有装组件的工具 —— 一些测试（只验文件读写）不需要它。
   */
  components?: {
    readonly roots: readonly PluginRoot[]
    readonly tenonVersion: string
    readonly onChanged?: (appId: string) => void | Promise<void>
    /**
     * Hub（M6 第 3 步）。给了它，`install_component` 才能装"本机还没有"的组件 ——
     * 也就是"跟 Agent 说一句就装上了"，而不是"请你去插件页点一下"。
     * 未配置时是 `{config: null}`：退化成只装本机，不报错。
     */
    readonly hub?: { readonly config: HubConfig | null; readonly dir: string } | undefined
  }
  /**
   * 页面通道的提供者（M4 第 4 步）：由 server 接到 `PreviewManager.pages`。
   *
   * 不给也能跑 —— 那样 e2e 角色会说"预览没起"，其余角色完全不受影响，
   * 单测与纯文件场景不必为了装这个扩展而拉起网关。
   */
  getPageDriver?: PageDriverProvider
}

/** 工具集比对只看名字：对象每次启动都是新的，比引用永远"漂移" */
function sameTools(
  actual: readonly { name: string }[],
  expected: readonly { name: string }[],
): boolean {
  const key = (tools: readonly { name: string }[]): string =>
    tools
      .map((tool) => tool.name)
      .sort()
      .join(',')
  return key(actual) === key(expected)
}

export class HarnessPool {
  private readonly sessions = new Map<string, Promise<HarnessSession>>()

  constructor(private readonly options: HarnessPoolOptions) {}

  get modelChoice(): ModelChoice {
    return this.options.model.choice
  }

  async acquire(appId: string): Promise<HarnessSession> {
    const existing = this.sessions.get(appId)
    if (existing !== undefined) return existing
    const opening = this.open(appId)
    this.sessions.set(appId, opening)
    try {
      return await opening
    } catch (err) {
      // 打开失败不要留下"永远失败"的缓存
      this.sessions.delete(appId)
      throw err
    }
  }

  private async open(appId: string): Promise<HarnessSession> {
    const paths = appPaths(this.options.home, appId)
    await mkdir(paths.tenonDir, { recursive: true })
    await mkdir(paths.runtimeDir, { recursive: true })

    const storage = await openNodeSqliteStorage(paths.harnessDb, { prefix: 'pi_' })

    // 工具挂在扩展上：装进 registry 之后，会话才能用名字选中它们
    const coding = codingExtension(paths.repoDir)
    /*
     * 预览工具（M4 第 4 步）：**只装进 registry，不给主角色**。
     * 主角色有 `bash`，把它能做的事已经很多了；给它 `preview_*` 只会让它绕过"改代码"
     * 去做"点页面"。要验页面，它该派活给 e2e 角色 —— 这个分工才让 e2e 有用。
     */
    const preview = previewExtension({
      appId,
      getDriver: (id) => this.options.getPageDriver?.(id),
    })
    /*
     * 评审工具（M4 第 5 步）：同样只给子角色。`git_diff` / `typecheck` 对主角色不是必需的，
     * 而“自己改的自己审”本来就不是一道关 —— 要审就派活给 reviewer，让它拿证据说话。
     */
    const review = reviewExtension({ repoDir: paths.repoDir })
    /*
     * 脚本沙箱（M4 第 6 步）：同样只给子角色。CodeAct 手上的 `codemode` 是「一次调用换十个」，
     * 但主角色自己直接读文件比写脚本更直接 —— 它的价值在**批量**，那正是该派活的场合。
     * 沙箱建在这里（每应用一个），`close()` 时真关：worker 线程不关会拽住进程退出。
     */
    const codeact = codeactExtension()
    /*
     * 组件工具（M5 第 4 步）：只给主角色。子角色是只读调查的，让 reviewer 或 explore
     * 去"装一个组件"会把分工彻底搞乱 —— 装组件是设计决策，属于 Builder。
     */
    const components = this.options.components === undefined
      ? undefined
      : componentsExtension({
          appId,
          repoDir: paths.repoDir,
          roots: this.options.components.roots,
          tenonVersion: this.options.components.tenonVersion,
          ...(this.options.components.onChanged === undefined
            ? {}
            : { onChanged: this.options.components.onChanged }),
          ...(this.options.components.hub === undefined
            ? {}
            : { hub: this.options.components.hub }),
        })
    // `subagent` 需要 Harness（子会话的模型/工具只能在创建那一刻定），而扩展必须在
    // `Harness.open` 之前建好 —— 所以给一个懒读取器，调用发生时它一定已经有值。
    let harnessRef: Harness | undefined
    // registry 全量：子角色按白名单从这里面挑
    const tools: ToolRegistration[] = [
      ...(coding.tools ?? []),
      ...(preview.tools ?? []),
      ...(review.tools ?? []),
      ...codeact.tools,
    ]
    const subagent = subagentExtension({
      getHarness: () => harnessRef,
      getTools: () => tools,
      // 子会话默认继承父会话的扩展；CodeAct 还要额外一个（它的工具在那个扩展里）
      getExtensions: () => [codeact.extension],
    })
    if (components !== undefined) tools.push(...(components.tools ?? []))
    tools.push(...(subagent.tools ?? []))
    /*
     * 主角色拿到的工具：显式列举，**不用过滤**。
     * 过滤的写法（"凡是名字不以 preview_ 开头"）会让下一个新工具默认落到主角色手里，
     * 而这里的默认应该是"不给"。与 `roles.ts` 的白名单是同一个思路。
     */
    const rootTools: ToolRegistration[] = [
      ...(coding.tools ?? []),
      ...(subagent.tools ?? []),
      ...(components?.tools ?? []),
    ]
    /*
     * 扩展列表 = "这个应用的工具与提示词世界"。`preview` / `review` / `codeact` 必须在这里 ——
     * 只 `registry.install` 是不够的：**工具要靠扩展才能被会话解析到**，
     * 否则子会话里那些调用会直接"工具不存在"，而模型会若无其事地继续往下说
     * （实测症状：e2e 说"页面上找不到"，但页面通道一次都没被调用过）。
     * 这三个扩展都没有 section 会漏到主角色身上 —— `codeact` 那个**有** section（工具声明），
     * 所以它只进子会话（`role.extensions`），**不进 rootTools / root extensions**。
     */
    const extensions: Extension[] = [
      coding,
      subagent,
      preview,
      review,
      ...(components === undefined ? [] : [components]),
    ]

    const registry = createRegistry()
    registry.install(coding)
    registry.install(preview)
    registry.install(review)
    registry.install(codeact.extension)
    registry.install(subagent)
    if (components !== undefined) registry.install(components)

    const harness = await Harness.open(
      storage,
      { models: this.options.model.models, registry },
      ctx,
    )
    harnessRef = harness

    // ★ 崩溃恢复的唯一开关
    const resumed: unknown = harness.resume()
    if (resumed instanceof Promise) {
      resumed.catch((err: unknown) => {
        console.error(`[tenon] ${appId} resume() 失败：`, err)
      })
    }

    const choice = this.options.model.choice
    const wanted = {
      model: { provider: choice.provider, modelId: choice.modelId },
      // 扩展与工具都显式选定：不依赖宿主默认，避免"升级后老应用拿不到新工具"
      extensions,
      tools: rootTools,
      cwd: paths.repoDir,
    }
    const root = await harness.root(ctx, { agent: wanted })

    // 已有会话：只在真的漂移时写配置（同一会话历史保留）
    const agent = await root.agent(ctx)
    const currentModel = agent.model
    const modelDrifted =
      currentModel === undefined ||
      currentModel.modelId !== choice.modelId ||
      currentModel.provider !== choice.provider
    const toolsDrifted = !sameTools(agent.tools, rootTools)
    const extensionDrifted = extensions.some(
      (item) => !agent.extensions.some((current) => current.name === item.name),
    )
    if (modelDrifted || toolsDrifted || extensionDrifted || agent.cwd !== paths.repoDir) {
      await root.configure(wanted, ctx)
    }

    let closed = false
    return {
      appId,
      harness,
      root,
      tools,
      rootTools,
      conversationId: root.id,
      async close() {
        if (closed) return
        closed = true
        // 先关沙箱再关 harness：正在跑的脚本会拿 `api.executeTool()` 回调进 harness
        await codeact.close()
        await harness.close(ctx)
      },
    }
  }

  async release(appId: string): Promise<void> {
    const session = this.sessions.get(appId)
    if (session === undefined) return
    this.sessions.delete(appId)
    await (await session).close()
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(all.map(async (session) => (await session).close()))
  }

  /** 诊断用：当前打开了哪些应用的 harness */
  openApps(): string[] {
    return [...this.sessions.keys()]
  }
}

export function harnessDbPath(home: TenonHome, appId: string): string {
  return join(appPaths(home, appId).tenonDir, 'harness.sqlite')
}
