/**
 * 历史消息里的工具输出（v1.2.28）。
 *
 * 用户装上 alpha.2 之后的第一句话是"左边所有的命令都没有返回吗？"——
 * 每张工具卡片点开都是空的。查下来不是没存：**数据库里 559 个工具结果每个都有内容**。
 *
 * 真凶有两条（都在这份用例里钉住）：
 *
 * 1. **实时链路**：一条工具调用在日志里是两条 entry（assistant + tool-result），而
 *    `message.end` 是按 entry 发的 —— assistant 那条发出时结果还不存在，所以它带出去的
 *    工具 part 没有 output，**之后也没人回头更新它**。表现就是"这一轮里卡片永远空，
 *    重启应用读一次历史就正常"。
 * 2. **历史读 `viewState`**（给模型压缩过的视图）而不是完整日志 —— 压缩之后工具结果会缺，
 *    而历史要的是"发生过什么"，不是"模型还需要什么"。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScriptStep } from '@tenon/agent'
import { startServer, type RunningServer } from '../src/index.js'

let dir: string
let running: RunningServer | undefined

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(): Promise<RunningServer> {
  return startServer({ port: 0, token: 't', env: { TENON_HOME: dir, TENON_FAUX: '1' } })
}

async function rpc<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`${running?.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { ok: boolean; data?: T; error?: unknown }
  if (!payload.ok) throw new Error(`${method}: ${JSON.stringify(payload.error)}`)
  return payload.data as T
}

async function runTurn(appId: string, script: readonly ScriptStep[], requestId: string): Promise<void> {
  running?.agent.model?.script(script)
  await rpc('chat.submit', { appId, content: `请执行（${requestId}）`, requestId })
  for (let i = 0; i < 80; i += 1) {
    await sleep(150)
    const apps = await rpc<{ apps: Array<{ id: string; status: string }> }>('app.list', {
      includeArchived: false,
    })
    if (apps.apps.find((app) => app.id === appId)?.status !== 'running') return
  }
}

interface History {
  messages: Array<{ id: string; role: string; parts: Array<{ type: string; name?: string; output?: string }> }>
}

function toolOutputs(history: History): string[] {
  return history.messages.flatMap((message) =>
    message.parts.filter((part) => part.type === 'tool').map((part) => part.output ?? ''),
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-history-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
})

/** 读一段 SSE，收集 message.end 的 payload（按消息 id 保留最后一份） */
async function collectMessageEnds(appId: string, until: () => Promise<boolean>): Promise<Map<string, History['messages'][number]>> {
  const response = await fetch(`${running?.url}/events?token=t&appId=${appId}`)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const latest = new Map<string, History['messages'][number]>()
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((item) => item.startsWith('data: '))
      if (line === undefined) continue
      try {
        const payload = JSON.parse(line.slice(6)) as { type?: string; message?: History['messages'][number] }
        if (payload.type === 'message.end' && payload.message !== undefined) {
          latest.set(payload.message.id, payload.message)
        }
      } catch {
        /* 半帧 */
      }
    }
    if (await until()) break
  }
  await reader.cancel().catch(() => undefined)
  return latest
}

describe('chat.history 的工具输出', () => {
  it('工具结果真的会被带进历史（不是"点了详情一片空白"）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>('app.create', { name: '历史' })
    await runTurn(
      app.id,
      [{ tool: 'bash', args: { command: 'echo history-output-ok' } }, { text: '做完了' }],
      'h1',
    )

    const history = await rpc<History>('chat.history', { appId: app.id, limit: 50 })
    expect(toolOutputs(history).join('\n')).toContain('history-output-ok')
  })

  it('★ 压缩之后仍然读得到（`viewState` 会把它裁掉，完整日志不会）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>('app.create', { name: '压缩' })
    await runTurn(
      app.id,
      [{ tool: 'bash', args: { command: 'echo before-compaction' } }, { text: '第一轮' }],
      'c1',
    )

    const session = await running.agent.pool?.acquire(app.id)
    expect(session).toBeDefined()
    // 手动压缩一次：压缩之后模型视图只留摘要 + 尾部，工具结果从视图里消失
    await session!.root.compact(undefined, BACKGROUND_CONTEXT)
    await session!.harness.waitForIdle(BACKGROUND_CONTEXT)
    await sleep(500)

    const history = await rpc<History>('chat.history', { appId: app.id, limit: 50 })
    expect(toolOutputs(history).join('\n')).toContain('before-compaction')
  })
})

describe('实时的工具输出', () => {
  it('★ 工具跑完之后，那条 assistant 消息会被**重推**一次并带上输出', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>('app.create', { name: '实时' })

    // 先挂上 SSE 再跑：要抓的是"同一条消息的第二版"
    const collecting = collectMessageEnds(app.id, async () => done)
    let done = false
    await runTurn(
      app.id,
      [{ tool: 'bash', args: { command: 'echo live-output-ok' } }, { text: '做完了' }],
      'l1',
    )
    await sleep(600)
    done = true
    const messages = await collecting

    const withTool = [...messages.values()].filter((message) =>
      message.parts.some((part) => part.type === 'tool'),
    )
    expect(withTool.length).toBeGreaterThan(0)
    // 关键断言：最终那一版必须有输出。以前的实现里它永远是空字符串。
    const outputs = withTool.flatMap((message) =>
      message.parts.filter((part) => part.type === 'tool').map((part) => part.output ?? ''),
    )
    expect(outputs.join('\n')).toContain('live-output-ok')
  })
})
