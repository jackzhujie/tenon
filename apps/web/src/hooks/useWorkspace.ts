/**
 * 工作区状态：应用列表 + 会话 + 预览 + 事件流，全部收敛在一个 reducer 里。
 *
 * 为什么不用 TanStack Query（DESIGN §4 里列了它）：M1 的数据源只有 5 个 RPC，
 * 而真正复杂的是**事件归约**（增量、工具调用、就绪进度、断线重连），
 * Query 解决的是缓存失效，不解决这个。等 M2 有十几个列表接口时再引它，
 * 那时 `api/` 层的形状正好已经稳定。
 *
 * 归约里最容易错的三件事，都在下面标了：
 * 1. `message.delta` 的 `messageId` 恒为 `'live'` —— 真实 id 要等 `message.end`
 * 2. 乐观插入的用户消息在 `history` 重拉时必须整体替换，不能追加
 * 3. `stream.reset` 之后本地增量一律不可信，只能重拉
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  App,
  AppStatus,
  BudgetDimension,
  CheckOutcome,
  GitCommit,
  LogEntry,
  NormalizedMessage,
  PreviewStatus,
  Release,
  RpcOutput,
  SelectionContext,
  SseEvent,
  TaskGraph,
  TemplateInfo,
  UsageSnapshot,
} from '@tenon/protocol'
import { rpc, TenonRpcError } from '../lib/rpc.js'
import { EventStream, type StreamState } from '../lib/stream.js'
// 走 `/browser` 子路径：主入口会把整张 zod 表带进产物
import { budgetMessage } from '@tenon/protocol/browser'

export interface ToolActivity {
  toolCallId: string
  name: string
  args: Record<string, unknown> | undefined
  output: string
  status: 'running' | 'ok' | 'error'
  /**
   * 这一次工具调用自己花了多少（v1.2.19，目前只有 `subagent` 会带）。
   *
   * 只来自历史消息：实时事件（`tool.start` / `tool.end`）里没有这个数，
   * 要等工具结果落进 transcript 才读得到。所以它只出现在已落定的那条上。
   */
  spend?: { totalTokens: number; costUsd: number }
}

export interface LiveTurn {
  text: string
  tools: ToolActivity[]
}

/** 当前生效的模型。`faux` 要显眼地告诉用户「回复是假的，只是验证链路」 */
export interface ActiveModel {
  mode: 'faux' | 'openai-compatible'
  providerId: string
  modelId: string
}

/** `git.show` 的返回：一条提交自己改了什么（见 protocol 的同名 RPC） */
export type GitShow = RpcOutput<'git.show'>

/** `release.publish` 的返回 */
export type PublishResult = RpcOutput<'release.publish'>

/** `release.check` 的返回（预检：只读，但会真跑测试） */
export type ReleaseCheck = RpcOutput<'release.check'>

export type CheckOutcomeResult = { ok: true; result: ReleaseCheck } | { ok: false; message: string }

export type PublishOutcome =
  | { ok: true; result: PublishResult }
  /**
   * 失败时把 `code` 与检查清单一起带回来。
   *
   * 只有 message 的话，对话框没法区分"工作区脏了"和"类型检查没过" —— 前者是
   * 一句话说清的事，后者要逐项列出来，还要给一个"我就要发"的出口。这两件事的
   * 界面差得远，靠解析 message 猜是不行的。
   */
  | { ok: false; message: string; code: string; checks: CheckOutcome[] | null }

/** 只关心成不成的动作：失败原因交给就地显示的地方，不弹全局错误条 */
export type Outcome = { ok: true } | { ok: false; message: string }

interface State {
  apps: App[]
  templates: TemplateInfo[]
  activeAppId: string | null
  messages: NormalizedMessage[]
  live: LiveTurn | null
  status: AppStatus | null
  preview: PreviewStatus | null
  commits: GitCommit[]
  /** 运行日志（错误面板）。跟 `app.log` 事件增量 + `logs.list` 首拉 */
  logs: LogEntry[]
  /**
   * 现在活着的任务（任务图面板）。跟 `taskgraph.update` 事件全量替换 + `taskgraph.get` 首拉。
   * **跑完就空**：pi 静止时回收节点，所以"空"不是没数据，是没人跑了。
   */
  graph: TaskGraph
  /** 精调：从预览里点选的元素/区域。提交时一并交给 Agent，提交后清掉 */
  selection: SelectionContext | null
  /** 改动面板：当前查看的提交内容（`git.show` 的结果） */
  diff: GitShow | null
  /** 点开的是哪一条。与 `diff.commit.sha` 分开存，切换时旧内容还在，不会闪成空白 */
  viewingSha: string | null
  diffLoading: boolean
  reverting: boolean
  /** 发布记录（`release.list`）：发布对话框里的历史 */
  releases: Release[]
  publishing: boolean
  stream: StreamState
  /**
   * 这个应用的账（`usage.get` 首拉 + `usage.update` 全量替换）。
   * 空 = 还没拉到；**不是**"没花钱"。真值在服务端会话账本里，跨重启不丢。
   */
  usage: UsageSnapshot | null
  /**
   * 这一轮被额度掐了（`budget.exceeded`）。只用来解释"为什么突然停了"，
   * 下一次提交或改了额度就清掉 —— 它不是历史，留着会变成一条永远不消失的红字。
   */
  budgetStopped: BudgetDimension | null
  model: ActiveModel | null
  error: string | null
  /** 首次加载（应用列表还没回来） */
  booting: boolean
  /** 正在提交这一轮（从按下回车到 app.status 回到 idle） */
  submitting: boolean
}

const initialState: State = {
  apps: [],
  templates: [],
  activeAppId: null,
  messages: [],
  live: null,
  status: null,
  preview: null,
  commits: [],
  logs: [],
  graph: { rootConversationId: '', nodes: [] },
  selection: null,
  diff: null,
  viewingSha: null,
  diffLoading: false,
  reverting: false,
  releases: [],
  publishing: false,
  stream: 'stopped',
  usage: null,
  budgetStopped: null,
  model: null,
  error: null,
  booting: true,
  submitting: false,
}

type Action =
  | {
      kind: 'booted'
      apps: App[]
      templates: TemplateInfo[]
      activeAppId: string | null
      model: ActiveModel | null
    }
  | { kind: 'apps'; apps: App[] }
  /** 模型换了（设置页里保存之后）：让顶栏那个标签立刻跟上，不用刷新整页 */
  | { kind: 'model'; model: ActiveModel | null }
  | { kind: 'select'; appId: string | null }
  | { kind: 'history'; messages: NormalizedMessage[] }
  | { kind: 'commits'; commits: GitCommit[] }
  | { kind: 'logs'; logs: LogEntry[] }
  | { kind: 'logs.clear' }
  | { kind: 'graph'; graph: TaskGraph }
  | { kind: 'usage'; snapshot: UsageSnapshot }
  | { kind: 'budget.set'; snapshot: UsageSnapshot }
  | { kind: 'preview'; preview: PreviewStatus | null }
  | { kind: 'selection'; selection: SelectionContext | null }
  | { kind: 'diff'; sha: string | null; diff: GitShow | null }
  | { kind: 'diff.loading'; loading: boolean }
  | { kind: 'revert'; reverting: boolean }
  | { kind: 'releases'; releases: Release[] }
  | { kind: 'publishing'; publishing: boolean }
  | { kind: 'optimistic'; message: NormalizedMessage }
  | { kind: 'submit.start' }
  | { kind: 'submit.done' }
  | { kind: 'stream'; state: StreamState }
  | { kind: 'error'; message: string | null }
  | { kind: 'event'; event: SseEvent }

function appendDelta(live: LiveTurn | null, text: string): LiveTurn {
  return { text: (live?.text ?? '') + text, tools: live?.tools ?? [] }
}

function upsertTool(tools: ToolActivity[], toolCallId: string, patch: Partial<ToolActivity>): ToolActivity[] {
  const index = tools.findIndex((tool) => tool.toolCallId === toolCallId)
  if (index === -1) {
    return [
      ...tools,
      {
        toolCallId,
        name: patch.name ?? 'tool',
        args: patch.args,
        output: patch.output ?? '',
        status: patch.status ?? 'running',
      },
    ]
  }
  const next = [...tools]
  const current = next[index] as ToolActivity
  next[index] = { ...current, ...patch }
  return next
}

/**
 * 日志按 id upsert。
 *
 * 为什么不能无脑 append：服务端会把"同一句在 1 秒内重复"合并成一条 `repeat++`，
 * 而合并后的条目 **id 不变**、还是会被推过来。append 的话同一行会重复出现 N 次；
 * replace 才对应"界面上一条 ×N"。
 *
 * 上限 300：面板只显示最后一批，但保留一点余量让筛选时还能翻到更多。
 */
const MAX_LOGS = 300

function upsertLog(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  const index = logs.findIndex((item) => item.id === entry.id)
  if (index !== -1) {
    const next = [...logs]
    next[index] = entry
    return next
  }
  const next = [...logs, entry]
  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
}

function reduceEvent(state: State, event: SseEvent): State {
  switch (event.type) {
    case 'message.delta':
      return { ...state, live: appendDelta(state.live, event.text) }

    case 'message.end': {
      // 服务端只推 assistant 的 message_end（用户的也会触发，那边已过滤），
      // 但这里再挡一次：万一把用户的 entry 推过来，前端会把自己刚发的气泡重画一遍
      if (event.message.role !== 'assistant') return state
      const exists = state.messages.some((message) => message.id === event.message.id)
      const messages = exists
        ? state.messages.map((message) => (message.id === event.message.id ? event.message : message))
        : [...state.messages, event.message]
      return { ...state, messages, live: null }
    }

    case 'tool.start':
      return {
        ...state,
        live: {
          text: state.live?.text ?? '',
          tools: upsertTool(state.live?.tools ?? [], event.toolCallId, {
            name: event.name,
            args: event.args,
            status: 'running',
          }),
        },
      }

    case 'tool.output': {
      const tools = state.live?.tools ?? []
      const current = tools.find((tool) => tool.toolCallId === event.toolCallId)
      const output = event.stream === 'result' ? current?.output ?? '' : (current?.output ?? '') + event.text
      return {
        ...state,
        live: {
          text: state.live?.text ?? '',
          tools: upsertTool(tools, event.toolCallId, {
            output,
            status: event.stream === 'result' ? 'ok' : 'running',
          }),
        },
      }
    }

    case 'app.status':
      return {
        ...state,
        status: event.status,
        // 这一轮跑完了：收起「停止」按钮，让输入框可用
        submitting: event.status === 'running' ? state.submitting : false,
      }

    case 'preview.status':
      return { ...state, preview: event.status }

    case 'app.log':
      return { ...state, logs: upsertLog(state.logs, event.entry) }

    /*
     * 任务图推的是**全量**（一张图就几个节点），所以直接替换。
     * 带 appId 的判断：切换应用的一瞬间，上一个应用的帧可能还在路上 ——
     * 不挡会让新应用的面板闪一下别人的任务。
     */
    case 'taskgraph.update':
      return event.appId === state.activeAppId ? { ...state, graph: event.graph } : state

    case 'preview.ready':
      return state.preview === null
        ? state
        : { ...state, preview: { ...state.preview, state: 'ready', url: event.url, readiness: event.readiness } }

    case 'git.commit':
      // 列表靠 `git.log` 重拉，这里只用来触发刷新（由调用方处理）
      return state

    case 'usage.update':
      return event.appId === state.activeAppId ? { ...state, usage: event.snapshot } : state

    /*
     * 这一轮被额度掐了。快照跟着换（那一刻的数就是"用超了"的证据），
     * 并记下是哪个维度 —— 横幅要说清是 token 不够还是钱不够，两者该调的东西不一样。
     *
     * 同时塞进全局错误条：中断发生在对话正中间，用户的眼睛在左边那一栏，
     * 顶栏一个小圆点变红是看不见的。
     */
    case 'budget.exceeded':
      return event.appId === state.activeAppId
        ? {
            ...state,
            usage: event.snapshot,
            budgetStopped: event.dimension,
            error: budgetMessage(event.snapshot.totals, event.snapshot.budget, event.dimension),
          }
        : state

    case 'error':
      return { ...state, error: event.message }

    default:
      return state
  }
}

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case 'booted':
      return {
        ...state,
        apps: action.apps,
        templates: action.templates,
        activeAppId: action.activeAppId,
        // 和 `select` 同理：首屏就要显示真实状态，别让「准备中」跟着刷新一直挂着
        status: action.apps.find((app) => app.id === action.activeAppId)?.status ?? null,
        model: action.model,
        booting: false,
      }
    case 'apps':
      return { ...state, apps: action.apps }
    case 'model':
      return { ...state, model: action.model }
    case 'select':
      // 换应用 → 旧会话的一切立刻清空，别让上一个应用的消息闪现
      //
      // `status` 顺手从应用列表里取：一律置 null 的话，界面会一直停在「准备中」，
      // 直到这个应用下一次推 `app.status` —— 一个闲着的应用不该看起来像在忙。
      return {
        ...state,
        activeAppId: action.appId,
        messages: [],
        live: null,
        preview: null,
        commits: [],
        logs: [],
        graph: { rootConversationId: '', nodes: [] },
        usage: null,
        budgetStopped: null,
        releases: [],
        status: state.apps.find((app) => app.id === action.appId)?.status ?? null,
        error: null,
      }
    case 'history':
      // ★ 整体替换，不追加：乐观插入的用户消息在这里被服务端的真实历史覆盖
      return { ...state, messages: action.messages, live: null }
    case 'commits':
      return { ...state, commits: action.commits }
    case 'logs':
      return { ...state, logs: action.logs.slice(-MAX_LOGS) }
    case 'logs.clear':
      return { ...state, logs: [] }
    case 'graph':
      return { ...state, graph: action.graph }
    case 'usage':
      return { ...state, usage: action.snapshot }
    case 'budget.set':
      // 改了额度就把"被掐"的横幅收起来：用户刚做完处理，再摆一句红字像是在骂他
      return { ...state, usage: action.snapshot, budgetStopped: null }
    case 'preview':
      return { ...state, preview: action.preview }
    case 'selection':
      return { ...state, selection: action.selection }
    case 'diff':
      return { ...state, viewingSha: action.sha, diff: action.diff }
    case 'diff.loading':
      return { ...state, diffLoading: action.loading }
    case 'revert':
      return { ...state, reverting: action.reverting }
    case 'releases':
      return { ...state, releases: action.releases }
    case 'publishing':
      return { ...state, publishing: action.publishing }
    case 'optimistic':
      return {
        ...state,
        messages: [...state.messages, action.message],
        submitting: true,
        error: null,
        budgetStopped: null,
      }
    case 'submit.start':
      return { ...state, submitting: true, error: null, budgetStopped: null }
    case 'submit.done':
      return { ...state, submitting: false }
    case 'stream':
      return { ...state, stream: action.state }
    case 'error':
      return { ...state, error: action.message, submitting: false }
    case 'event':
      return reduceEvent(state, action.event)
    default:
      return state
  }
}

function messageOf(err: unknown): string {
  if (err instanceof TenonRpcError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

const LAST_APP_KEY = 'tenon.lastAppId'

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export interface Workspace {
  state: State
  activeApp: App | null
  selectApp(appId: string | null): void
  createApp(name: string, templateId: string): Promise<void>
  /** 改显示名（不动目录与 slug） */
  renameApp(appId: string, name: string): Promise<void>
  deleteApp(appId: string): Promise<void>
  submit(content: string): Promise<void>
  stop(): Promise<void>
  startPreview(restart?: boolean): Promise<void>
  clearLogs(): Promise<void>
  setSelection(selection: SelectionContext | null): void
  /** 重新问一次"现在用的是什么模型"（设置页保存后调，顶栏标签立刻跟上） */
  refreshModel(): Promise<void>
  /** 打开某一版看它改了什么（`git.show`） */
  showCommit(sha: string): Promise<void>
  /**
   * 回滚某一版（`revert`：产生新的反向提交，历史保留）。
   * `dbRestore` 为真时把库一起还原到这一版之前（服务端会先停预览）。
   */
  revertCommit(sha: string, dbRestore?: boolean): Promise<void>
  /**
   * 发布（`release.publish`）。失败的原因返回给调用方，由对话框就地显示。
   * `force` 是"检查没过也发" —— 服务端仍然会跑检查，只是不拦，记录里标 `forced`。
   */
  publish(notes: string, force?: boolean): Promise<PublishOutcome>
  /**
   * 发布预检（`release.check`）：现在这一版能不能发。
   *
   * **会真跑 `tsc` 与 `pnpm run test`**，所以一次可能要几十秒 —— 调用方要显示进度，
   * 否则用户以为界面卡死了。它只读：不打 tag、不写记录、不消耗版本号。
   */
  checkRelease(): Promise<CheckOutcomeResult>

  /**
   * 设额度（`budget.set`）。两个值一起传：空 = 这条不设限，0 = 这个应用不许再花。
   * 失败返回原因，由额度面板就地显示 —— 那里才知道用户刚输了什么。
   */
  setBudget(maxCostUsd: number | null, maxTokens: number | null): Promise<Outcome>
  clearError(): void
}

export function useWorkspace(): Workspace {
  const [state, dispatch] = useReducer(reducer, initialState)
  const streamRef = useRef<EventStream | null>(null)
  const activeAppIdRef = useRef<string | null>(null)
  activeAppIdRef.current = state.activeAppId
  // 同理由：submit 是 useCallback([]) 的，读 state.selection 会拿到首次渲染的闭包
  const selectionRef = useRef<SelectionContext | null>(null)
  selectionRef.current = state.selection
  // 同样的道理：回调里要读模板清单判断「这个模板能不能跑」，但不想让它进依赖数组
  const templatesRef = useRef<TemplateInfo[]>([])
  templatesRef.current = state.templates

  // ---------------------------------------------------------------- 启动：应用列表 + 模板

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [apps, templates, health] = await Promise.all([
          rpc('app.list', { includeArchived: false }),
          rpc('template.list', {}),
          // 顺带问一次「现在用的是什么模型」：faux 必须显式告诉用户，否则他会以为回答是真模型给的
          rpc('health', {}),
        ])
        if (cancelled) return
        const remembered = globalThis.localStorage?.getItem(LAST_APP_KEY) ?? null
        const first = apps.apps.find((app) => app.id === remembered) ?? apps.apps[0] ?? null
        dispatch({
          kind: 'booted',
          apps: apps.apps,
          templates: templates.templates,
          activeAppId: first?.id ?? null,
          model: health.model,
        })
      } catch (err) {
        if (cancelled) return
        dispatch({ kind: 'booted', apps: [], templates: [], activeAppId: null, model: null })
        dispatch({ kind: 'error', message: messageOf(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (state.activeAppId === null) return
    globalThis.localStorage?.setItem(LAST_APP_KEY, state.activeAppId)
  }, [state.activeAppId])

  // ---------------------------------------------------------------- 切应用：拉历史 / 预览 / 提交记录

  const refreshHistory = useCallback(async (appId: string) => {
    const history = await rpc('chat.history', { appId })
    dispatch({ kind: 'history', messages: history.messages })
  }, [])

  const refreshCommits = useCallback(async (appId: string) => {
    const log = await rpc('git.log', { appId, limit: 20 })
    dispatch({ kind: 'commits', commits: log.commits })
  }, [])

  const refreshReleases = useCallback(async (appId: string) => {
    try {
      const result = await rpc('release.list', { appId, limit: 20 })
      dispatch({ kind: 'releases', releases: result.releases })
    } catch {
      // 发布历史拉不到不该挡住别的：对话框里显示"还没有发布过"比整页报错好
      dispatch({ kind: 'releases', releases: [] })
    }
  }, [])

  /**
   * 首拉日志。
   *
   * 必须拉：SSE 只推"连上之后"的事，而用户切回来最想看的是**刚才**那条报错。
   * 拉失败不该打断别的东西 —— 日志面板空着比整页报错好。
   */
  const refreshLogs = useCallback(async (appId: string) => {
    try {
      const result = await rpc('logs.list', { appId, limit: 200 })
      dispatch({ kind: 'logs', logs: result.entries })
    } catch {
      dispatch({ kind: 'logs', logs: [] })
    }
  }, [])

  /**
   * 首拉任务图。
   *
   * 必须拉：SSE 只推"连上之后"的帧，而打开界面时可能正有一轮在跑
   * （服务端在 `chat.submit` 时就已经把 watch 挂上了，节点是活的）。
   * 拉失败就当没有任务 —— 面板不出现，比整页报错合理。
   */
  const refreshGraph = useCallback(async (appId: string) => {
    try {
      const result = await rpc('taskgraph.get', { appId })
      dispatch({ kind: 'graph', graph: result.graph })
    } catch {
      dispatch({ kind: 'graph', graph: { rootConversationId: '', nodes: [] } })
    }
  }, [])

  /**
   * 首拉用量。
   *
   * 必须拉：账本在服务端的会话里，页面上没有任何本地账可以累加（子 Agent 与压缩摘要
   * 的消耗都不经过父会话的事件流）。拉失败就空着 —— 少一个数字比整页报错好。
   */
  const refreshUsage = useCallback(async (appId: string) => {
    try {
      const result = await rpc('usage.get', { appId })
      dispatch({ kind: 'usage', snapshot: result.snapshot })
    } catch {
      /* 用量拉不到不阻塞任何操作：它只是显示 */
    }
  }, [])

  useEffect(() => {
    const appId = state.activeAppId
    if (appId === null) return
    let cancelled = false
    void (async () => {
      try {
        const [preview] = await Promise.all([
          rpc('preview.status', { appId }),
          refreshHistory(appId),
          refreshCommits(appId),
          refreshLogs(appId),
          refreshReleases(appId),
          refreshGraph(appId),
          refreshUsage(appId),
        ])
        if (!cancelled) dispatch({ kind: 'preview', preview: preview.preview })
      } catch (err) {
        if (!cancelled) dispatch({ kind: 'error', message: messageOf(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.activeAppId, refreshHistory, refreshCommits, refreshLogs, refreshReleases, refreshGraph, refreshUsage])

  // ---------------------------------------------------------------- 事件流（先连后发）

  useEffect(() => {
    const appId = state.activeAppId
    if (appId === null) {
      streamRef.current?.stop()
      streamRef.current = null
      dispatch({ kind: 'stream', state: 'stopped' })
      return
    }

    const stream = new EventStream({
      appId,
      handlers: {
        onEvent: (event) => {
          dispatch({ kind: 'event', event })
          // 有新提交就刷新版本列表：`git.commit` 事件不带完整 commit 对象，
          // 也不用它带 —— 一条 RPC 回来比在多处拼装字段更不容易漂
          if (event.type === 'git.commit') {
            void refreshCommits(appId).catch(() => {
              /* 版本列表拉不到不影响对话 */
            })
          }
        },
        onState: (next) => dispatch({ kind: 'stream', state: next }),
        onReset: () => {
          // 本地增量不可信了，只能重拉全量
          void refreshHistory(appId).catch(() => {})
          void refreshCommits(appId).catch(() => {})
          void refreshLogs(appId).catch(() => {})
          void refreshGraph(appId).catch(() => {})
          void refreshUsage(appId).catch(() => {})
        },
      },
    })
    streamRef.current = stream
    stream.start()

    return () => {
      stream.stop()
      if (streamRef.current === stream) streamRef.current = null
    }
  }, [state.activeAppId, refreshCommits, refreshHistory, refreshLogs, refreshGraph, refreshUsage])

  // ---------------------------------------------------------------- 动作

  const selectApp = useCallback((appId: string | null) => {
    dispatch({ kind: 'select', appId })
    // 上一个应用的改动不能留在面板里 —— 路径、sha 全是别人的，看着像数据串了
    dispatch({ kind: 'diff', sha: null, diff: null })
  }, [])

  const createApp = useCallback(
    async (name: string, templateId: string) => {
      try {
        const created = await rpc('app.create', { name, templateId, styleId: null })
        const apps = await rpc('app.list', { includeArchived: false })
        dispatch({ kind: 'apps', apps: apps.apps })
        dispatch({ kind: 'select', appId: created.app.id })
        // 建完就把预览起起来：用户点进来第一件事是「看到东西」，
        // 让他再点一次「预览」纯属多余（`preview.start` 立刻返回，不会卡住这一步）。
        // 但**空模板没有入口文件**，起了必然以「没有 package.json」失败——
        // 那种红字错误对用户毫无解释力，不如老老实实停在「预览未启动」。
        const template = templatesRef.current.find((item) => item.id === created.app.templateId)
        if (template === undefined || template.entry !== null) {
          await rpc('preview.start', { appId: created.app.id, restart: false })
        }
      } catch (err) {
        dispatch({ kind: 'error', message: messageOf(err) })
      }
    },
    [],
  )

  /**
   * 改名。只改显示名 —— 目录与 slug 不动（那是 `appPaths` 的一部分，改它等于搬仓库）。
   * 成功后把整个列表换掉：`updated_at` 变了，列表顺序也可能变。
   */
  const renameApp = useCallback(async (appId: string, name: string) => {
    try {
      await rpc('app.rename', { id: appId, name })
      const apps = await rpc('app.list', { includeArchived: false })
      dispatch({ kind: 'apps', apps: apps.apps })
    } catch (err) {
      dispatch({ kind: 'error', message: messageOf(err) })
    }
  }, [])

  const deleteApp = useCallback(
    async (appId: string) => {
      try {
        await rpc('app.delete', { id: appId, removeFiles: true })
        const apps = await rpc('app.list', { includeArchived: false })
        dispatch({ kind: 'apps', apps: apps.apps })
        if (activeAppIdRef.current === appId) {
          /*
           * 删的正是当前应用 → 切到剩下的第一个。走 `selectApp` 而不是裸 dispatch：
           * 它会把改动面板一起清掉。不清的话面板里还挂着那个应用的 sha 与文件路径，
           * 点"回滚"会把已经不存在的应用当成目标 —— 看着像数据串了。
           */
          selectApp(apps.apps[0]?.id ?? null)
        }
      } catch (err) {
        dispatch({ kind: 'error', message: messageOf(err) })
      }
    },
    [selectApp],
  )

  const submit = useCallback(async (content: string) => {
    const appId = activeAppIdRef.current
    if (appId === null) return
    const text = content.trim()
    if (text === '') return
    const selection = selectionRef.current

    const requestId = newRequestId()
    // 乐观插入：服务端不为用户 entry 推 `message.end`，不插就得等下一轮历史刷新才看得到自己说的话
    dispatch({
      kind: 'optimistic',
      message: {
        id: `local-${requestId}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        at: Date.now(),
        status: 'settled',
      },
    })

    try {
      await rpc('chat.submit', {
        appId,
        content: text,
        requestId,
        ...(selection === null ? {} : { selection }),
      })
      // 点选上下文是"这一轮"的，发出去就消耗掉；留着会让下一轮莫名其妙带上前一个元素
      if (selection !== null) dispatch({ kind: 'selection', selection: null })
    } catch (err) {
      dispatch({ kind: 'error', message: messageOf(err) })
    }
  }, [])

  const stop = useCallback(async () => {
    const appId = activeAppIdRef.current
    if (appId === null) return
    try {
      await rpc('chat.stop', { appId })
    } catch (err) {
      dispatch({ kind: 'error', message: messageOf(err) })
    }
  }, [])

  const startPreview = useCallback(async (restart = false) => {
    const appId = activeAppIdRef.current
    if (appId === null) return
    try {
      const result = await rpc('preview.start', { appId, restart })
      dispatch({ kind: 'preview', preview: result.preview })
    } catch (err) {
      dispatch({ kind: 'error', message: messageOf(err) })
    }
  }, [])

  const clearLogs = useCallback(async () => {
    const appId = activeAppIdRef.current
    dispatch({ kind: 'logs.clear' })
    if (appId === null) return
    try {
      await rpc('logs.clear', { appId })
    } catch {
      /* 清不掉只是界面上的事，别弹错 */
    }
  }, [])

  /**
   * 打开某一版看它改了什么。
   *
   * 用 `git.show` 而不是 `git.diff`：后者算的是「从这个 sha 到 HEAD」的累积变化，
   * 在版本列表里点第三个会显示第三个之后的全部改动 —— 看起来像「这一轮改了 8 个文件」。
   */
  const seqRef = useRef(0)
  const showCommit = useCallback(async (sha: string) => {
    const appId = activeAppIdRef.current
    if (appId === null) return
    // 连点两版时，先发的那次可能后回来。用序号丢弃过期结果，否则界面停在错的那一版
    seqRef.current += 1
    const seq = seqRef.current
    dispatch({ kind: 'diff', sha, diff: null })
    dispatch({ kind: 'diff.loading', loading: true })
    try {
      const result = await rpc('git.show', { appId, sha })
      if (seq !== seqRef.current) return
      dispatch({ kind: 'diff', sha: result.commit.sha, diff: result })
    } catch (err) {
      if (seq === seqRef.current) dispatch({ kind: 'error', message: messageOf(err) })
    } finally {
      if (seq === seqRef.current) dispatch({ kind: 'diff.loading', loading: false })
    }
  }, [])

  /**
   * 回滚一版。服务端用 `revert` 语义（产生新的反向提交，历史不丢）。
   *
   * 回滚之后**打开的是那条回滚提交** —— 用户刚做的动作，面板应该跟着它，
   * 而不是停在已经被回滚掉的原提交上（那样看着像什么都没发生）。
   */
  const revertCommit = useCallback(
    async (sha: string, dbRestore = false) => {
      const appId = activeAppIdRef.current
      if (appId === null) return
      dispatch({ kind: 'revert', reverting: true })
      try {
        const result = await rpc('git.revert', { appId, sha, dbRestore })
        await refreshCommits(appId)
        await showCommit(result.commit.sha)
        /*
         * 还原过数据就必须重起预览：服务端为了不刷一屏断连错误先把它停了，
         * 而回滚后的代码本身也要重跑迁移。不 await —— 起预览要几十秒，
         * 让回滚的按钮先停下来，启动进度由预览状态自己推。
         */
        if (result.data.restored) void startPreview()
      } catch (err) {
        dispatch({ kind: 'error', message: messageOf(err) })
      } finally {
        dispatch({ kind: 'revert', reverting: false })
      }
    },
    [refreshCommits, showCommit, startPreview],
  )

  /**
   * 发布：打 tag + 推到本地备份库 + 记一条 release。
   *
   * 失败时**不弹全局错误条**，而是把原因返回给调用方 —— 发布对话框开着的时候，
   * 错误应该出现在对话框里（"工作区还有没提交的改动"这句话离开上下文就没意义了）。
   */
  const publish = useCallback(
    async (notes: string, force?: boolean): Promise<PublishOutcome> => {
      const appId = activeAppIdRef.current
      if (appId === null) return { ok: false, message: '还没有选中应用', code: 'APP_NOT_FOUND', checks: null }
      dispatch({ kind: 'publishing', publishing: true })
      try {
        const trimmed = notes.trim()
        const result = await rpc('release.publish', {
          appId,
          ...(trimmed === '' ? {} : { notes: trimmed }),
          ...(force === true ? { force: true } : {}),
        })
        await refreshReleases(appId)
        return { ok: true, result }
      } catch (err) {
        // `details.checks` 是服务端带上来的那份清单（协议里 `RELEASE_CHECKS_FAILED` 才有）
        const details = err instanceof TenonRpcError ? err.details : undefined
        const checks = (details as { checks?: CheckOutcome[] } | undefined)?.checks ?? null
        return {
          ok: false,
          message: messageOf(err),
          code: err instanceof TenonRpcError ? err.code : 'NETWORK',
          checks,
        }
      } finally {
        dispatch({ kind: 'publishing', publishing: false })
      }
    },
    [refreshReleases],
  )

  /**
   * 发布预检。**不碰全局状态**：它的结果是对话框本地的事，关掉就该消失；
   * 放进 reducer 反而会留下一份"上次检查通过"的残影，让下次打开显得已经查过了。
   */
  const checkRelease = useCallback(async (): Promise<CheckOutcomeResult> => {
    const appId = activeAppIdRef.current
    if (appId === null) return { ok: false, message: '还没有选中应用' }
    try {
      return { ok: true, result: await rpc('release.check', { appId }) }
    } catch (err) {
      return { ok: false, message: messageOf(err) }
    }
  }, [])

  /**
   * 设额度。成功之后服务端会推一次 `usage.update`，这里也直接用返回值换掉快照 ——
   * 不等那一条事件，用户点完「保存」应当立刻看到输入框解锁。
   */
  const setBudget = useCallback(
    async (maxCostUsd: number | null, maxTokens: number | null): Promise<Outcome> => {
      const appId = activeAppIdRef.current
      if (appId === null) return { ok: false, message: '还没有选中应用' }
      try {
        const result = await rpc('budget.set', { appId, maxCostUsd, maxTokens })
        dispatch({ kind: 'budget.set', snapshot: result.snapshot })
        return { ok: true }
      } catch (err) {
        return { ok: false, message: messageOf(err) }
      }
    },
    [],
  )

  const clearError = useCallback(() => dispatch({ kind: 'error', message: null }), [])
  const setSelection = useCallback(
    (selection: SelectionContext | null) => dispatch({ kind: 'selection', selection }),
    [],
  )

  const activeApp = useMemo(
    () => state.apps.find((app) => app.id === state.activeAppId) ?? null,
    [state.apps, state.activeAppId],
  )

  const refreshModel = useCallback(async (): Promise<void> => {
    try {
      const health = await rpc('health', {})
      dispatch({ kind: 'model', model: health.model })
    } catch {
      // 刷新失败不改状态：下一次启动还会再问一次，没必要为它弹一个错误
    }
  }, [])

  return {
    state,
    activeApp,
    selectApp,
    createApp,
    renameApp,
    deleteApp,
    submit,
    stop,
    startPreview,
    clearLogs,
    clearError,
    setSelection,
    showCommit,
    revertCommit,
    publish,
    checkRelease,
    setBudget,
    refreshModel,
  }
}
