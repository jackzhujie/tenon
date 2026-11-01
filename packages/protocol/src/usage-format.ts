/**
 * 用量的展示格式（M4 第 3 步）。
 *
 * 为什么在 protocol 而不是 core：服务端（拦截报错）与浏览器（面板数字、横幅）
 * 都要用同一套口径。core 里带 `node:sqlite` / `isomorphic-git`，浏览器拿不动它；
 * 而这个文件只有几个字符串函数，两边都能引。
 *
 * 两处各写一份的后果很具体：`$0.00` 与 `<$0.01` 并存时，用户会以为有一处是 bug。
 */
import type { Budget, BudgetDimension, UsageTotals } from './domain.js'

/** `1234` → `1.2k`。面板宽度有限，这个数只用来判断量级，不需要精确到个位 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${trimZero(tokens / 1000)}k`
  return `${trimZero(tokens / 1_000_000)}M`
}

/**
 * `0.0042` → `<$0.01`。
 *
 * 零和"有一点点"必须分开写：账单上一轮真花了钱，面板却显示 `$0.00`，
 * 用户对整块数字的信任就没了。
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/**
 * 超额度时的那句话。
 *
 * 放这里而不是各写一遍：同一件事在**拦截报错**（`chat.submit` 抛的 `BUDGET_EXCEEDED`）
 * 与**面板横幅**（`budget.exceeded` 事件）里都要说，两处文案不一致时
 * 用户会以为是两个不同的问题。
 */
export function budgetMessage(totals: UsageTotals, budget: Budget, dimension: BudgetDimension): string {
  const used = dimension === 'cost' ? formatCost(totals.costUsd) : `${formatTokens(totals.totalTokens)} tokens`
  const limit =
    dimension === 'cost' ? formatCost(budget.maxCostUsd ?? 0) : `${formatTokens(budget.maxTokens ?? 0)} tokens`
  return `这个应用的额度用完了（已用 ${used}，上限 ${limit}）。调高上限，或者换一个应用继续。`
}

function trimZero(value: number): string {
  const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}
