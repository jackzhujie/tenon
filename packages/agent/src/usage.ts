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
  BudgetWindow,
  GlobalBudget,
  SseEventInput,
  UsageSnapshot,
  UsageTotals,
} from '@tenon/protocol'
import type { CoreServices } from '@tenon/core'
import {
  ZERO_USAGE,
  addUsage,
  breached,
  budgetKey,
  currentMonth,
  diffUsage,
  hasAnyLimit,
  levelOf,
  readBudget,
  readGlobalBudget,
  readMonthBase,
  sumUsage,
  writeGlobalBudget,
  writeMonthBase,
} from '@tenon/core'
import type { MonthBase } from '@tenon/core'
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
  /** `apps` 只在判全局额度时用：要列一遍所有应用才知道总共花了多少 */
  core: Pick<CoreServices, 'settings' | 'prices' | 'apps'>
  publish: (event: SseEventInput) => void
}

/** 全局闸撞线的结果。`used` 是这个窗口内的量（月度量是差值，不是累计） */
export interface GlobalBreach {
  window: BudgetWindow
  dimension: BudgetDimension
  /** 撞线时这个窗口用了多少 —— 月度是差值，总量是全量 */
  used: UsageTotals
  /** 撞的那一道闸的额度 */
  budget: Budget
}

export interface StartTurnResult {
  snapshot: UsageSnapshot
  /** 已经顶到的是哪条线；非 null 时调用方应当拒绝这一轮 */
  exceeded: BudgetDimension | null
  /**
   * 全局闸。非 null 时**必须**拒绝这一轮。
   *
   * 与 `exceeded` 分开一格而不是合并成一个枚举：两者的处置不同 —— 应用额度撞了
   * 可以"换个应用"，全局撞了换到哪儿都一样，文案里要说的下一句完全不同。
   */
  global: GlobalBreach | null
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

    // 单应用先判：它更具体（能指出是哪个应用），而且**超了就不必再扫一遍全部账本**
    if (snapshot.level === 'over') {
      return { snapshot, exceeded: snapshot.exceeded, global: null }
    }

    const global = await this.checkGlobal()
    // 全局超了同样不清空基数：面板要能继续显示"上一轮花了多少"，否则用户看到
    // "花了 0 却不让发"，无从判断该调多少
    if (global !== null) return { snapshot, exceeded: null, global }

    entry.turnBase = entry.totals
    const fresh = await this.compose(appId, entry)
    this.publishIfChanged(appId, entry, fresh)
    return { snapshot: fresh, exceeded: null, global: null }
  }

  /** 全局额度（两道闸）。没配过 = 都不设限 */
  globalBudget(): GlobalBudget {
    return readGlobalBudget(this.options.core.settings)
  }

  async setGlobalBudget(budget: GlobalBudget): Promise<GlobalBudget> {
    writeGlobalBudget(this.options.core.settings, budget)
    return this.globalBudget()
  }

  /**
   * 判全局额度。**先总量、后月度** —— 这个顺序是有意的：
   *
   * 两道闸都撞上时，报"总量"才有用。报月度会说"下月 1 日自动重置"，而总量那道闸
   * 1 号根本不会解开 —— 用户等到 1 号发现还是发不出去，比不告诉他更糟。
   */
  private async checkGlobal(): Promise<GlobalBreach | null> {
    const budget = this.globalBudget()
    const monthlyOn = hasAnyLimit(budget.monthly)
    const lifetimeOn = hasAnyLimit(budget.lifetime)

    const month = currentMonth(new Date())
    const existing = readMonthBase(this.options.core.settings)
    const needBase = existing === null || existing.month !== month

    // 两维都空、本月基线也在 → 什么都不用做。
    // **但基线缺了就得补**，哪怕没设闸：用户很可能月中才来设额度，那时本月已经花掉
    // 的部分若不先记成基线，就会被算成"以前"，面板上的「本月已用」从 0 开始。
    // 这个坑是集成测试抓到的（先跑一轮、再设额度，本月显示 0）。
    if (!monthlyOn && !lifetimeOn && !needBase) return null

    const total = await this.total(this.listApps(), { fresh: true })
    const base = needBase ? this.rollMonthBase(month, total.totals) : (existing as MonthBase)

    if (lifetimeOn) {
      const dimension = breached(total.totals, budget.lifetime)
      if (dimension !== null) {
        return { window: 'total', dimension, used: total.totals, budget: budget.lifetime }
      }
    }

    if (monthlyOn) {
      const monthUsed = diffUsage(total.totals, base.totals)
      const dimension = breached(monthUsed, budget.monthly)
      if (dimension !== null) {
        return { window: 'month', dimension, used: monthUsed, budget: budget.monthly }
      }
    }
    return null
  }

  /**
   * 面板要的全局状态：额度、本月已用、累计、读不到账的应用数。
   *
   * 与 `checkGlobal` 分开：这个**不判**拦不拦（面板要显示"已经超了"的那个数，
   * 而不是一个布尔），但它同样会顺手补一次月初基线。
   */
  async globalStatus(): Promise<{
    budget: GlobalBudget
    /** 基线落在哪个月（`YYYY-MM`）。面板据此说"本月" */
    month: string
    monthUsed: UsageTotals
    totalUsed: UsageTotals
    /** 账本读不到、因此**没有**算进上面的应用数 —— 不为 0 时面板要提示 */
    unreadable: number
  }> {
    const budget = this.globalBudget()
    const month = currentMonth(new Date())
    const existing = readMonthBase(this.options.core.settings)

    const total = await this.total(this.listApps(), { fresh: true })
    const base =
      existing !== null && existing.month === month ? existing : this.rollMonthBase(month, total.totals)

    return {
      budget,
      month: base.month,
      monthUsed: diffUsage(total.totals, base.totals),
      totalUsed: total.totals,
      unreadable: total.failed.length,
    }
  }

  /**
   * 落一条新的月初基线。
   *
   * 「本月」在这个实现里的实际含义是**"自基线那一刻起"** —— 账本（`harness.usage()`）
   * 只有累计，没有时间维度，回溯不了"某笔花费发生在哪个月"。所以基线落得越早越准：
   * 现在每轮开始都会补（没有就补），把误差压到"安装到第一次发消息之间"，而那段
   * 本来就没有花费。
   */
  private rollMonthBase(month: string, current: UsageTotals): MonthBase {
    const base: MonthBase = { month, totals: current }
    writeMonthBase(this.options.core.settings, base)
    return base
  }

  private listApps(): Array<{ id: string; name: string }> {
    return this.options.core.apps.list().map((app) => ({ id: app.id, name: app.name }))
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
   *
   * `fresh`：面板用缓存（15 秒，来回开关不该扫 N 个库），**判额度时必须用真值**。
   * 拿一份 15 秒前的合计去决定拦不拦，等于给每个用户留了 15 秒的免费额度 ——
   * 而模型在这 15 秒里足够把额度烧穿。
   */
  async total(
    apps: readonly { id: string; name: string }[],
    options: { fresh?: boolean } = {},
  ): Promise<UsageTotalSnapshot> {
    const key = apps.map((app) => app.id).join(',')
    const cached = this.totalCache
    if (options.fresh !== true && cached !== null && cached.key === key && Date.now() - cached.at < TOTAL_TTL_MS) {
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
      console.error('[tenon] could not read usage; keeping the previous value:', err)
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
