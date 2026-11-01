/**
 * 用量与预算熔断（M4 第 3 步）。
 *
 * 这一层能验的东西和纯函数测试不一样：**账本真的会累加、跨重启真的不丢、
 * 拦真的拦在 `chat.submit` 上、熔断真的会在半路把这一轮掐掉**。
 *
 * 两个刻意的选择：
 * 1. 额度一律用 **token** 来验，不用美元 —— `faux` 的 `cost.total` 恒为 0
 *    （本地假模型不报价）。这也是产品里两个维度都要的原因。
 * 2. 中途熔断只断言"事件到了、状态回 idle、下一轮还能发"，**不断言停在第几句**：
 *    模型响应与 abort 是并发的，钉死位置会得到一个偶发失败的测试。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SseEvent, UsageSnapshot } from '@tenon/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { TEST_TOKEN, boot, openSse, rpc as rpcSupport } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-budget-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

async function bootServer(): Promise<RunningServer> {
  running = await boot(dir)
  return running
}

async function call<T>(server: RunningServer, method: string, input: unknown = {}): Promise<T> {
  return rpcSupport<T>(server, method, input)
}

async function failure(
  server: RunningServer,
  method: string,
  input: unknown = {},
): Promise<{ code: string; message: string }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; error?: { code: string; message: string } }
  if (body.ok) throw new Error(`${method} 本该失败，却成功了`)
  if (body.error === undefined) throw new Error(`${method} 失败了但没有 error 字段`)
  return body.error
}

async function createApp(server: RunningServer, name = '用量'): Promise<string> {
  const { app } = await call<{ app: { id: string } }>(server, 'app.create', { name })
  return app.id
}

/** 跑一轮，等到 `app.status: idle`（这一轮真正落定），返回收到的事件 */
async function runTurn(server: RunningServer, appId: string, requestId: string): Promise<SseEvent[]> {
  const sse = openSse(server, appId)
  await sse.connected
  await call(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events) => events.some((event) => event.type === 'app.status' && event.status === 'idle'))
  sse.close()
  return sse.events
}

async function usageOf(server: RunningServer, appId: string): Promise<UsageSnapshot> {
  const { snapshot } = await call<{ snapshot: UsageSnapshot }>(server, 'usage.get', { appId })
  return snapshot
}

describe('账本', () => {
  it('跑完一轮就有量：token 上涨、成本为 0（faux 不报价）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '收到。' }])

    expect((await usageOf(server, appId)).totals.totalTokens).toBe(0)

    await runTurn(server, appId, 'u1')
    const snapshot = await usageOf(server, appId)

    expect(snapshot.totals.totalTokens).toBeGreaterThan(0)
    expect(snapshot.totals.input).toBeGreaterThan(0)
    // faux 的 cost 恒为 0 —— 所以"只按美元拦"在本地一条都验不了
    expect(snapshot.totals.costUsd).toBe(0)
    // 按模型分桶用的是 `provider/modelId`
    expect(Object.keys(snapshot.models)).toContain('faux/faux-mini')
    expect(snapshot.level).toBe('ok')
  })

  it('★ 跨重启不丢（真值是会话账本，不是内存计数器）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'u1')
    const before = (await usageOf(server, appId)).totals.totalTokens
    expect(before).toBeGreaterThan(0)

    await server.close()
    const again = await bootServer()
    const after = (await usageOf(again, appId)).totals.totalTokens
    expect(after).toBe(before)
    // 重启之后"这一轮"应该是 0：本轮是相对上一轮起点的差值
    expect((await usageOf(again, appId)).turn.totalTokens).toBe(0)
  })

  it('`turn` 只算本轮：第二轮之后不等于累计', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '一。' }])
    await runTurn(server, appId, 'u1')
    const first = (await usageOf(server, appId)).turn.totalTokens
    expect(first).toBeGreaterThan(0)

    server.agent.model?.script([{ text: '二。' }])
    await runTurn(server, appId, 'u2')
    const snapshot = await usageOf(server, appId)
    expect(snapshot.turn.totalTokens).toBeGreaterThan(0)
    expect(snapshot.turn.totalTokens).toBeLessThan(snapshot.totals.totalTokens)
  })

  it('服务端在生成过程中就会推 `usage.update`（面板不必等到结束）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '收到。' }])
    const events = await runTurn(server, appId, 'u1')
    const updates = events.filter((event) => event.type === 'usage.update')
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)?.snapshot.totals.totalTokens).toBeGreaterThan(0)
  })
})

describe('额度', () => {
  it('设了能读回来，清空也能', async () => {
    const server = await bootServer()
    const appId = await createApp(server)

    const saved = await call<{ snapshot: UsageSnapshot }>(server, 'budget.set', {
      appId,
      maxTokens: 50_000,
      maxCostUsd: 2.5,
    })
    expect(saved.snapshot.budget).toEqual({ maxTokens: 50_000, maxCostUsd: 2.5 })

    const cleared = await call<{ snapshot: UsageSnapshot }>(server, 'budget.set', { appId })
    expect(cleared.snapshot.budget).toEqual({ maxTokens: null, maxCostUsd: null })
  })

  it('★ 用完之后 `chat.submit` 直接拒（BUDGET_EXCEEDED / 402），且没有偷偷开跑', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'u1')

    // 上限 1 token：当前已经远超它
    const { snapshot } = await call<{ snapshot: UsageSnapshot }>(server, 'budget.set', {
      appId,
      maxTokens: 1,
    })
    expect(snapshot.level).toBe('over')
    expect(snapshot.exceeded).toBe('tokens')

    const error = await failure(server, 'chat.submit', { appId, content: '还能发吗', requestId: 'u2' })
    expect(error.code).toBe('BUDGET_EXCEEDED')
    expect(error.message).toContain('额度用完了')

    // 应用状态没有被这一轮改成 running
    const { apps } = await call<{ apps: Array<{ id: string; status: string }> }>(server, 'app.list', {})
    expect(apps.find((app) => app.id === appId)?.status).toBe('idle')
  })

  it('调高上限之后马上能继续（不用重启）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'u1')
    await call(server, 'budget.set', { appId, maxTokens: 1 })
    expect((await failure(server, 'chat.submit', { appId, content: 'x', requestId: 'u2' })).code).toBe(
      'BUDGET_EXCEEDED',
    )

    await call(server, 'budget.set', { appId, maxTokens: 10_000_000 })
    server.agent.model?.script([{ text: '这下可以了。' }])
    const events = await runTurn(server, appId, 'u3')
    expect(events.some((event) => event.type === 'message.end')).toBe(true)
  })
})

describe('中途熔断', () => {
  it('★ 一轮里把额度冲爆：推 `budget.exceeded` 并停下来', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '先花一点。' }])
    await runTurn(server, appId, 'u1')
    const used = (await usageOf(server, appId)).totals.totalTokens

    // 只多给 1 个 token：提交放得过去（还没到线），但第一条响应之后必然冲过
    await call(server, 'budget.set', { appId, maxTokens: used + 1 })
    expect((await usageOf(server, appId)).level).not.toBe('over')

    server.agent.model?.script([
      { tool: 'read', args: { path: 'package.json' } },
      { tool: 'read', args: { path: 'package.json' } },
      { tool: 'read', args: { path: 'package.json' } },
      { text: '跑完了。' },
    ])
    const events = await runTurn(server, appId, 'u2')

    const exceeded = events.find((event) => event.type === 'budget.exceeded')
    expect(exceeded).toBeDefined()
    expect(exceeded?.type === 'budget.exceeded' ? exceeded.dimension : null).toBe('tokens')

    // 先解释、再放开输入框：`budget.exceeded` 必须在 idle 之前到 ——
    // 反过来的话，用户看到的是一个"莫名其妙停了"的界面
    const exceededAt = events.findIndex((event) => event.type === 'budget.exceeded')
    const idleAt = events.findIndex((event) => event.type === 'app.status' && event.status === 'idle')
    expect(idleAt).toBeGreaterThan(exceededAt)
    expect(await usageOf(server, appId)).toMatchObject({ level: 'over' })
  })

  it('没有额度时不会误触：跑完一轮也不会推 `budget.exceeded`', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    server.agent.model?.script([{ text: '收到。' }])
    const events = await runTurn(server, appId, 'u1')
    expect(events.some((event) => event.type === 'budget.exceeded')).toBe(false)
  })
})

describe('删应用', () => {
  /**
   * 这条钉住一个真实的坑：`app.delete` 早先调的是 `chat.close()`，
   * 那会把 ChatService 的 `closed` 置上 —— 之后**所有**应用的 `app.status`
   * 都不再落库也不再推事件，界面永远转圈，而日志里一个字都没有。
   */
  it('删掉一个应用，别的应用的对话还能正常跑完', async () => {
    const server = await bootServer()
    const victim = await createApp(server, '要被删的')
    const keeper = await createApp(server, '要留着的')

    await call(server, 'app.delete', { id: victim, removeFiles: true })

    server.agent.model?.script([{ text: '我还在。' }])
    const events = await runTurn(server, keeper, 'k1')
    expect(events.some((event) => event.type === 'message.end')).toBe(true)
    expect(events.some((event) => event.type === 'app.status' && event.status === 'idle')).toBe(true)
  })

  it('应用删掉时它的额度也一起走', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await call(server, 'budget.set', { appId, maxTokens: 1234 })
    await call(server, 'app.delete', { id: appId, removeFiles: true })
    const { values } = await call<{ values: Record<string, unknown> }>(server, 'settings.get', {})
    expect(values[`budget.app.${appId}`]).toBeUndefined()
  })
})
