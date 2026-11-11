import { GlobalBudget as GlobalBudgetSchema, ReleaseCheckRecord, type Budget, type GlobalBudget, type UsageTotals } from '@tenon/protocol'
import type { SettingsStore } from './stores/settings.js'

/** 产品级设置键（拼写集中在这里，避免各路由各写一份字符串） */
export const SETTING_KEYS = {
  defaultModelTier: 'agent.defaultModelTier',
  activeProviderId: 'agent.activeProviderId',
  telemetryEnabled: 'telemetry.enabled',
  lastOpenedAppId: 'ui.lastOpenedAppId',
  theme: 'ui.theme',
} as const

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]

/**
 * 预算按应用存：`budget.app.<appId>`。
 *
 * 为什么不放进 `SETTING_KEYS` 常量表：键里带 id，写不进那张常量表。
 * 为什么按应用而不是全局：花超的永远是**某一个**应用的一轮（模型绕圈、反复读大文件）；
 * 全局额度既解释不了"贵在哪"，也没法只停掉那一个。
 * （代价是 N 个应用各有一个额度、没有总闸 —— 这条记在 DESIGN §5.6 的缺口里。）
 */
export function budgetKey(appId: string): string {
  return `budget.app.${appId}`
}

/** 不设限的额度。没配过、或者配置被写坏时用它 */
export const NO_BUDGET: Budget = { maxCostUsd: null, maxTokens: null }

/** 读一个应用的额度。**任何异常都退回"不设限"** —— 读坏一格不该把应用锁死 */
export function readBudget(settings: SettingsStore, appId: string): Budget {
  const raw = settings.get<Partial<Budget>>(budgetKey(appId))
  if (raw === null || typeof raw !== 'object') return NO_BUDGET
  return {
    maxCostUsd: positiveOrNull(raw.maxCostUsd),
    maxTokens: positiveOrNull(raw.maxTokens),
  }
}

/** 负数与 NaN 一律当"没设"：它们只会让比较永远成立，变成一个关不掉的应用 */
function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/* ────────────────────────── 全局额度（两道闸） ────────────────────────── */

/**
 * 全局额度。不带 id，所以可以直接进常量表。
 *
 * 与 `budgetKey(appId)` 的分工：那个管"某一个应用能花多少"（花超的永远是某一轮），
 * 这个管"总共能花多少"（模型绕圈、连开三个应用，单看每个都不越线）。两者都要有，
 * 因为单应用闸回答不了"今天一共花了多少"，全局闸又定位不到是哪一步在烧钱。
 */
export const GLOBAL_BUDGET_KEY = 'budget.global'

/**
 * 月度闸的月初基线：`{ month: '2026-11', totals: {...} }`。
 *
 * **为什么必须有它**：账本（`harness.usage()`）只有"累计"这一个数，没有时间维度。
 * 想知道"本月花了多少"只能拿当前累计减去月初那一刻的累计。于是每月第一次判额度时
 * 落一次基线。
 *
 * 已知误差：月初到"第一次开 Tenon"之间的消费会被算进本月（基线落得晚）。方向是
 * **偏保守**（多算不多放），个人工具可以接受；写在这里是因为它不该被当成精确值。
 *
 * 与额度**分开存**：写基线每月一次、改额度偶尔一次，混在一条记录里就会互相覆盖 ——
 * 改上限顺手把基线冲掉，本月用量直接归零，闸就永远不拦了。
 */
export const GLOBAL_BASE_KEY = 'budget.global.monthBase'

export interface MonthBase {
  /** `YYYY-MM`，**本地时区**。用户说的"这个月"是自己日历上的月，不是 UTC 的 */
  month: string
  totals: UsageTotals
}

export const NO_GLOBAL_BUDGET: GlobalBudget = { monthly: NO_BUDGET, lifetime: NO_BUDGET }

/** `2026-11`。本地时区，与发布版本号的 `versionPrefix` 同一个理由 */
export function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 读全局额度。**任何异常都退回"不设限"** —— 与 `readBudget` 同一条原则：
 * 读坏一格不该把整个产品锁死。用 zod 而不是手挡字段，是因为形状以后会变
 * （比如再加一道闸），手写的校验最容易在加字段时漏一处，而漏掉的后果是
 * 界面上显示一个 `undefined` 被当成"没设"。
 */
export function readGlobalBudget(settings: SettingsStore): GlobalBudget {
  const raw = settings.get<unknown>(GLOBAL_BUDGET_KEY)
  if (raw === undefined || raw === null) return NO_GLOBAL_BUDGET
  const parsed = GlobalBudgetSchema.safeParse(raw)
  return parsed.success ? parsed.data : NO_GLOBAL_BUDGET
}

/** 写全局额度。基线不动 —— 见 `GLOBAL_BASE_KEY` 的注释 */
export function writeGlobalBudget(settings: SettingsStore, budget: GlobalBudget): void {
  settings.set({
    [GLOBAL_BUDGET_KEY]: {
      monthly: { maxCostUsd: positiveOrNull(budget.monthly.maxCostUsd), maxTokens: positiveOrNull(budget.monthly.maxTokens) },
      lifetime: { maxCostUsd: positiveOrNull(budget.lifetime.maxCostUsd), maxTokens: positiveOrNull(budget.lifetime.maxTokens) },
    },
  })
}

/** 读月初基线。坏了 / 没有 → null（调用方会重新落一次） */
export function readMonthBase(settings: SettingsStore): MonthBase | null {
  const raw = settings.get<Partial<MonthBase>>(GLOBAL_BASE_KEY)
  if (raw === null || typeof raw !== 'object') return null
  if (typeof raw.month !== 'string' || raw.totals === undefined || raw.totals === null) return null
  return { month: raw.month, totals: raw.totals }
}

export function writeMonthBase(settings: SettingsStore, base: MonthBase): void {
  settings.set({ [GLOBAL_BASE_KEY]: base })
}

/** 有任意一维设了值，才算"配了闸" —— 都空时不必去遍历所有应用的账本 */
export function hasAnyLimit(budget: Budget): boolean {
  return budget.maxCostUsd !== null || budget.maxTokens !== null
}

/**
 * 上次预检的结论：`release.lastCheck.<appId>`（v1.2.23）。
 *
 * 与 `budgetKey` 同一个理由：键里带 id，写不进 `SETTING_KEYS` 常量表。
 */
export function lastCheckKey(appId: string): string {
  return `release.lastCheck.${appId}`
}

/**
 * 读上次预检的存档。
 *
 * 三条边界各有处置：
 *
 * 1. **没有** → `null`（从没查过，正常状态）
 * 2. **JSON 坏了** → `null`（`SettingsStore.get` 已经吞掉解析错误）
 * 3. **形状不对** → `null`。这一条是给"代码升级后旧存档缺字段"准备的：用 zod 的
 *    `safeParse` 而不是手工挡几个字段，是因为**形状会变**（比如以后加一项），
 *    手写的校验最容易在加字段时漏掉一处，而漏掉的后果是界面上显示一个 undefined。
 *
 * 绝不抛：读坏一格不该让发布对话框打不开。
 */
export function readLastCheck(
  settings: SettingsStore,
  appId: string,
): ReleaseCheckRecord | null {
  const raw = settings.get<unknown>(lastCheckKey(appId))
  if (raw === undefined) return null
  const parsed = ReleaseCheckRecord.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export type { SettingsStore }
