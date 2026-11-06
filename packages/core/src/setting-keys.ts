import { ReleaseCheckRecord, type Budget } from '@tenon/protocol'
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
