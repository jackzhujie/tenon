/**
 * 运行日志缓冲（M2 错误面板的服务端一半）。
 *
 * 三个来源汇到这里：子进程的 stdout/stderr（`vite` / `api`）、应用页面自己上报的
 * 异常（`web`）、平台自己的判断（`db` / `tenon`）。缓冲**跟着应用走，不跟着预览跑**：
 * 预览停掉之后用户还要能回看刚才那条报错，这正是错误面板最主要的使用场景。
 *
 * 三条容易做错的地方：
 *
 * 1. **必须剥 ANSI 转义**。Vite 的输出是带颜色的（`\x1b[31m`），原样塞进界面就是一堆
 *    `[2m`、`[22m`。这不是显示瑕疵 —— 用户复制报错去搜索时会被这些字符毁掉。
 * 2. **必须去重合并**。React 渲染里抛错最常见的形态是"同一句错误无限刷"，
 *    一秒几百条足以把面板和 SSE 冲垮。同源同文在 1 秒内合并成一条 `repeat++`。
 * 3. **容量上限按应用算**。全局一个上限时，一个刷屏的应用会把别的应用的日志挤掉。
 */
import type { LogEntry, LogLevel, LogSource } from '@tenon/protocol'

/** 每个应用保留多少条。面板一次最多看 500，留一点余量 */
const DEFAULT_CAP = 400
/** 同一句日志在这个窗口内合并（毫秒） */
const DEDUPE_WINDOW_MS = 1000
/**
 * 堆栈续行并进上一条的时间窗口。
 *
 * 比去重窗口宽得多：摘要行和 `at ...` 之间可能夹着 Nest 自己的输出，
 * 但它们仍然是同一个异常的一部分。
 */
const STACK_WINDOW_MS = 10_000
/** 单条消息上限，防止一个巨大的 JSON 把界面撑爆 */
const MAX_MESSAGE = 2000
const MAX_DETAIL = 8000

/**
 * 堆栈续行：`    at ItemsController.create (/repo/dist-server/x.js:12:34)`。
 *
 * 缩进就是判断依据，所以**必须在去 trim 之前**测 —— `line.trim()` 之后
 * 每一行都长得像普通日志，那就永远合并不了。
 */
const STACK_LINE = /^\s+at\s+\S/

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 去掉 CSI / OSC 序列（Vite、Nest 的输出都带颜色） */
export function stripAnsi(text: string): string {
   
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001B\][^\u0007]*\u0007/g, '')
}

export interface LogInput {
  source: LogSource
  level: LogLevel
  message: string
  detail?: string | null
}

/**
 * 一条子进程输出是什么级别。
 *
 * 不能只看"是不是 stderr"：Vite 把普通提示也写 stderr，而 Nest 的错误有时又落在 stdout。
 * 先认内容里的强信号，再退回按流判断 —— 这样 `error` 徽标才有意义。
 */
export function classifyLine(line: string, stream: 'stdout' | 'stderr'): LogLevel {
  const text = stripAnsi(line).trim()
  if (/^(error|err!|✘|✗|\[error\])/i.test(text)) return 'error'
  if (/\b(uncaught|unhandled|exception|ECONNREFUSED|EADDRINUSE|failed to|traceback)\b/i.test(text)) {
    return 'error'
  }
  if (/^(warn|warning|⚠|\[warn\])/i.test(text) || /\bdeprecat(ed|ion)\b/i.test(text)) return 'warn'
  return stream === 'stderr' ? 'error' : 'info'
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (truncated, source was ${text.length} chars)`
}

/** 这一行是不是堆栈的一部分（`    at foo (...)`） */
export function isStackLine(line: string): boolean {
  return STACK_LINE.test(stripAnsi(line))
}

function messageOfError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class LogStore {
  private readonly byApp = new Map<string, LogEntry[]>()
  private seq = 0

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  /**
   * 追加一条。返回**生效的那条**：新条目是新对象，合并时是原对象（`id` 不变）。
   * 调用方拿它去发 `app.log` —— id 稳定，前端才能做 upsert 而不是无脑追加。
   */
  add(appId: string, input: LogInput, now: number = Date.now()): LogEntry {
    const message = clamp(
      stripAnsi(input.message).trim() === '' ? '[empty log]' : stripAnsi(input.message).trim(),
      MAX_MESSAGE,
    )
    const detail = input.detail == null || input.detail === '' ? null : clamp(input.detail, MAX_DETAIL)
    const list = this.byApp.get(appId) ?? []

    const last = list.at(-1)
    if (
      last !== undefined &&
      last.source === input.source &&
      last.level === input.level &&
      last.message === message &&
      last.detail === detail &&
      now - last.at <= DEDUPE_WINDOW_MS
    ) {
      // 原地替换：数组里的位置不动，面板按 id upsert 时也不会跳行
      const merged: LogEntry = { ...last, repeat: last.repeat + 1 }
      list[list.length - 1] = merged
      this.byApp.set(appId, list)
      return merged
    }

    this.seq += 1
    const entry: LogEntry = {
      id: `log-${this.seq}`,
      appId,
      at: now,
      source: input.source,
      level: input.level,
      message,
      detail,
      repeat: 1,
    }
    list.push(entry)
    if (list.length > this.cap) list.splice(0, list.length - this.cap)
    this.byApp.set(appId, list)
    return entry
  }

  /**
   * 吃一行子进程输出（stdout/stderr 的每一行）。
   *
   * 和 `add` 的区别只有一条：**堆栈的第二行起不是新日志，是上一条的 detail**。
   * 不并的话，一个异常会在面板里变成三十条缩进的 `at ...`，真正的那句摘要被冲走 ——
   * 这也是"日志面板看着有内容却没法排查"的最常见原因。
   *
   * 返回的条目 `id` 与上一条相同：前端按 id upsert，界面上还是一条，只是能展开看堆栈。
   */
  addLine(
    appId: string,
    source: LogSource,
    level: LogLevel,
    line: string,
    now: number = Date.now(),
  ): LogEntry {
    if (isStackLine(line)) {
      const list = this.byApp.get(appId) ?? []
      const last = list.at(-1)
      if (
        last !== undefined &&
        last.source === source &&
        LEVEL_RANK[last.level] >= LEVEL_RANK.warn &&
        now - last.at <= STACK_WINDOW_MS
      ) {
        const frame = stripAnsi(line).trim()
        const detail = last.detail === null ? frame : `${last.detail}\n${frame}`
        const merged: LogEntry = { ...last, detail: clamp(detail, MAX_DETAIL) }
        list[list.length - 1] = merged
        this.byApp.set(appId, list)
        return merged
      }
    }
    return this.add(appId, { source, level, message: line }, now)
  }

  /** 从最新往回数 `limit` 条；过滤在服务端做，免得把 500 条全传过去再筛 */  list(
    appId: string,
    options: { limit?: number; sources?: LogSource[]; minLevel?: LogLevel } = {},
  ): LogEntry[] {
    const all = this.byApp.get(appId) ?? []
    const minRank = options.minLevel === undefined ? 0 : LEVEL_RANK[options.minLevel]
    const filtered = all.filter((entry) => {
      if (options.sources !== undefined && !options.sources.includes(entry.source)) return false
      return LEVEL_RANK[entry.level] >= minRank
    })
    const limit = options.limit ?? filtered.length
    return filtered.slice(-limit)
  }

  /** 清空一个应用；返回清掉了多少条（界面要说"清空了 n 条"，不然像卡住了） */
  clear(appId: string): number {
    const count = this.byApp.get(appId)?.length ?? 0
    this.byApp.delete(appId)
    return count
  }

  /** 删应用时丢掉缓冲，别让已删应用的日志留着占内存 */
  drop(appId: string): void {
    this.byApp.delete(appId)
  }

  size(appId: string): number {
    return this.byApp.get(appId)?.length ?? 0
  }

  /** 排障用：哪个应用攒了多少条 */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.byApp].map(([appId, list]) => [appId, list.length]))
  }
}

/**
 * 应用页面 POST 上来的日志。**形状是外部输入**，必须防御性解析：
 * 它来自生成应用的源码，可能是 Agent 手写的、也可能是被改坏的。
 */
export function parseClientLog(raw: unknown): LogInput | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const message = typeof record['message'] === 'string' ? record['message'] : null
  if (message === null || message.trim() === '') return null

  const source = record['source']
  const level = record['level']
  const detail = record['detail']
  return {
    source:
      source === 'web' || source === 'api' || source === 'vite' || source === 'db' || source === 'tenon'
        ? source
        : 'web',
    level:
      level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'error',
    message,
    detail:
      typeof detail === 'string'
        ? detail
        : detail === undefined || detail === null
          ? null
          : JSON.stringify(detail),
  }
}

/** 把异常变成一条日志输入（`detail` 带堆栈）。网关内部自用 */
export function inputFromError(source: LogSource, err: unknown, prefix = ''): LogInput {
  const message = `${prefix}${messageOfError(err)}`
  const detail = err instanceof Error && typeof err.stack === 'string' ? err.stack : null
  return { source, level: 'error', message, detail }
}
