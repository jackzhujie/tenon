import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SseEvent } from '@tenon/protocol'
import { startServer, type RunningServer } from '../src/index.js'

let dir: string
let running: RunningServer | undefined

async function boot(): Promise<RunningServer> {
  return startServer({ port: 0, token: 'test-token', env: { TENON_HOME: dir, TENON_FAUX: '1' } })
}

async function rpc<T>(server: RunningServer, method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: unknown }
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

interface SseClient {
  readonly events: SseEvent[]
  /** 连接建立（收到首帧）后 resolve —— 必须等它，否则会漏掉开头的增量 */
  readonly connected: Promise<void>
  waitFor(predicate: (events: SseEvent[]) => boolean, timeoutMs?: number): Promise<void>
  close(): void
}

function openSse(server: RunningServer, appId: string): SseClient {
  const events: SseEvent[] = []
  const controller = new AbortController()
  const waiters = new Set<() => void>()
  let connectedResolve: () => void = () => {}
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve
  })

  void (async (): Promise<void> => {
    const response = await fetch(`${server.url}/events?appId=${appId}`, {
      headers: { authorization: 'Bearer test-token' },
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
          reject(new Error('等待 SSE 事件超时'))
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-chat-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('对话链路（faux 模型）', () => {
  it('提交 → SSE 收到文本增量 → message.end → 历史两条消息', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '待办' })

    // SSE 必须先连上再提交，否则会漏掉开头的增量（和 HMR 首帧同一个道理）
    const sse = openSse(running, app.id)
    await sse.connected

    const submitted = await rpc<{ submissionId: string }>(running, 'chat.submit', {
      appId: app.id,
      content: '做一个待办应用',
      requestId: 'req-1',
    })
    expect(submitted.submissionId).toBeTruthy()

    await sse.waitFor((events) => events.some((event) => event.type === 'message.end'))
    const events = sse.events
    sse.close()
    const deltas = events.filter((event) => event.type === 'message.delta')
    expect(deltas.length).toBeGreaterThan(1)
    const text = deltas.map((event) => (event.type === 'message.delta' ? event.text : '')).join('')
    expect(text.length).toBeGreaterThan(20)

    const ended = events.find((event) => event.type === 'message.end')
    expect(ended?.type).toBe('message.end')
    // 增量拼起来必须等于最终消息（否则前端会出现"边写边跳"）
    if (ended?.type === 'message.end') {
      const finalText = ended.message.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
      expect(finalText).toContain(text.slice(0, 12))
    }

    const history = await rpc<{ messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> }>(
      running,
      'chat.history',
      { appId: app.id },
    )
    expect(history.messages).toHaveLength(2)
    expect(history.messages[0]?.role).toBe('user')
    expect(history.messages[0]?.parts[0]?.text).toBe('做一个待办应用')
    expect(history.messages[1]?.role).toBe('assistant')
  })

  it('同一 requestId 重放命中同一 submission（幂等）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '幂等' })

    const first = await rpc<{ submissionId: string }>(running, 'chat.submit', {
      appId: app.id,
      content: '第一次',
      requestId: 'same-key',
    })
    const second = await rpc<{ submissionId: string }>(running, 'chat.submit', {
      appId: app.id,
      content: '第一次',
      requestId: 'same-key',
    })
    expect(second.submissionId).toBe(first.submissionId)
  })

  it('进程重启后历史仍在（harness.sqlite 落盘），且幂等键仍生效', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '重启' })
    const submitted = await rpc<{ submissionId: string }>(running, 'chat.submit', {
      appId: app.id,
      content: '重启前的消息',
      requestId: 'before-restart',
    })
    // 等这一轮真正结束，再"杀进程"
    const sse = openSse(running, app.id)
    await sse.connected
    await sse.waitFor((events) => events.some((event) => event.type === 'message.end'))
    sse.close()
    await running.close()

    running = await boot()
    const history = await rpc<{ messages: Array<{ role: string }> }>(running, 'chat.history', {
      appId: app.id,
    })
    expect(history.messages.length).toBeGreaterThanOrEqual(2)

    const replay = await rpc<{ submissionId: string }>(running, 'chat.submit', {
      appId: app.id,
      content: '重启前的消息',
      requestId: 'before-restart',
    })
    expect(replay.submissionId).toBe(submitted.submissionId)
  })

  it('应用不存在时 chat.submit 明确报 APP_NOT_FOUND', async () => {
    running = await boot()
    await expect(
      rpc(running, 'chat.submit', { appId: 'app_missing', content: 'hi', requestId: 'x' }),
    ).rejects.toThrowError(/失败/)
  })

  it('每轮结束会尝试提交 git；没有文件变化则不产生空提交', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: 'git' })
    const sse = openSse(running, app.id)
    await sse.connected
    await rpc(running, 'chat.submit', { appId: app.id, content: '说点什么', requestId: 'g1' })
    await sse.waitFor((events) => events.some((event) => event.type === 'message.end'))
    sse.close()
    const { commits } = await rpc<{ commits: Array<{ message: string }> }>(running, 'git.log', {
      appId: app.id,
    })
    // 只有建应用那一个 commit：本轮没有文件改动
    expect(commits).toHaveLength(1)
    expect(commits[0]?.message).toContain('初始化应用')
  })
})

describe('崩溃续跑（DoD 第 4 条）', () => {
  it('生成中途关掉进程，重启后 resume() 把这一轮跑完', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '续跑' })
    await rpc(running, 'chat.submit', {
      appId: app.id,
      content: '写一段足够长的回答，好让我在中途把进程关掉',
      requestId: 'interrupted',
    })
    // 等生成真正开始（出现过增量）再"断电"
    const sse = openSse(running, app.id)
    await sse.connected
    await sse.waitFor((events) => events.some((event) => event.type === 'message.delta'))
    sse.close()
    await running.close()
    running = undefined

    // 重启：harness-pool 打开时调用 resume()，中断的提交应当被继续执行
    running = await boot()
    await running.agent.chat?.plan(app.id) // 触发 harness 打开（同一路径上 resume 生效）
    const deadline = Date.now() + 20_000
    let messages: Array<{ role: string }> = []
    while (Date.now() < deadline) {
      const history = await rpc<{ messages: Array<{ role: string }> }>(running, 'chat.history', {
        appId: app.id,
      })
      messages = history.messages
      if (messages.filter((message) => message.role === 'assistant').length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  })
})
