/**
 * 服务端集成测试的公共夹具。
 *
 * 这里唯一值得小心的是 `openSse`：SSE 必须**先连上再提交**（DESIGN §4.5 第 4 条），
 * 所以它暴露 `connected` 让调用方等首帧。这段逻辑写错会表现为"偶尔漏掉开头的增量"，
 * 很难查 —— 只留一份实现，别在测试里各写各的。
 */
import type { PreviewManagerOptions } from '@tenon/gateway'
import type { SseEvent } from '@tenon/protocol'
import { startServer, type RunningServer } from '../src/index.js'

export const TEST_TOKEN = 'test-token'

export interface BootOptions {
  env?: NodeJS.ProcessEnv
  preview?: Pick<PreviewManagerOptions, 'launch' | 'installDeps' | 'readyTimeoutMs'>
  /** 给了就由 server 同源托管这份产物（`static.test.ts` 用） */
  webDir?: string
}

export function boot(dir: string, options: BootOptions = {}): Promise<RunningServer> {
  return startServer({
    port: 0,
    token: TEST_TOKEN,
    env: { TENON_HOME: dir, TENON_FAUX: '1', ...(options.env ?? {}) },
    ...(options.preview === undefined ? {} : { preview: options.preview }),
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
  })
}

export async function rpc<T>(
  server: RunningServer,
  method: string,
  input: unknown = {},
): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: unknown }
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

export interface SseClient {
  readonly events: SseEvent[]
  /** 连接建立（收到首帧）后 resolve —— 必须等它，否则会漏掉开头的增量 */
  readonly connected: Promise<void>
  waitFor(predicate: (events: SseEvent[]) => boolean, timeoutMs?: number): Promise<void>
  close(): void
}

export function openSse(server: RunningServer, appId: string): SseClient {
  const events: SseEvent[] = []
  const controller = new AbortController()
  const waiters = new Set<() => void>()
  let connectedResolve: () => void = () => {}
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve
  })

  void (async (): Promise<void> => {
    const response = await fetch(`${server.url}/events?appId=${appId}`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let first = true
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (first) {
        first = false
        connectedResolve()
      }
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine !== undefined) events.push(JSON.parse(dataLine.slice(6)) as SseEvent)
      }
      for (const waiter of [...waiters]) waiter()
    }
  })().catch(() => {
    // 主动 close 会 reject fetch，这不是错误
  })

  return {
    events,
    connected,
    waitFor(predicate, timeoutMs = 20_000) {
      return new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        const timer = setTimeout(() => {
          finish()
          const seen = events.map((event) => event.type).join(', ')
          reject(new Error(`等待 SSE 事件超时；已收到：[${seen}]`))
        }, timeoutMs)
        const check = (): void => {
          if (!predicate(events)) return
          finish()
          resolve()
        }
        waiters.add(check)
        check()
      })
    },
    close() {
      controller.abort()
    },
  }
}
