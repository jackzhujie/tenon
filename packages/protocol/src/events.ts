/**
 * SSE 事件（DESIGN §7.3）。
 *
 * 铁律落地：
 * - **PGlite 下 LISTEN/NOTIFY 不可用**（SPIKES §1），所有「后端推前端」只能走这条通道
 * - 事件带单调递增 `seq`，客户端断线带 `since` 续传；`since` 过旧 → `stream.reset` + 让前端全量拉 `chat.history`
 * - `message.delta` 在服务端按 40ms 合帧（`deltas` 批量下发），不逐 token 刷屏
 * - 心跳用 SSE 注释行 `: ping`，不占用 `seq`，也不污染事件缓冲
 */
import { z } from 'zod'
import { NormalizedMessage, PlanTaskStatus, AppStatus, LogEntry, PreviewStatus, Readiness, TaskGraph } from './domain.js'

const Seq = z.number().int().nonnegative()

export const MessageDeltaEvent = z.object({
  type: z.literal('message.delta'),
  seq: Seq,
  appId: z.string(),
  /**
   * **流式期间恒为 `'live'`**：pi 的 assistant entry id 要等 `message.end` 才存在，
   * 而一个会话同时只会有一条在飞的回答（pi 串行调度）。所以前端用一个「live 气泡」
   * 接增量，收到 `message.end` 时用真实 id 的消息替换掉它。
   */
  messageId: z.string(),
  /** 一次事件可能合并多个增量帧（服务端 40ms 合帧） */
  text: z.string(),
})
export type MessageDeltaEvent = z.infer<typeof MessageDeltaEvent>

export const MessageEndEvent = z.object({
  type: z.literal('message.end'),
  seq: Seq,
  appId: z.string(),
  message: NormalizedMessage,
})

export const ToolStartEvent = z.object({
  type: z.literal('tool.start'),
  seq: Seq,
  appId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
})

export const ToolOutputEvent = z.object({
  type: z.literal('tool.output'),
  seq: Seq,
  appId: z.string(),
  toolCallId: z.string(),
  stream: z.enum(['stdout', 'stderr', 'result']),
  text: z.string(),
})

export const TaskUpdateEvent = z.object({
  type: z.literal('task.update'),
  seq: Seq,
  appId: z.string(),
  taskId: z.string(),
  status: PlanTaskStatus,
  title: z.string().optional(),
})

export const UsageEvent = z.object({
  type: z.literal('usage'),
  seq: Seq,
  appId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
})

export const AppStatusEvent = z.object({
  type: z.literal('app.status'),
  seq: Seq,
  appId: z.string(),
  status: AppStatus,
  reason: z.string().optional(),
})

export const GitCommitEvent = z.object({
  type: z.literal('git.commit'),
  seq: Seq,
  appId: z.string(),
  sha: z.string(),
  message: z.string(),
})

export const PreviewReadyEvent = z.object({
  type: z.literal('preview.ready'),
  seq: Seq,
  appId: z.string(),
  url: z.string(),
  readiness: Readiness,
})

/**
 * 预览的分阶段进度（DESIGN §9.2）。
 *
 * 为什么还要一条 `preview.status`：`preview.ready` 只在就绪那一刻发一次，
 * 而首次 `pnpm install` 可能要几十秒 —— 那段时间 UI 需要知道「在装依赖」而不是「卡住了」。
 * 失败也走这条（`state: 'failed'` + `error`），不另开一种事件。
 */
export const PreviewStatusEvent = z.object({
  type: z.literal('preview.status'),
  seq: Seq,
  appId: z.string(),
  status: PreviewStatus,
})

/**
 * 运行日志（M2 错误面板）。
 *
 * 一条一个 `LogEntry`，**不做合帧**：日志要的是时序，合帧会让"错误发生在前、预览就绪在后"
 * 这种因果关系看不出来。洪水保护放在 `LogStore` 的去重（同一句合并成 `repeat`）。
 */
export const AppLogEvent = z.object({
  type: z.literal('app.log'),
  seq: Seq,
  appId: z.string(),
  entry: LogEntry,
})

/**
 * 任务图变了（M4 任务图面板）。
 *
 * **推全量而不是增量**：一张图只有几个节点，推 diff 要维护"哪个 op 对应哪个节点"的
 * 状态机，而它带来的收益（少传几十字节）抵不上一次算错就显示错节点的代价。
 *
 * 为什么它必须是事件而不是让前端轮询：`taskGraph` 的帧是 pi 在 commit 时推出来的，
 * 一次生成十几帧，秒级轮询要么漏掉中间状态、要么白烧请求。
 */
export const TaskGraphUpdateEvent = z.object({
  type: z.literal('taskgraph.update'),
  seq: Seq,
  appId: z.string(),
  graph: TaskGraph,
})

export const ErrorEvent = z.object({
  type: z.literal('error'),
  seq: Seq,
  appId: z.string().optional(),
  code: z.string(),
  message: z.string(),
})

/** `since` 追不上时下发：前端丢弃本地增量、重新拉全量 */
export const StreamResetEvent = z.object({
  type: z.literal('stream.reset'),
  seq: Seq,
  reason: z.enum(['gap', 'server-restart', 'overflow']),
})

export const SseEvent = z.discriminatedUnion('type', [
  MessageDeltaEvent,
  MessageEndEvent,
  ToolStartEvent,
  ToolOutputEvent,
  TaskUpdateEvent,
  UsageEvent,
  AppStatusEvent,
  GitCommitEvent,
  PreviewReadyEvent,
  PreviewStatusEvent,
  AppLogEvent,
  TaskGraphUpdateEvent,
  ErrorEvent,
  StreamResetEvent,
])
export type SseEvent = z.infer<typeof SseEvent>
export type SseEventType = SseEvent['type']

/**
 * 运行时清单本体在 `event-names.ts`（零依赖，浏览器直接用）。
 * 这里只留两道编译期闸门：`satisfies` 防拼错，`_exhaustive` 防漏 —— 漏一种是静默故障。
 */
export { sseEventTypes } from './event-names.js'
import { sseEventTypes } from './event-names.js'

type MissingEventType = Exclude<SseEventType, (typeof sseEventTypes)[number]>
const _exhaustiveEventTypes: MissingEventType extends never ? true : never = true
void _exhaustiveEventTypes

/** 分发式 Omit（直接 Omit 会把 union 塌成「所有字段都可选」） */
type DistributeOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * 生产者视角的事件：**不含 `seq`**。`seq` 由 SSE 总线统一分配 ——
 * 让 agent 层去管序号只会制造「两个生产者各自从 1 开始」的经典事故。
 */
export type SseEventInput = DistributeOmit<SseEvent, 'seq'>

/** 事件名即 SSE 的 `event:` 字段，和 `type` 一致，省一层映射 */
export function sseFrame(event: SseEvent, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
