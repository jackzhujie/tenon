/**
 * 用量与预算服务（M4 第 3 步，DESIGN §5.6）。
 *
 * 真值只有一个来源：`harness.usage()` —— 它是 session 账本（每个会话的 `pi.usage`
 * 求和），**跨重启不丢**，而且天然把子 Agent 与压缩摘要都算进去。自己从前端事件里
 * 累加是行不通的：子 Agent 的消耗根本不经过父会话的事件流，压缩摘要也不产生 entry。
 *
 * 三个不显然的点：
 *
 * 1. **推全量，不推增量。** 一次生成会有好几次模型调用，逐次推 delta 要维护
 *    "哪个增量加到哪个桶"的状态机；算错一次就是长期显示错的余额。快照只有几个数字。
 *
 * 2. **`turn` 是差值，不是另一个计数器。** 本轮开始的时候记下当时的累计，
 *    之后每次 `now - base`。这样子 Agent、压缩摘要的花费也会出现在"这一轮"里 ——
 *    而它们恰恰是最容易被漏掉的部分。
 *
 * 3. **读失败不能把应用锁死。** `harness.usage()` 抛错时退回上一次已知的量：
 *    拿不到账本就拦业务的后果是"整个应用打不开"，比多花几分钱严重得多。
 */
import type { Harness } from '@earendil-works/pi-durable'
import type {
  Budget,
  BudgetDimension,
  SseEventInput,
  UsageSnapshot,
  UsageTotals,
} from '@tenon/protocol'
import type { CoreServices } from '@tenon/core'
import { ZERO_USAGE, breached, budgetKey, diffUsage, levelOf, readBudget, sumUsage } from '@tenon/core'
import { agentContext as ctx } from './context.js'
import type { HarnessPool } from './harness-pool.js'

interface Entry {
  readonly harness: Harness
  /** 上一次读到的累计（读失败时退到它） */
  totals: UsageTotals
  /** 本轮开始时的累计：`turn = totals - turnBase` */
  turnBase: UsageTotals
  models: Record<string, UsageTotals>
  tools: Record<string, UsageTotals>
  /** 上次推出去的快照（JSON）。重复帧不推：面板每句都刷一次没有意义 */
  published: string
}

export interface UsageServiceOptions {
  pool: HarnessPool
  core: Pick<CoreServices, 'settings' | 'prices'>
  publish: (event: SseEventInput) => void
}

export interface StartTurnResult {
  snapshot: UsageSnapshot
  /** 已经顶到的是哪条线；非 null 时调用方应当拒绝这一轮 */
  exceeded: BudgetDimension | null
}

export class UsageService {
  private readonly entries = new Map<string, Promise<Entry>>()
  private closed = false

  constructor(private readonly options: UsageServiceOptions) {}

  /** 一个应用的额度。没配过 = 不设限 */
  budget(appId: string): Budget {
    return readBudget(this.options.core.settings, appId)
  }

  /**
   * 现在这一刻的账（不推事件）。RPC `usage.get` 用它 ——
   * 前端切应用 / 重连之后要一份真值，而不是等下一次模型响应。
   */
  async snapshot(appId: string): Promise<UsageSnapshot> {
    const entry = await this.entry(appId)
    return this.compose(appId, entry)
  }

  /** 读一次真值并推 `usage.update`（有变化才推） */
  async refresh(appId: string): Promise<UsageSnapshot> {
    const entry = await this.entry(appId)
    const snapshot = await this.compose(appId, entry)
    this.publishIfChanged(appId, entry, snapshot)
    return snapshot
  }

  /**
   * 一轮开始了：把「本轮」清零，并顺手判一次额度。
   *
   * 为什么不分成 `beginTurn` + `check` 两次读：判额度用的正是这一份总量。
   * 而且顺序很重要 —— **超额时不能清空基数**，否则面板会把上一轮的数字抹成 0，
   * 用户看到"花了 0 却不让发"，无从判断该调多少。
   */
  async startTurn(appId: string): Promise<StartTurnResult> {
    const entry = await this.entry(appId)
    const snapshot = await this.compose(appId, entry)
    if (snapshot.level === 'over') return { snapshot, exceeded: snapshot.exceeded }
    entry.turnBase = entry.totals
    const fresh = await this.compose(appId, entry)
    this.publishIfChanged(appId, entry, fresh)
    return { snapshot: fresh, exceeded: null }
  }

  /**
   * 改额度。**立即推一次快照**：调高上限之后前端要马上把输入框解锁，
   * 不能等下一次模型响应（那时可能已经没人在跑了）。
   */
  async setBudget(appId: string, budget: Budget): Promise<UsageSnapshot> {
    this.options.core.settings.set({ [budgetKey(appId)]: budget })
    return this.refresh(appId)
  }

  /** 应用被删：连着它的额度一起扔掉，免得下次同 id 复活时莫名带一个旧上限 */
  async release(appId: string): Promise<void> {
    this.entries.delete(appId)
    this.options.core.settings.remove(budgetKey(appId))
  }

  async close(): Promise<void> {
    this.closed = true
    this.entries.clear()
  }

  private async entry(appId: string): Promise<Entry> {
    const existing = this.entries.get(appId)
    if (existing !== undefined) return existing
    const opening = this.open(appId)
    this.entries.set(appId, opening)
    try {
      return await opening
    } catch (err) {
      this.entries.delete(appId)
      throw err
    }
  }

  private async open(appId: string): Promise<Entry> {
    const session = await this.options.pool.acquire(appId)
    const entry: Entry = {
      harness: session.harness,
      totals: ZERO_USAGE,
      // 首次读到的量当基数：否则第一次打开面板会把"历史总量"显示成"这一轮"
      turnBase: ZERO_USAGE,
      models: {},
      tools: {},
      published: '',
    }
    await this.read(entry)
    entry.turnBase = entry.totals
    return entry
  }

  /** 读账本。失败时保持上一次的值 —— 见文件头第 3 条 */
  private async read(entry: Entry): Promise<void> {
    try {
      const state = await entry.harness.usage(ctx)
      // 宿主的类型比我们要的宽（`JsonRepresentation<Usage>`），结构上兼容 —— 不用 as
      const { totals, models, tools } = sumUsage(state)
      entry.totals = totals
      entry.models = models
      entry.tools = tools
    } catch (err) {
      console.error('[tenon] 读用量失败，沿用上一次的值：', err)
    }
  }

  private async compose(appId: string, entry: Entry): Promise<UsageSnapshot> {
    await this.read(entry)
    const budget = this.budget(appId)
    const choice = this.options.pool.modelChoice
    return {
      appId,
      totals: entry.totals,
      models: entry.models,
      tools: entry.tools,
      turn: diffUsage(entry.totals, entry.turnBase),
      budget,
      level: levelOf(entry.totals, budget),
      exceeded: breached(entry.totals, budget),
      // 价格表里有这一条才算"算得出来"；faux 没有价格表，所以它永远是 false
      priced: this.options.core.prices.find(choice.provider, choice.modelId) !== undefined,
    }
  }

  private publishIfChanged(appId: string, entry: Entry, snapshot: UsageSnapshot): void {
    if (this.closed) return
    const payload = JSON.stringify(snapshot)
    if (payload === entry.published) return
    entry.published = payload
    this.options.publish({ type: 'usage.update', appId, snapshot })
  }
}
