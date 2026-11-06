/**
 * 跨应用用量汇总（`usage.total`，v1.2.17）。
 *
 * 这一层要验的是"加起来对不对、边界有没有被装成 0"：
 *
 * 1. **合计 = 各应用账本之和**，且每一行与那个应用自己的 `usage.get` 一致
 *    （两边同源，对不上就说明有人在中间算了一遍）
 * 2. **没跑过一轮的应用**：`known: false` —— 它的 0 不是"花了 0"，
 *    而且要**不计入合计**的语义下去看（它会加 0，但界面上不能显示成 0.00）
 * 3. **应用被删**：它不该继续出现在汇总里（否则合计会永远挂着一笔幽灵花费）
 *
 * 金额维度不在这里验：`faux` 恒报 0 美元，按金额断言等于断言"0 == 0"。
 * 汇总的钱那一格走的是与 `usage.get` 同一个 `priced` 判断，已在 budget 测试里验过。
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SseEvent, UsageAppUsage, UsageSnapshot, UsageTotals } from '@tenon/protocol'
import { appPaths, resolveHome } from '@tenon/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { boot, openSse, rpc as rpcSupport } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-usage-total-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

async function call<T>(server: RunningServer, method: string, input: unknown = {}): Promise<T> {
  return rpcSupport<T>(server, method, input)
}

async function createApp(server: RunningServer, name: string): Promise<string> {
  const { app } = await call<{ app: { id: string } }>(server, 'app.create', { name })
  return app.id
}

/** 跑一轮，等到 `app.status: idle`（这一轮真正落定） */
async function runTurn(server: RunningServer, appId: string, requestId: string, text: string): Promise<void> {
  server.agent.model?.script([{ text }])
  const sse = openSse(server, appId)
  await sse.connected
  await call(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events: SseEvent[]) =>
    events.some((event) => event.type === 'app.status' && event.status === 'idle'),
  )
  sse.close()
}

interface Total {
  totals: UsageTotals
  apps: UsageAppUsage[]
  failed: Array<{ appId: string; name: string; error: string }>
  priced: boolean
  generatedAt: number
}

async function totalOf(server: RunningServer): Promise<Total> {
  return call<Total>(server, 'usage.total', {})
}

async function usageOf(server: RunningServer, appId: string): Promise<UsageSnapshot> {
  const { snapshot } = await call<{ snapshot: UsageSnapshot }>(server, 'usage.get', { appId })
  return snapshot
}

describe('跨应用用量汇总', () => {
  it('★ 合计就是各应用账本之和，每一行与它自己的 usage.get 一致', async () => {
    running = await boot(dir)
    const server = running
    const first = await createApp(server, '第一个')
    const second = await createApp(server, '第二个')

    await runTurn(server, first, 'u1', '收到一。')
    await runTurn(server, second, 'u2', '收到二。')

    const firstUsage = await usageOf(server, first)
    const secondUsage = await usageOf(server, second)
    expect(firstUsage.totals.totalTokens).toBeGreaterThan(0)
    expect(secondUsage.totals.totalTokens).toBeGreaterThan(0)

    const total = await totalOf(server)
    expect(total.apps).toHaveLength(2)
    expect(total.failed).toEqual([])

    // 行与各自 usage.get 同源：对不上就说明中间有人又算了一遍
    const rowOf = (appId: string): UsageAppUsage | undefined =>
      total.apps.find((row) => row.appId === appId)
    expect(rowOf(first)?.totals).toEqual(firstUsage.totals)
    expect(rowOf(second)?.totals).toEqual(secondUsage.totals)
    expect(rowOf(first)?.name).toBe('第一个')
    expect(rowOf(first)?.known).toBe(true)

    // 合计逐项相加
    const expected: UsageTotals = {
      input: firstUsage.totals.input + secondUsage.totals.input,
      output: firstUsage.totals.output + secondUsage.totals.output,
      cacheRead: firstUsage.totals.cacheRead + secondUsage.totals.cacheRead,
      cacheWrite: firstUsage.totals.cacheWrite + secondUsage.totals.cacheWrite,
      totalTokens: firstUsage.totals.totalTokens + secondUsage.totals.totalTokens,
      costUsd: firstUsage.totals.costUsd + secondUsage.totals.costUsd,
    }
    expect(total.totals).toEqual(expected)

    // faux 没有价格表：这一格必须是 false，界面才不会显示 $0.00
    expect(total.priced).toBe(false)
    expect(typeof total.generatedAt).toBe('number')
  })

  it('没跑过一轮的应用：known=false，不冒充"花了 0"', async () => {
    running = await boot(dir)
    const server = running
    const used = await createApp(server, '用过的')
    const fresh = await createApp(server, '刚建的')
    await runTurn(server, used, 'u1', '收到。')

    const total = await totalOf(server)
    const freshRow = total.apps.find((row) => row.appId === fresh)
    expect(freshRow).toBeDefined()
    // 关键：这一格是 false —— 界面上它显示"还没跑过"，而不是 `0 tokens · $0`
    expect(freshRow?.known).toBe(false)
    expect(freshRow?.totals.totalTokens).toBe(0)
    // 合计只等于用过的那个应用
    expect(total.totals.totalTokens).toBe((await usageOf(server, used)).totals.totalTokens)
  })

  it('★ 重启之后不先打开应用也能汇总（走"只读账本"那条路）', async () => {
    /*
     * 这条测的是 `HarnessPool.readUsageLedger` —— 新进程里没有本应用的会话，
     * 汇总要么开一个"最小 harness"读账本，要么就得 `acquire()`（那会建扩展、
     * 起 worker、还 `resume()` 去执行别人被中断的任务）。
     *
     * 关键：这里**故意不调 `usage.get`**。一旦调了，服务就会把会话缓存起来，
     * 走的是"已打开"的分支，这条路径就永远测不到。
     */
    running = await boot(dir)
    const first = running
    const appId = await createApp(first, '重启前用过的')
    await runTurn(first, appId, 'u1', '收到。')
    const before = (await usageOf(first, appId)).totals.totalTokens
    expect(before).toBeGreaterThan(0)
    await first.close()

    running = await boot(dir)
    const second = running
    // 不碰 usage.get，直接汇总
    const total = await totalOf(second)
    const row = total.apps.find((item) => item.appId === appId)
    expect(row?.known).toBe(true)
    expect(row?.totals.totalTokens).toBe(before)
    expect(total.totals.totalTokens).toBe(before)
  })

  it('账本读不到：进 failed 并**不**算进合计（不能装成花了 0）', async () => {
    /*
     * 造一个真实的读失败：把 harness.db 的权限去掉。
     * 这条守的是汇总最该有的诚实性 —— 读不到就明说，而不是让它默默变成 0
     * （那会让用户以为"这个应用很便宜"）。
     */
    running = await boot(dir)
    const first = running
    const appId = await createApp(first, '账本坏掉的')
    await runTurn(first, appId, 'u1', '收到。')
    const before = (await usageOf(first, appId)).totals.totalTokens
    expect(before).toBeGreaterThan(0)
    await first.close()

    const dbFile = appPaths(resolveHome({ TENON_HOME: dir }), appId).harnessDb
    await chmod(dbFile, 0o000)
    try {
      running = await boot(dir)
      const total = await totalOf(running)
      expect(total.failed.map((item) => item.appId)).toEqual([appId])
      expect(total.failed[0]?.error).not.toBe('')
      // 读不到就不加：合计里没有它的量
      expect(total.totals.totalTokens).toBe(0)
    } finally {
      await chmod(dbFile, 0o644)
    }
  })

  it('应用被删之后，它不该继续留在汇总里', async () => {
    running = await boot(dir)
    const server = running
    const keep = await createApp(server, '留下的')
    const drop = await createApp(server, '要删的')
    await runTurn(server, keep, 'u1', '收到。')
    await runTurn(server, drop, 'u2', '收到二。')

    expect((await totalOf(server)).apps).toHaveLength(2)
    const beforeTotal = (await totalOf(server)).totals.totalTokens

    await call(server, 'app.delete', { id: drop, removeFiles: true })

    const after = await totalOf(server)
    expect(after.apps).toHaveLength(1)
    expect(after.apps[0]?.appId).toBe(keep)
    // 合计不能继续挂着被删应用的那笔花费
    const keepUsage = await usageOf(server, keep)
    expect(after.totals.totalTokens).toBe(keepUsage.totals.totalTokens)
    expect(after.totals.totalTokens).toBeLessThan(beforeTotal)
  })
})
