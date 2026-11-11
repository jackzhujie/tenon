/**
 * 全局额度（两道闸）的集成测试。
 *
 * 与 `budget.test.ts` 一样，额度一律用 **token** 来验：`faux` 的 `cost.total` 恒为 0，
 * 用美元断言永远成立（也就是永远验不出拦没拦）。
 *
 * 这一层要回答的问题，纯函数测试回答不了：
 * 1. 拦的是**所有应用**，不是"当前这个" —— 换一个应用继续发也要被拒
 * 2. 两道闸确实分开：月度会重置、总量不会，文案也必须不同
 * 3. 改上限**不会**把本月用量归零（月初基线与额度是两条记录）
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SseEvent, UsageTotals } from '@tenon/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { TEST_TOKEN, boot, openSse, rpc as rpcSupport } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-global-budget-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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

async function createApp(server: RunningServer, name: string): Promise<string> {
  const { app } = await call<{ app: { id: string } }>(server, 'app.create', { name })
  return app.id
}

async function runTurn(server: RunningServer, appId: string, requestId: string): Promise<SseEvent[]> {
  const sse = openSse(server, appId)
  await sse.connected
  await call(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events) => events.some((event) => event.type === 'app.status' && event.status === 'idle'))
  sse.close()
  return sse.events
}

interface GlobalStatus {
  budget: { monthly: { maxCostUsd: number | null; maxTokens: number | null }; lifetime: { maxCostUsd: number | null; maxTokens: number | null } }
  month: string
  monthUsed: UsageTotals
  totalUsed: UsageTotals
  unreadable: number
}

const NO_LIMIT = { maxCostUsd: null, maxTokens: null }

async function setGlobal(
  server: RunningServer,
  monthly: { maxCostUsd?: number | null; maxTokens?: number | null },
  lifetime: { maxCostUsd?: number | null; maxTokens?: number | null } = {},
): Promise<void> {
  await call(server, 'budget.global.set', {
    monthly: { ...NO_LIMIT, ...monthly },
    lifetime: { ...NO_LIMIT, ...lifetime },
  })
}

describe('全局额度（月度 + 总量）', () => {
  it('★ 拦的是所有应用：A 用完额度之后，换 B 发也一样被拒', async () => {
    const server = await bootServer()
    const appA = await createApp(server, '甲')
    const appB = await createApp(server, '乙')

    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appA, 'g1')

    // 全局月度上限设成"比已经花掉的还少"，等价于"这个月用完了"
    await setGlobal(server, { maxTokens: 1 })

    const error = await failure(server, 'chat.submit', { appId: appB, content: '再来', requestId: 'g2' })
    expect(error.code).toBe('BUDGET_EXCEEDED')
    // 换了个应用也发不出去 —— 这才是"总闸"，单应用额度做不到这件事
    expect(error.message).toContain('本月总额度用完了')
  })

  it('单应用额度没设、全局设了：拦在全局那道闸上', async () => {
    const server = await bootServer()
    const appId = await createApp(server, '单应用没限')

    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'h1')
    await setGlobal(server, { maxTokens: 1 })

    // 单应用额度仍是"不设限"，所以拒绝只可能来自全局
    const snapshot = await call<{ snapshot: { budget: { maxTokens: number | null } } }>(server, 'usage.get', { appId })
    expect(snapshot.snapshot.budget.maxTokens).toBeNull()

    const error = await failure(server, 'chat.submit', { appId, content: '再来', requestId: 'h2' })
    expect(error.code).toBe('BUDGET_EXCEEDED')
  })

  it('两道闸都撞上时报"总量"：因为月度那句"下月 1 日重置"是假的', async () => {
    const server = await bootServer()
    const appId = await createApp(server, '双闸')

    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'i1')

    await setGlobal(server, { maxTokens: 1 }, { maxTokens: 1 })

    const error = await failure(server, 'chat.submit', { appId, content: '再来', requestId: 'i2' })
    expect(error.code).toBe('BUDGET_EXCEEDED')
    // 报总量，且明确说它不会按月份解开
    expect(error.message).toContain('总额度用完了')
    expect(error.message).toContain('不会按月份重置')
  })

  it('两条都不设 = 不拦（默认行为不该拦人）', async () => {
    const server = await bootServer()
    const appId = await createApp(server, '不设限')

    server.agent.model?.script([{ text: '第一轮' }, { text: '第二轮' }])
    await runTurn(server, appId, 'j1')
    // 没有设任何全局额度，第二轮照常发得出去
    await runTurn(server, appId, 'j2')

    const status = await call<GlobalStatus>(server, 'budget.global')
    expect(status.budget.monthly).toEqual(NO_LIMIT)
    expect(status.budget.lifetime).toEqual(NO_LIMIT)
  })

  it('★ 改上限不会把本月用量归零（基线与额度是两条记录）', async () => {
    const server = await bootServer()
    const appId = await createApp(server, '改上限')

    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'k1')

    const before = await call<GlobalStatus>(server, 'budget.global')
    expect(before.monthUsed.totalTokens).toBeGreaterThan(0)

    // 把上限从一个值改成另一个值：基线不该被冲掉，于是"本月已用"保持不变
    await setGlobal(server, { maxTokens: 10_000_000 })
    const after = await call<GlobalStatus>(server, 'budget.global')

    expect(after.monthUsed.totalTokens).toBe(before.monthUsed.totalTokens)
    expect(after.budget.monthly.maxTokens).toBe(10_000_000)
    // 基线所在的月份没变
    expect(after.month).toBe(before.month)
  })

  it('status 里的 monthUsed 是差值、totalUsed 是累计 —— 两个数不是一回事', async () => {
    const server = await bootServer()
    const appId = await createApp(server, '差值')

    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'l1')

    const status = await call<GlobalStatus>(server, 'budget.global')
    // 本月还没跨月，所以两个数此刻相等；但字段必须都在（面板分别用它们）
    expect(status.totalUsed.totalTokens).toBeGreaterThan(0)
    expect(status.monthUsed.totalTokens).toBe(status.totalUsed.totalTokens)
    expect(status.unreadable).toBe(0)
  })

  it('总量闸单独生效：月度没设、总量设成极小', async () => {
    const server = await bootServer()
    const appId = await createApp(server, '只卡总量')

    server.agent.model?.script([{ text: '收到。' }])
    await runTurn(server, appId, 'm1')
    await setGlobal(server, {}, { maxTokens: 1 })

    const error = await failure(server, 'chat.submit', { appId, content: '再来', requestId: 'm2' })
    expect(error.code).toBe('BUDGET_EXCEEDED')
    expect(error.message).toContain('总额度用完了')
  })
})
