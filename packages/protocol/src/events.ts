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
import { NormalizedMessage, PlanTaskStatus, AppStatus } from './domain.js'

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
  readiness: z.object({
    deps: z.enum(['pending', 'ready', 'failed']),
    server: z.enum(['pending', 'ready', 'failed']),
    preview: z.enum(['pending', 'ready', 'failed']),
  }),
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
  ErrorEvent,
  StreamResetEvent,
])
export type SseEvent = z.infer<typeof SseEvent>
export type SseEventType = SseEvent['type']

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
