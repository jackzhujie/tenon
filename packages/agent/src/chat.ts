/**
 * 对话服务：`chat.submit` / `chat.stop` / `chat.history` + 事件桥（DESIGN §4.5 / §7.3）。
 *
 * 设计要点：
 * - **事件源是 `watchEvents`，不是 `pi.live`**。`pi.live` 只有运行态（taskId/attempt），
 *   没有 token 增量；`watchEvents` 的 `message_update.changes` 才是 `text_delta` 的出处。
 * - **40ms 合帧**在服务端做：逐 token 推 SSE 会让长回答刷出上万帧，浏览器直接卡死。
 * - 每次提交结束**自动 git 提交**（一轮一 commit），无改动则不产生空提交。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentEvent, AgentEventStream } from '@earendil-works/pi-durable'
import { watchEvents } from '@earendil-works/pi-durable'
import type { ChatSubmitInput, SseEventInput } from '@tenon/protocol'
import { composeWithSelection, TenonError } from '@tenon/protocol'
import type { AppStore, TenonHome } from '@tenon/core'
import { appPaths, gitops, hasSchemaChange } from '@tenon/core'
import type { HarnessPool, RootConversation } from './harness-pool.js'
import type { PlanDocTask } from './docs.js'
import { PlanDoc } from './docs.js'
import type { ResolvedModel } from './models.js'
import { assistantText, normalizeEntries, normalizeEntry, usageOf, type RawEntry } from './normalize.js'

const ctx = BACKGROUND_CONTEXT
const DELTA_FLUSH_MS = 40
const LIVE_MESSAGE_ID = 'live'

type SubmissionHandle = Awaited<ReturnType<RootConversation['submit']>>
type ViewState = Awaited<ReturnType<RootConversation['viewState']>>

export interface ChatServiceOptions {
  pool: HarnessPool
  apps: AppStore
  home: TenonHome
  /** 模型解析结果：faux 模式下每次生成都要先注入剧本 */
  model: ResolvedModel
  publish: (event: SseEventInput) => void
  /**
   * 这一轮提交动了 schema 时的钩子（回滚的数据侧要用）。
   *
   * 为什么是回调而不是让 `ChatService` 直接持有数据库：agent 包不认识
   * `db-provisioner`，也不该认识 —— 它只负责"提交完了，这次改的东西值不值得存快照"
   * 这个判断所需的信息（`changed` 路径列表），剩下的事由 server 接线给
   * `PreviewManager`。这样 agent 的测试不需要一个真的 PGlite。
   *
   * 回调里的异常**不能影响对话本身**：快照失败顶多是少了可回滚的数据点，
   * 而让一轮对话因为存不了快照而失败是不可接受的。
   */
  onSchemaCommit?: (input: { appId: string; sha: string; changed: string[] }) => Promise<void>
}

/** 按 app 合并文本增量，40ms 或遇到 message_end 时下发 */
class DeltaCoalescer {
  private readonly buffers = new Map<string, string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly appIds = new Map<string, string>()

  constructor(private readonly flush: (appId: string, text: string) => void) {}

  push(appId: string, text: string): void {
    if (text === '') return
    this.appIds.set(appId, appId)
    this.buffers.set(appId, (this.buffers.get(appId) ?? '') + text)
    if (this.timers.has(appId)) return
    const timer = setTimeout(() => this.flushNow(appId), DELTA_FLUSH_MS)
    // 别让一个待触发的合帧定时器把进程吊着不退出
    timer.unref?.()
    this.timers.set(appId, timer)
  }

  flushNow(appId: string): void {
    const timer = this.timers.get(appId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(appId)
    }
    const text = this.buffers.get(appId)
    this.buffers.delete(appId)
    if (text !== undefined && text !== '') this.flush(appId, text)
  }

  flushAll(): void {
    for (const appId of [...this.buffers.keys()]) this.flushNow(appId)
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.buffers.clear()
  }
}

export class ChatService {
  private readonly inflight = new Map<string, SubmissionHandle>()
  private readonly watchers = new Map<string, AgentEventStream>()
  private readonly deltas: DeltaCoalescer
  private closed = false

  constructor(private readonly options: ChatServiceOptions) {
    this.deltas = new DeltaCoalescer((appId, text) => {
      this.options.publish({ type: 'message.delta', appId, messageId: LIVE_MESSAGE_ID, text })
    })
  }

  private async ensureWatcher(appId: string, session: Awaited<ReturnType<HarnessPool['acquire']>>): Promise<void> {
    if (this.watchers.has(appId)) return
    const stream = await watchEvents(session.harness, session.conversationId, ctx)
    await stream.start(async (events: readonly AgentEvent[]) => {
      for (const event of events) this.handleEvent(appId, event)
    })
    this.watchers.set(appId, stream)
  }

  private handleEvent(appId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'message_update': {
        for (const change of event.changes) {
          if (change.type === 'text_delta') this.deltas.push(appId, change.delta)
        }
        return
      }
      case 'message_end': {
        this.deltas.flushNow(appId)
        const entry = event.entry as unknown as RawEntry
        const message = normalizeEntry(entry)
        // 只推 assistant：用户刚发出的那条前端本来就有，回推一遍会让气泡闪一下
        if (message !== undefined && message.role === 'assistant') {
          this.options.publish({ type: 'message.end', appId, message })
        }
        const usage = usageOf(entry)
        if (usage !== undefined) {
          this.options.publish({ type: 'usage', appId, ...usage })
        }
        return
      }
      case 'tool_execution_start': {
        this.options.publish({
          type: 'tool.start',
          appId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args as Record<string, unknown>,
        })
        return
      }
      case 'tool_execution_update': {
        const output = event.output
        if (output !== undefined && 'append' in output && output.append !== undefined) {
          this.options.publish({
            type: 'tool.output',
            appId,
            toolCallId: event.toolCallId,
            stream: 'stdout',
            text: output.append,
          })
        }
        return
      }
      case 'tool_execution_end': {
        this.options.publish({
          type: 'tool.output',
          appId,
          toolCallId: event.toolCallId,
          stream: 'result',
          text: event.entry === undefined ? '' : '完成',
        })
        return
      }
      case 'auto_retry_start': {
        this.options.publish({
          type: 'error',
          appId,
          code: 'AGENT_UNAVAILABLE',
          message: `模型调用失败，正在第 ${event.attempt} 次重试`,
        })
        return
      }
      default:
        return
    }
  }

  /**
   * 状态变化必须**同时**落库与推事件：前端靠 `app.status` 判断"这一轮结束了吗"，
   * 用它去放开输入框。之前只写库不推事件，前端只能猜（或者等 git.commit —— 没改动时就没有）。
   *
   * 关闭之后一律跳过：进程正在退出时，submission 的 settle 回调可能晚于 `close()` 到达，
   * 那时 `tenon.db` 已经关了，写库会抛 `database is not open` 变成 unhandled rejection
   * （测试里表现为"33 项全过但有 2 个 unhandled error"）。
   */
  private setStatus(appId: string, status: 'idle' | 'running' | 'error'): void {
    if (this.closed) return
    try {
      this.options.apps.setStatus(appId, status)
      this.options.publish({ type: 'app.status', appId, status })
    } catch (err) {
      // 状态是给人看的信息，落不了库不值得把进程带崩；真出错有别的日志兜着
      console.error(`[tenon] 写入应用状态失败（${status}）：`, err)
    }
  }

  async submit(appId: string, input: Omit<ChatSubmitInput, 'appId'>): Promise<{ submissionId: string }> {
    const app = this.options.apps.require(appId)
    if (input.content.trim() === '') {
      throw new TenonError('CHAT_EMPTY_INPUT', '消息内容不能为空')
    }
    if (this.inflight.has(appId) && input.whenBusy === 'reject') {
      throw new TenonError('CHAT_BUSY', '这个应用正在生成中，稍等一下再发', { appId })
    }

    const session = await this.options.pool.acquire(appId)
    await this.ensureWatcher(appId, session)

    // faux 模式每次生成都要先塞一条剧本；真实 provider 是 no-op
    this.options.model.primeTurn(input.content)

    const submission = await session.root.submit(
      {
        type: 'input',
        // 点选上下文（DESIGN §10.3）拼在正文第一行 —— `pi-durable` 的 submit 只吃纯文本，
        // 没有结构化附件入口。前端渲染用户气泡时用 `stripSelectionBlock` 把它剥掉。
        content: composeWithSelection(input.content, input.selection),
        requestId: input.requestId,
      },
      ctx,
    )
    this.inflight.set(appId, submission)
    this.setStatus(appId, 'running')

    void submission
      .wait(ctx)
      .then(async (settled) => {
        this.deltas.flushNow(appId)
        this.inflight.delete(appId)
        // 先提交再放 idle：前端看到「空闲」时版本列表必须已经是新的
        try {
          await this.commitTurn(app, submission.id, settled.status)
        } finally {
          this.setStatus(appId, 'idle')
        }
      })
      .catch((err: unknown) => {
        this.inflight.delete(appId)
        this.setStatus(appId, 'error')
        this.options.publish({
          type: 'error',
          appId,
          code: 'AGENT_UNAVAILABLE',
          message: err instanceof Error ? err.message : String(err),
        })
      })

    return { submissionId: String(submission.id) }
  }

  /**
   * 一轮一 commit（DESIGN §12.2）。工具还没接上时通常没有文件变化 → 不产生空提交；
   * 提交失败也不能把对话本身搞坏，所以只上报事件。
   */
  private async commitTurn(
    app: { id: string; name: string },
    submissionId: unknown,
    status: string,
  ): Promise<void> {
    // 进程正在退出：这一轮没跑完，别在这时候去动 git
    if (this.closed) return
    const paths = appPaths(this.options.home, app.id)
    const result = await gitops
      .commitAll(paths.repoDir, `chat: ${status === 'done' ? '一轮对话' : `未完成（${status}）`}`, {
        appId: app.id,
        submissionId: String(submissionId),
      })
      .catch((err: unknown) => {
        this.options.publish({
          type: 'error',
          appId: app.id,
          code: 'GIT_COMMIT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
        return undefined
      })
    if (result !== undefined) {
      this.options.publish({
        type: 'git.commit',
        appId: app.id,
        sha: result.sha,
        message: result.message.split('\n')[0] ?? result.message,
      })
      // 快照按 commit sha 归档，所以必须在拿到 sha 之后 —— 这个顺序不能换
      if (hasSchemaChange(result.changed) && this.options.onSchemaCommit !== undefined) {
        await this.options
          .onSchemaCommit({ appId: app.id, sha: result.sha, changed: result.changed })
          .catch((err: unknown) => {
            this.options.publish({
              type: 'error',
              appId: app.id,
              code: 'DB_DUMP_FAILED',
              message: `库快照失败，这一版将无法连数据一起回滚：${
                err instanceof Error ? err.message : String(err)
              }`,
            })
          })
      }
    }
  }

  async stop(appId: string): Promise<boolean> {
    const submission = this.inflight.get(appId)
    if (submission === undefined) return false
    await submission.abort(ctx)
    this.deltas.flushNow(appId)
    this.inflight.delete(appId)
    this.setStatus(appId, 'idle')
    return true
  }

  isBusy(appId: string): boolean {
    return this.inflight.has(appId)
  }

  async history(appId: string, limit = 200): Promise<{ messages: ReturnType<typeof normalizeEntries>; nextCursor: null }> {
    this.options.apps.require(appId)
    const session = await this.options.pool.acquire(appId)
    const view: ViewState = await session.root.viewState(ctx)
    try {
      const entries = view.value.entries as unknown as RawEntry[]
      const messages = normalizeEntries(entries)
      const sliced = messages.length > limit ? messages.slice(messages.length - limit) : messages
      return { messages: sliced, nextCursor: null }
    } finally {
      await view.dispose?.()
    }
  }

  /**
   * 计划来自 `tenon.plan` doc（DESIGN §6.3），**不是**从 taskGraph 反推：
   * taskGraph 静止时节点会被回收（SPIKES 陷阱），拿它当计划清单会时有时无。
   * M1 阶段还没有生成器写这个 doc，所以返回空数组是正确结果，不是缺失实现。
   */
  async plan(appId: string): Promise<PlanDocTask[]> {
    this.options.apps.require(appId)
    const session = await this.options.pool.acquire(appId)
    const snapshot = await session.harness.snapshot(PlanDoc, session.conversationId, ctx)
    return snapshot?.tasks ?? []
  }

  async close(): Promise<void> {
    this.closed = true
    this.deltas.flushAll()
    this.deltas.dispose()
    for (const [appId, stream] of this.watchers) {
      try {
        await stream.stop()
      } catch {
        // 关闭阶段的清理失败不值得把整个进程带崩
      }
      this.watchers.delete(appId)
    }
  }
}

/** 摘要工具：给下一步的 generator 用（也方便测试断言） */
export function summarize(entry: RawEntry): string {
  return assistantText(entry).split('\n')[0]?.slice(0, 80) ?? ''
}
