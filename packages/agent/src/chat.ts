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
import type { AgentEvent, AgentEventStream, Cursor } from '@earendil-works/pi-durable'
import { watchEvents } from '@earendil-works/pi-durable'
import type { ChatSubmitInput, SseEventInput } from '@tenon/protocol'
import { budgetMessage, composeWithSelection, globalBudgetMessage, msg, TenonError } from '@tenon/protocol'
import type { AppStore, TenonHome } from '@tenon/core'
import { appPaths, gitops, hasSchemaChange } from '@tenon/core'
import type { HarnessPool, RootConversation } from './harness-pool.js'
import type { PlanDocTask } from './docs.js'
import { PlanDoc } from './docs.js'
import type { ResolvedModel } from './models.js'
import type { UsageService } from './usage.js'
import {
  KIND_TOOL_RESULT,
  assistantText,
  normalizeEntries,
  normalizeEntry,
  toolOutcomesOf,
  usageOf,
  type RawEntry,
  type ToolOutcome,
} from './normalize.js'

const ctx = BACKGROUND_CONTEXT
const DELTA_FLUSH_MS = 40
const LIVE_MESSAGE_ID = 'live'

type SubmissionHandle = Awaited<ReturnType<RootConversation['submit']>>

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
  /**
   * 用量与预算（M4 第 3 步）。缺省时不拦 —— agent 的单元测试不需要一个真账本。
   *
   * 拦截分两个时刻，缺一个都留不住钱：**开跑前**（额度已经用完了不许再发）与
   * **跑到一半**（一轮里把额度冲爆了，立刻停）。前者给用户一句明确的拒绝，
   * 后者靠 abort 复用「用户点停止」那条路。
   */
  usage?: UsageService
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
  /** 这一轮已经被预算掐掉的：防止几个 message_end 同时把 stop() 打成两次 */
  private readonly halted = new Set<string>()
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

  /**
   * `appId:entryId` → 这条 assistant 消息与它已收到的工具结果。
   *
   * 只留"还在等结果"的那几条：一条消息的工具结果全部到齐后就删掉，
   * 否则地图会随会话长度一直长（长会话上千条）。
   */
  private readonly awaitingTools = new Map<string, { entry: RawEntry; outcomes: Map<string, ToolOutcome>; total: number }>()

  /** 记下这条 assistant 消息发起了哪些工具调用，等结果回来时能找回来 */
  private rememberToolCalls(appId: string, entry: RawEntry, message: { parts: Array<{ type: string; toolCallId?: string }> }): void {
    const ids = message.parts.filter((part) => part.type === 'tool' && part.toolCallId !== undefined)
    if (ids.length === 0) return
    this.awaitingTools.set(`${appId}:${String(entry.id)}`, { entry, outcomes: new Map(), total: ids.length })
  }

  /** 工具结果到了：合进发起它的那条消息，然后按同一个 id 重推一次（前端按 id 替换） */
  private patchToolOutcomes(appId: string, resultEntry: RawEntry): void {
    const outcomes = toolOutcomesOf(resultEntry)
    if (outcomes.size === 0) return

    for (const key of [...this.awaitingTools.keys()]) {
      if (!key.startsWith(`${appId}:`)) continue
      const waiting = this.awaitingTools.get(key)
      if (waiting === undefined) continue

      // 这条结果是不是它的？（一个 assistant 消息可能发起多个工具调用）
      const owned = [...outcomes.keys()].filter((id) => this.toolCallsOf(waiting.entry).includes(id))
      if (owned.length === 0) continue

      for (const id of owned) {
        const outcome = outcomes.get(id)
        if (outcome !== undefined) waiting.outcomes.set(id, outcome)
      }
      if (waiting.outcomes.size >= waiting.total) this.awaitingTools.delete(key)

      const updated = normalizeEntry(waiting.entry, waiting.outcomes)
      if (updated !== undefined && updated.role === 'assistant') {
        this.options.publish({ type: 'message.end', appId, message: updated })
      }
    }
  }

  /** 一条 assistant entry 发起了哪些 toolCallId（从原始 entry 读，不依赖 parts 的类型） */
  private toolCallsOf(entry: RawEntry): string[] {
    const ids: string[] = []
    for (const message of entry.model ?? []) {
      for (const block of message.content ?? []) {
        if (typeof block === 'object' && block !== null && 'type' in block) {
          const candidate = block as { type?: string; id?: string }
          if (candidate.type === 'toolCall' && typeof candidate.id === 'string') ids.push(candidate.id)
        }
      }
    }
    return ids
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

        /*
         * ★ 工具结果到了：把**发起它的那条 assistant 消息重推一遍**。
         *
         * 为什么必须重推：一条工具调用在日志里是两条 entry（assistant + tool-result），
         * 而 `message.end` 是按 entry 发的 —— assistant 那条发出时结果还不存在，
         * 所以它带出去的工具 part **没有 output**。以前没有任何人回头更新它，于是：
         * 界面上那张卡片点开永远是空的，**直到重启应用读一次历史**才正常。
         *
         * 用户的原话是"左边所有的命令都没有返回吗？"—— 数据一直在库里，
         * 只是实时这条路上没人把结果贴回去。
         */
        if (entry.kind === KIND_TOOL_RESULT) {
          this.patchToolOutcomes(appId, entry)
          return
        }

        const message = normalizeEntry(entry)
        // 只推 assistant：用户刚发出的那条前端本来就有，回推一遍会让气泡闪一下
        if (message !== undefined && message.role === 'assistant') {
          this.rememberToolCalls(appId, entry, message)
          this.options.publish({ type: 'message.end', appId, message })
        }
        const usage = usageOf(entry)
        if (usage !== undefined) this.checkBudget(appId)
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
          text: event.entry === undefined ? '' : 'done',
        })
        return
      }
      case 'auto_retry_start': {
        this.options.publish({
          type: 'error',
          appId,
          code: 'AGENT_UNAVAILABLE',
          message: msg('error.agent.retrying', { attempt: event.attempt }),
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
      console.error(`[tenon] failed to write app state (${status}):`, err)
    }
  }

  /**
   * 一次模型响应之后：重算账，顶到上限就停。
   *
   * 为什么不在这里就地累加：`usageOf(entry)` 只看得见**根会话**这一条 entry。
   * 子 Agent 的花费在它自己的会话里、压缩摘要根本不产生 entry —— 那一半钱
   * 只有在 `harness.usage()` 里才看得到。宁可多读一次账本，也别漏掉那一半。
   *
   * 为什么用 abort 而不是"拒绝下一次请求"：pi 没有 pre-request 钩子
   * （`hook()` 只挂在 task 的 handlers 上）。所以熔断的语义是「花超了就停」，
   * 不是「预测下一笔会超就不发」。代价是可能停在工具调用中间 —— 与用户按停止键一样。
   */
  private checkBudget(appId: string): void {
    const usage = this.options.usage
    if (usage === undefined || this.closed || this.halted.has(appId)) return
    void usage
      .refresh(appId)
      .then(async (snapshot) => {
        if (snapshot.exceeded === null) return
        // 已经跑完了（最后一帧晚到）：不用停，下一次 submit 会被拦住
        if (this.closed || this.halted.has(appId) || !this.inflight.has(appId)) return
        this.halted.add(appId)
        this.options.publish({
          type: 'budget.exceeded',
          appId,
          snapshot,
          dimension: snapshot.exceeded,
        })
        await this.stop(appId)
      })
      .catch((err: unknown) => {
        // 记账失败不该影响对话本身：这一轮照跑，下一轮 submit 还会再判一次
        console.error(`[tenon] budget check failed (${appId}):`, err)
      })
  }

  async submit(appId: string, input: Omit<ChatSubmitInput, 'appId'>): Promise<{ submissionId: string }> {
    const app = this.options.apps.require(appId)
    if (input.content.trim() === '') {
      throw new TenonError('CHAT_EMPTY_INPUT', msg('error.chat.emptyInput'))
    }
    if (this.inflight.has(appId) && input.whenBusy === 'reject') {
      throw new TenonError('CHAT_BUSY', msg('error.chat.busy'), { appId })
    }

    // 额度判在**取 harness 之后**（账本在 harness 里），但在**改状态之前** ——
    // 拒绝了就不该让前端看到一次 running。
    if (this.options.usage !== undefined) {
      const { snapshot, exceeded, global } = await this.options.usage.startTurn(appId)
      /*
       * 全局闸先报。两者都撞上时必须说全局那一道：应用额度撞了还能"换个应用"，
       * 全局撞了换到哪儿都一样 —— 文案给错，用户会去试另一个应用然后再次撞墙。
       */
      if (global !== null) {
        throw new TenonError(
          'BUDGET_EXCEEDED',
          globalBudgetMessage(global.used, global.budget, global.dimension, global.window),
          {
            scope: 'global',
            window: global.window,
            dimension: global.dimension,
            used: global.used,
            budget: global.budget,
          },
        )
      }
      if (exceeded !== null) {
        throw new TenonError('BUDGET_EXCEEDED', budgetMessage(snapshot.totals, snapshot.budget, exceeded), {
          scope: 'app',
          dimension: exceeded,
          totals: snapshot.totals,
          budget: snapshot.budget,
        })
      }
    }
    this.halted.delete(appId)

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
          /*
           * 收尾再读一次账：子 Agent 的花费可能在上一次检查之后才落账，
           * 少了这一次，面板会一直差着子会话那一段。
           *
           * **必须挡住 `closed`**：进程正在退出时这一轮可能刚好 settle 完，
           * 而 harness 已经在关了。这时去读 `harness.usage()` 会把 sqlite 拽住，
           * 表现为"测试清理临时目录时 ENOTEMPTY"（真实症状：退出时残留半截文件）。
           */
          if (!this.closed) await this.options.usage?.refresh(appId).catch(() => {})
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
    /*
     * 提交信息用**英文**：它是 git 历史，会跟着仓库离开这台机器（push 到远端、被 clone、
     * 出现在别人的 `git log` 里）。界面文案要双语，历史记录不该跟着界面语言变 ——
     * 否则同一个仓库在中英文两台机器上提交出来的历史是两种语言，grep 都搜不齐。
     */
    const result = await gitops
      .commitAll(paths.repoDir, `chat: ${status === 'done' ? 'one turn' : `incomplete (${status})`}`, {
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
              message: msg('error.agent.snapshotFailed', {
                detail: err instanceof Error ? err.message : String(err),
              }),
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

  /**
   * 应用被删：只断这一个应用。
   *
   * 早先这里调的是 `close()`，而 `close()` 会把 `closed` 置上 ——
   * 于是删掉一个应用之后，**所有**应用的 `app.status` 都不再落库也不再推事件，
   * 界面永远转圈。这个 bug 很安静：日志里什么都不报，只有"卡住"。
   */
  async detach(appId: string): Promise<void> {
    this.inflight.delete(appId)
    this.halted.delete(appId)
    this.deltas.flushNow(appId)
    const stream = this.watchers.get(appId)
    this.watchers.delete(appId)
    if (stream === undefined) return
    try {
      await stream.stop()
    } catch {
      // 拆一个已关闭的 session 的订阅失败，不值得把删除流程带崩
    }
  }

  async history(appId: string, limit = 200): Promise<{ messages: ReturnType<typeof normalizeEntries>; nextCursor: null }> {
    this.options.apps.require(appId)
    const session = await this.options.pool.acquire(appId)

    /*
     * 读**完整日志**，不读 `viewState`。
     *
     * `viewState` 是"给模型看的视图"：按上下文预算裁过（压缩之后只留模型还需要的部分），
     * 而历史要回答的是"发生过什么"—— 用户往上翻的时候，被压缩掉的工具结果应该还在。
     * 实测两者在没压缩的会话里结果一致，压缩之后视图会缺；所以这里换成日志。
     *
     * 一条工具调用在日志里是两条 entry（assistant + tool-result），所以条目数要比消息数宽裕：
     * 按 3 倍取，取够再按消息数截尾。分页是为了长会话（上千条）别把内存一次拉满。
     *
     * 注意：这只是"历史"这条路。"这一轮里卡片永远是空的"是另一处 bug（实时链路没有回填
     * 工具结果），修在 `handleEvent` 的 `patchToolOutcomes`。
     */
    const wanted = Math.max(limit, 1) * 3
    const collected: RawEntry[] = []
    let cursor: Cursor | undefined
    while (collected.length < wanted) {
      // 默认是**倒序**（新的在前），取回来之后再翻正
      // `entries` 在 Conversation 上（不是 Harness）；`conversationId` 由它自己带着
      const page = await session.root.entries({}, Math.min(wanted - collected.length, 500), cursor, ctx)
      collected.push(...(page.items as unknown as RawEntry[]))
      if (page.next === undefined || page.items.length === 0) break
      cursor = page.next
    }
    collected.reverse()

    const messages = normalizeEntries(collected)
    const sliced = messages.length > limit ? messages.slice(messages.length - limit) : messages
    return { messages: sliced, nextCursor: null }
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
