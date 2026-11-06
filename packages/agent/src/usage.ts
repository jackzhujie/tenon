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
import { ZERO_USAGE, addUsage, breached, budgetKey, diffUsage, levelOf, readBudget, sumUsage } from '@tenon/core'
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

/** 汇总里的一行：一个应用的全部用量 */
export interface UsageAppRow {
  appId: string
  name: string
  totals: UsageTotals
  budget: Budget
  level: ReturnType<typeof levelOf>
  /**
   * `false` = 这个应用还没有账本（从没跑过一轮）。
   *
   * 这一格存在的理由：`totals` 在两种情况下都是 0 —— "确实没花" 与 "没账本"。
   * 不区分的话，刚建的应用会和用过的应用长得一样，而"合计"会看着像个准数。
   */
  known: boolean
}

/** 跨应用汇总（`usage.total`） */
export interface UsageTotalSnapshot {
  totals: UsageTotals
  /** 按花费从大到小排好，界面直接渲染 */
  apps: UsageAppRow[]
  /** 账本读失败的应用：它们**没有**被算进 totals，不能装成 0 */
  failed: Array<{ appId: string; name: string; error: string }>
  /** 当前模型配了价格才为真（否则 costUsd 恒 0 是"没算"） */
  priced: boolean
  generatedAt: number
}

/** 汇总的缓存时长：面板反复开关不该每次都去扫 N 个库 */
const TOTAL_TTL_MS = 15_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class UsageService {
  private readonly entries = new Map<string, Promise<Entry>>()
  private closed = false
  private totalCache: { at: number; key: string; value: UsageTotalSnapshot } | null = null

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
    // 有新数据了，汇总的缓存立刻作废：面板上"本应用"动了、"全部应用"没动会很怪
    this.totalCache = null
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

  /**
   * 跨应用汇总：面板上"全部应用"那个数字。
   *
   * 两个边界必须一起处理，否则这个数会骗人：
   * - **还没有账本**（从没跑过一轮）→ `known: false`，行照常出现但不算进合计
   * - **读失败** → 进 `failed`，**不参与求和**。装成 0 等于告诉用户"它没花钱"
   *
   * 为什么不去 `acquire()` 每个应用：那会把 N 个应用的会话全部拉活（含 `resume()`，
   * 也就是真的去执行别人被中断的任务）。见 `HarnessPool.readUsageLedger`。
   */
  async total(apps: readonly { id: string; name: string }[]): Promise<UsageTotalSnapshot> {
    const key = apps.map((app) => app.id).join(',')
    const cached = this.totalCache
    if (cached !== null && cached.key === key && Date.now() - cached.at < TOTAL_TTL_MS) {
      return cached.value
    }

    let totals = ZERO_USAGE
    const rows: UsageAppRow[] = []
    const failed: UsageTotalSnapshot['failed'] = []

    for (const app of apps) {
      const budget = this.budget(app.id)
      try {
        const known = await this.ledgerTotals(app.id)
        const value = known ?? ZERO_USAGE
        totals = addUsage(totals, value)
        rows.push({
          appId: app.id,
          name: app.name,
          totals: value,
          budget,
          level: levelOf(value, budget),
          known: known !== null,
        })
      } catch (error) {
        failed.push({ appId: app.id, name: app.name, error: messageOf(error) })
      }
    }

    // 花费大的排前面：第一眼该看到"贵的是哪个"
    rows.sort(
      (a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.totalTokens - a.totals.totalTokens,
    )

    const value: UsageTotalSnapshot = {
      totals,
      apps: rows,
      failed,
      priced: this.priced(),
      generatedAt: Date.now(),
    }
    this.totalCache = { at: value.generatedAt, key, value }
    return value
  }

  /** 一个应用的累计。`null` = 从没跑过（连账本都没有），**不是**"花了 0" */
  private async ledgerTotals(appId: string): Promise<UsageTotals | null> {
    const existing = this.entries.get(appId)
    if (existing !== undefined) {
      // 正在用的应用：顺手读一次最新，免得汇总比面板上的"本应用"落后一整轮
      const entry = await existing
      await this.read(entry)
      return entry.totals
    }
    const state = await this.options.pool.readUsageLedger(appId)
    return state === null ? null : sumUsage(state).totals
  }

  /** 当前模型有没有价格表（没有的话 costUsd 恒 0 = "没算"，不是"便宜"） */
  private priced(): boolean {
    const choice = this.options.pool.modelChoice
    return this.options.core.prices.find(choice.provider, choice.modelId) !== undefined
  }

  /** 应用被删：连着它的额度一起扔掉，免得下次同 id 复活时莫名带一个旧上限 */
  async release(appId: string): Promise<void> {
    this.entries.delete(appId)
    this.options.core.settings.remove(budgetKey(appId))
    this.totalCache = null
  }

  async close(): Promise<void> {
    this.closed = true
    this.entries.clear()
    this.totalCache = null
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
      priced: this.priced(),
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
