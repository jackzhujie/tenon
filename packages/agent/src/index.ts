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
  close(): Promise<void>
}

/**
 * 装配顺序很重要：`planModel` 不抛错 → server 一定会起来；
 * 真正 `resolveModel`（可能失败）与 harness 池只在有模型时创建。
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const plan = planModel(options.core, { env: options.env })
  if (plan === undefined) {
    return {
      model: undefined,
      plan,
      chat: undefined,
      pool: undefined,
      taskGraph: undefined,
      usage: undefined,
      async close() {},
    }
  }

  const model = resolveModel(options.core, { env: options.env })
  const pool = new HarnessPool({
    home: options.core.home,
    model,
    ...(options.getPageDriver === undefined ? {} : { getPageDriver: options.getPageDriver }),
  })
  const usage = new UsageService({ pool, core: options.core, publish: options.publish })
  const chat = new ChatService({
    pool,
    apps: options.core.apps,
    home: options.core.home,
    model,
    publish: options.publish,
    usage,
    ...(options.onSchemaCommit === undefined ? {} : { onSchemaCommit: options.onSchemaCommit }),
  })
  const taskGraph = new TaskGraphService({ pool, publish: options.publish })

  return {
    model,
    plan,
    chat,
    pool,
    taskGraph,
    usage,
    async close() {
      await chat.close()
      await taskGraph.close()
      await usage.close()
      await pool.closeAll()
    },
  }
}
