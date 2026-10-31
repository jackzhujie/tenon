/**
 * SSE 客户端（DESIGN §4.5 / §7.3）。
 *
 * 三条不这么做就会静默出错的规矩：
 *
 * 1. **`EventSource` 只有不带 `event:` 的帧才触发 `onmessage`。** 服务端每条事件都写了
 *    `event: <type>`，所以必须按 `sseEventTypes` 逐个 `addEventListener`。漏一种，
 *    那类事件就静默消失（比如工具卡片永远不出现，而对话照常流）。
 *
 * 2. **不能靠 `EventSource` 的自动重连。** 它重连时不带 `since`，中间那段事件就永久丢了 ——
 *    表现是「断网几秒后回答少了半句」。这里自己接管：断线 → 带 `since=lastSeq` 重连。
 *
 * 3. **先连上再提交。** `onopen` 之后才算可以发请求（服务端建连即写 `: connected`，
 *    浏览器解析到才开始算 open）。调用方按 `state === 'open'` 判断，别自己猜时限。
 */
import type { SseEvent } from '@tenon/protocol'
import { TRANSPORT, sseEventTypes } from '@tenon/protocol/browser'
import { endpointUrl, resolveEndpoint, withToken, type TenonEndpoint } from './transport.js'

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'stopped'

export interface StreamHandlers {
  onEvent(event: SseEvent): void
  onState?(state: StreamState): void
  /** `stream.reset`：本地增量已不可信，调用方应重拉全量（`chat.history`） */
  onReset?(reason: 'gap' | 'server-restart' | 'overflow'): void
}

export interface StreamOptions {
  /** 只收某个应用的事件；不传则收全部（应用切换时不必重连） */
  appId?: string | null
  handlers: StreamHandlers
  /** 每次建连时重算（Electron 可能在建连前才注入 token） */
  endpoint?: () => TenonEndpoint
}

const BASE_DELAY_MS = 300
const MAX_DELAY_MS = 5_000
/** 连续失败这么多次就认定「服务没了」，别再空转 */
const MAX_ATTEMPTS = 8

export class EventStream {
  private source: EventSource | null = null
  private lastSeq = 0
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private state: StreamState = 'stopped'

  constructor(private readonly options: StreamOptions) {}

  /** 已处理到的最大 seq。断线重连与「是否漏事件」的判断都基于它 */
  get cursor(): number {
    return this.lastSeq
  }

  get currentState(): StreamState {
    return this.state
  }

  start(): void {
    if (!this.stopped && this.source !== null) return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.source?.close()
    this.source = null
    this.setState('stopped')
  }

  private endpoint(): TenonEndpoint {
    return this.options.endpoint?.() ?? resolveEndpoint()
  }

  private setState(state: StreamState): void {
    if (this.state === state) return
    this.state = state
    this.options.handlers.onState?.(state)
  }

  private buildUrl(): URL {
    const endpoint = this.endpoint()
    const url = withToken(endpointUrl(endpoint, TRANSPORT.eventsPath), endpoint)
    const appId = this.options.appId
    if (appId !== undefined && appId !== null && appId !== '') url.searchParams.set('appId', appId)
    // 0 表示「从头开始」：服务端把 since=0 当成「没有游标」，不会重放旧缓冲
    if (this.lastSeq > 0) url.searchParams.set('since', String(this.lastSeq))
    return url
  }

  private open(): void {
    if (this.stopped) return
    const es = new EventSource(this.buildUrl())
    this.source = es
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')

    es.onopen = () => {
      this.attempt = 0
      this.setState('open')
    }

    for (const type of sseEventTypes) {
      es.addEventListener(type, (event) => {
        this.consume(type, event as MessageEvent<string>)
      })
    }

    es.onerror = () => {
      // 已经被别的连接替换掉了（重新 open），这个回调直接忽略
      if (this.source !== es) return
      es.close()
      this.source = null
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.attempt += 1
    if (this.attempt > MAX_ATTEMPTS) {
      this.setState('failed')
      return
    }
    this.setState('reconnecting')
    const backoff = Math.min(BASE_DELAY_MS * 2 ** (this.attempt - 1), MAX_DELAY_MS)
    const jitter = Math.floor(Math.random() * 120)
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.open()
    }, backoff + jitter)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private consume(type: string, event: MessageEvent<string>): void {
    let parsed: SseEvent
    try {
      parsed = JSON.parse(event.data) as SseEvent
    } catch {
      // 单条坏帧不该拆掉整条流
      return
    }
    // 重放与并发可能带来重复帧；seq 单调，比它小的一定处理过了
    if (parsed.seq <= this.lastSeq) return
    this.lastSeq = parsed.seq

    if (parsed.type === 'stream.reset') {
      this.options.handlers.onReset?.(parsed.reason)
      return
    }
    if (parsed.type !== type) return
    this.options.handlers.onEvent(parsed)
  }
}
