/**
 * `@tenon/agent` —— pi 生态的唯一入口。
 *
 * 依赖方向（DESIGN §3.2）：`server → agent`。上层只见 `AgentRuntime`，
 * 不直接 import pi：上游一次 minor 升级只在这里修（铁律 3 的落地方式）。
 */
import type { CoreServices } from '@tenon/core'
import type { ChatServiceOptions } from './chat.js'
import { ChatService } from './chat.js'
import { HarnessPool, type HarnessPoolOptions } from './harness-pool.js'
import { planModel, resolveModel, type ModelPlan, type ResolvedModel } from './models.js'
import { TaskGraphService } from './taskgraph.js'
import type { PageDriverProvider } from './tools/preview.js'
import { UsageService } from './usage.js'
import type { SseEventInput } from '@tenon/protocol'

export * from './context.js'
export * from './models.js'
export * from './assistant.js'
export * from './harness-pool.js'
export * from './normalize.js'
export * from './docs.js'
export * from './checks.js'
export * from './roles.js'
export * from './taskgraph.js'
export * from './usage.js'
export * from './tools/coding.js'
export * from './tools/search.js'
export * from './tools/subagent.js'
export * from './tools/components.js'
export * from './tools/preview.js'
export * from './tools/review.js'
export * from './tools/codeact.js'
export { ChatService } from './chat.js'

export interface AgentRuntimeOptions {
  core: CoreServices
  publish: (event: SseEventInput) => void
  env?: NodeJS.ProcessEnv
  /**
   * 一轮提交动了 schema 时的回调，由 server 接到 `PreviewManager.snapshotDatabase`。
   * 在这里只是一个可选项 —— 缺省时 agent 照常工作，只是没有可回滚的数据库快照。
   */
  onSchemaCommit?: ChatServiceOptions['onSchemaCommit']
  /**
   * 页面通道的提供者（M4 第 4 步）：由 server 接到 `PreviewManager.pages`。
   * 不给的话 e2e 角色会明确回"预览没起"，其它角色不受影响。
   */
  getPageDriver?: PageDriverProvider
  /** 组件工具（M5 第 4 步）：不给就没有 install_component */
  components?: HarnessPoolOptions['components']
}

export interface AgentRuntime {
  /** 已配好模型；没配时 `undefined`（server 仍能起来，UI 去引导配置） */
  readonly model: ResolvedModel | undefined
  readonly plan: ModelPlan | undefined
  readonly chat: ChatService | undefined
  readonly pool: HarnessPool | undefined
  /** 任务图（M4）。没配模型时同样是 `undefined` —— 没有 harness 就没有图 */
  readonly taskGraph: TaskGraphService | undefined
  /** 用量与预算（M4）。没配模型时是 `undefined` */
  readonly usage: UsageService | undefined
  /**
   * 设置变了之后**热切换**模型（M5.5）：重新解析 → 拆掉旧的 → 建新的。
   *
   * 为什么需要它：模型原本只在启动那一刻解析一次，用户填完 key 得重启才生效。
   * "填完就能用"和"填完重启才能用"是两种产品 —— 前者才是 BYOK 该有的样子。
   *
   * 代价说清楚：切换会**关掉现有的 harness 会话**（正在跑的那一轮会中断）。
   * 会话数据在 sqlite 里，下次 acquire 时 `resume()` 会把历史接回来。
   */
  applyModel(): Promise<ModelApplyResult>
  close(): Promise<void>
}

/** `applyModel` 的结果 —— 给人看的，不是给程序分支用的 */
export type ModelApplyResult =
  | { readonly ok: true; readonly mode: ModelPlan['mode']; readonly providerId: string; readonly modelId: string; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }

/**
 * 装配顺序很重要：`planModel` 不抛错 → server 一定会起来；
 * 真正 `resolveModel`（可能失败）与 harness 池只在有模型时创建。
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  let plan = planModel(options.core, { env: options.env })
  let model: ResolvedModel | undefined
  let pool: HarnessPool | undefined
  let chat: ChatService | undefined
  let usage: UsageService | undefined
  let taskGraph: TaskGraphService | undefined
  let closed = false

  /** 按当前 `plan` 建一套（会先拆旧的） */
  async function teardown(): Promise<void> {
    const current = { chat, taskGraph, usage, pool }
    chat = undefined
    taskGraph = undefined
    usage = undefined
    pool = undefined
    model = undefined
    if (current.chat !== undefined) await current.chat.close().catch(() => {})
    if (current.taskGraph !== undefined) await current.taskGraph.close().catch(() => {})
    if (current.usage !== undefined) await current.usage.close().catch(() => {})
    if (current.pool !== undefined) await current.pool.closeAll().catch(() => {})
  }

  function build(): void {
    if (plan === undefined) return
    model = resolveModel(options.core, { env: options.env })
    pool = new HarnessPool({
      home: options.core.home,
      model,
      ...(options.getPageDriver === undefined ? {} : { getPageDriver: options.getPageDriver }),
      /*
       * ★ 这一行曾经漏了：`AgentRuntimeOptions.components` 声明了、server 也传了、
       * `HarnessPool` 也用得上 —— 中间这一跳没人接。结果是 `install_component` 在**真实运行时里
       * 从来没挂上过**（只有直接 new HarnessPool 的测试能拿到它），模型一调就回
       * "Tool install_component is not available"，而界面上那一条还显示 ✓。
       * 类型检查抓不到，因为两侧都没错，只是没连起来。
       */
      ...(options.components === undefined ? {} : { components: options.components }),
    })
    usage = new UsageService({ pool, core: options.core, publish: options.publish })
    chat = new ChatService({
      pool,
      apps: options.core.apps,
      home: options.core.home,
      model,
      publish: options.publish,
      usage,
      ...(options.onSchemaCommit === undefined ? {} : { onSchemaCommit: options.onSchemaCommit }),
    })
    taskGraph = new TaskGraphService({ pool, publish: options.publish })
  }

  build()

  return {
    /*
     * 用 getter 而不是快照：`createHandlers` 解构的是**这个对象**，
     * 每次都读 `agent.chat` —— 换成 getter 之后热切换对调用方完全透明。
     */
    get model() {
      return model
    },
    get plan() {
      return plan
    },
    get chat() {
      return chat
    },
    get pool() {
      return pool
    },
    get taskGraph() {
      return taskGraph
    },
    get usage() {
      return usage
    },

    async applyModel(): Promise<ModelApplyResult> {
      if (closed) return { ok: false, error: '服务正在关闭' }
      const next = planModel(options.core, { env: options.env })
      const same =
        next !== undefined &&
        plan !== undefined &&
        next.mode === plan.mode &&
        next.choice.provider === plan.choice.provider &&
        next.choice.modelId === plan.choice.modelId
      // 没变就别拆（每次保存都重建会把正在跑的一轮掐掉）
      if (same) {
        return { ok: true, mode: plan!.mode, providerId: plan!.choice.provider, modelId: plan!.choice.modelId, changed: false }
      }

      await teardown()
      plan = next
      if (plan === undefined) {
        return { ok: false, error: '还没有选中任何提供商' }
      }
      try {
        build()
      } catch (error) {
        // 建不起来（比如 key 缺失）：保持"没有模型"的状态，把原因交回去
        plan = undefined
        await teardown()
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true, mode: plan.mode, providerId: plan.choice.provider, modelId: plan.choice.modelId, changed: true }
    },

    async close() {
      if (closed) return
      closed = true
      await teardown()
    },
  }
}
