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
  GitCommit,
  LogEntry,
  NormalizedMessage,
  PreviewStatus,
  Release,
  RpcOutput,
  SelectionContext,
  SseEvent,
  TemplateInfo,
} from '@tenon/protocol'
import { rpc, TenonRpcError } from '../lib/rpc.js'
import { EventStream, type StreamState } from '../lib/stream.js'

export interface ToolActivity {
  toolCallId: string
  name: string
  args: Record<string, unknown> | undefined
  output: string
  status: 'running' | 'ok' | 'error'
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

export type PublishOutcome =
  | { ok: true; result: PublishResult }
  | { ok: false; message: string }

export interface UsageInfo {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

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
  usage: UsageInfo | null
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
  selection: null,
  diff: null,
  viewingSha: null,
  diffLoading: false,
  reverting: false,
  releases: [],
  publishing: false,
  stream: 'stopped',
  usage: null,
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
  | { kind: 'select'; appId: string | null }
  | { kind: 'history'; messages: NormalizedMessage[] }
  | { kind: 'commits'; commits: GitCommit[] }
  | { kind: 'logs'; logs: LogEntry[] }
  | { kind: 'logs.clear' }
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

/** 流式气泡的固定 id：pi 的 assistant entry id 在 `message_end` 之前不存在 */
const LIVE = 'live'

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

    case 'preview.ready':
      return state.preview === null
        ? state
        : { ...state, preview: { ...state.preview, state: 'ready', url: event.url, readiness: event.readiness } }

    case 'git.commit':
      // 列表靠 `git.log` 重拉，这里只用来触发刷新（由调用方处理）
      return state

    case 'usage':
      return {
        ...state,
        usage: {
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
        },
      }

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
        usage: null,
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
      return { ...state, messages: [...state.messages, action.message], submitting: true, error: null }
    case 'submit.start':
      return { ...state, submitting: true, error: null }
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
  deleteApp(appId: string): Promise<void>
  submit(content: string): Promise<void>
  stop(): Promise<void>
  startPreview(restart?: boolean): Promise<void>
  clearLogs(): Promise<void>
  setSelection(selection: SelectionContext | null): void
  /** 打开某一版看它改了什么（`git.show`） */
  showCommit(sha: string): Promise<void>
  /**
   * 回滚某一版（`revert`：产生新的反向提交，历史保留）。
   * `dbRestore` 为真时把库一起还原到这一版之前（服务端会先停预览）。
   */
  revertCommit(sha: string, dbRestore?: boolean): Promise<void>
  /** 发布（`release.publish`）。失败的原因返回给调用方，由对话框就地显示 */
  publish(notes: string): Promise<PublishOutcome>
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
        ])
        if (!cancelled) dispatch({ kind: 'preview', preview: preview.preview })
      } catch (err) {
        if (!cancelled) dispatch({ kind: 'error', message: messageOf(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.activeAppId, refreshHistory, refreshCommits, refreshLogs, refreshReleases])

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
        },
      },
    })
    streamRef.current = stream
    stream.start()

    return () => {
      stream.stop()
      if (streamRef.current === stream) streamRef.current = null
    }
  }, [state.activeAppId, refreshCommits, refreshHistory, refreshLogs])

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

  const deleteApp = useCallback(
    async (appId: string) => {
      try {
        await rpc('app.delete', { id: appId, removeFiles: true })
        const apps = await rpc('app.list', { includeArchived: false })
        dispatch({ kind: 'apps', apps: apps.apps })
        if (activeAppIdRef.current === appId) {
          dispatch({ kind: 'select', appId: apps.apps[0]?.id ?? null })
        }
      } catch (err) {
        dispatch({ kind: 'error', message: messageOf(err) })
      }
    },
    [],
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
    async (notes: string): Promise<PublishOutcome> => {
      const appId = activeAppIdRef.current
      if (appId === null) return { ok: false, message: '还没有选中应用' }
      dispatch({ kind: 'publishing', publishing: true })
      try {
        const trimmed = notes.trim()
        const result = await rpc('release.publish', {
          appId,
          ...(trimmed === '' ? {} : { notes: trimmed }),
        })
        await refreshReleases(appId)
        return { ok: true, result }
      } catch (err) {
        return { ok: false, message: messageOf(err) }
      } finally {
        dispatch({ kind: 'publishing', publishing: false })
      }
    },
    [refreshReleases],
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

  return {
    state,
    activeApp,
    selectApp,
    createApp,
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
  }
}
