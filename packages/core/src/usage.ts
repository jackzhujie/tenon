/**
 * 用量与预算（M4 第 3 步，DESIGN §5.6）。
 *
 * 这一层**只做算术**，不认识 harness：`harness.usage()` 返回什么形状是宿主的事，
 * 这里用结构宽松的类型吃进来（字段缺了当 0）。宿主升级改了字段名，代价应该是
 * "面板少一格数字"，而不是整个 UI 500。
 *
 * 为什么在 core 而不是 agent：拦截文案、面板、预算编辑都要用同一套算术。
 * 三处各写一遍 `used >= limit` 的后果是某个地方用了 `>` —— 那一处永远晚一步停。
 */
import type { Budget, BudgetDimension, UsageLevel, UsageTotals } from '@tenon/protocol'

/** pi 的一份 `Usage`（看不懂的字段一律忽略） */
export interface RawUsage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
  readonly cost?: { readonly total?: number }
}

/** `harness.usage()` 的返回：一个 session 的账本，按模型 / 按工具分桶 */
export interface RawUsageState {
  readonly models?: Record<string, RawUsage>
  readonly tools?: Record<string, RawUsage>
}

export const ZERO_USAGE: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costUsd: 0,
}

/** 到了八成先让人看见，但**不拦** —— 到八成就被掐断会很没道理 */
export const BUDGET_WARN_RATIO = 0.8

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 一份 pi 的 `Usage` → 我们的计数 */
export function totalsOf(raw: RawUsage | undefined): UsageTotals {
  if (raw === undefined) return ZERO_USAGE
  const input = num(raw.input)
  const output = num(raw.output)
  const cacheRead = num(raw.cacheRead)
  const cacheWrite = num(raw.cacheWrite)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    // 宿主没给总数就自己加：这一格缺了，token 上限就永远拦不住
    totalTokens: raw.totalTokens === undefined ? input + output + cacheRead + cacheWrite : num(raw.totalTokens),
    costUsd: num(raw.cost?.total),
  }
}

/** 整本账 → 总量 + 两个分桶（分桶原样保留给面板展示） */
export function sumUsage(state: RawUsageState): {
  totals: UsageTotals
  models: Record<string, UsageTotals>
  tools: Record<string, UsageTotals>
} {
  const models: Record<string, UsageTotals> = {}
  const tools: Record<string, UsageTotals> = {}
  let totals = ZERO_USAGE
  for (const [key, raw] of Object.entries(state.models ?? {})) {
    const bucket = totalsOf(raw)
    models[key] = bucket
    totals = addUsage(totals, bucket)
  }
  for (const [key, raw] of Object.entries(state.tools ?? {})) {
    const bucket = totalsOf(raw)
    tools[key] = bucket
    totals = addUsage(totals, bucket)
  }
  return { totals, models, tools }
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

/**
 * 这一轮的量 = 现在 − 本轮开始时的基数。
 *
 * 逐项 `max(0, …)`：账本只增不减，但应用被删重建、或基数是在旧 session 上取的，
 * 都可能出现"现在比基数小"。负的用量在面板上是纯粹的胡说，夹到 0。
 */
export function diffUsage(now: UsageTotals, base: UsageTotals): UsageTotals {
  const at = (a: number, b: number): number => Math.max(0, a - b)
  return {
    input: at(now.input, base.input),
    output: at(now.output, base.output),
    cacheRead: at(now.cacheRead, base.cacheRead),
    cacheWrite: at(now.cacheWrite, base.cacheWrite),
    totalTokens: at(now.totalTokens, base.totalTokens),
    costUsd: at(now.costUsd, base.costUsd),
  }
}

/**
 * 顶到哪条线了。`>=` 而不是 `>`：额度是"最多能用到这个数"，
 * 用满就是没有余额了 —— 用 `>` 会让最后一个 token 永远花得出去，也会让
 * "上限设 0" 变成"不设限"。
 */
export function breached(totals: UsageTotals, budget: Budget): BudgetDimension | null {
  if (budget.maxCostUsd !== null && totals.costUsd >= budget.maxCostUsd) return 'cost'
  if (budget.maxTokens !== null && totals.totalTokens >= budget.maxTokens) return 'tokens'
  return null
}

/** 面板用的三档：over（该拦了）/ warn（八成以上）/ ok */
export function levelOf(totals: UsageTotals, budget: Budget): UsageLevel {
  if (breached(totals, budget) !== null) return 'over'
  const near = (used: number, limit: number | null): boolean =>
    limit !== null && limit > 0 && used / limit >= BUDGET_WARN_RATIO
  if (near(totals.costUsd, budget.maxCostUsd) || near(totals.totalTokens, budget.maxTokens)) return 'warn'
  return 'ok'
}
