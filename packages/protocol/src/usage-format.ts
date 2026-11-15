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
import { msg } from './messages/index.js'

/**
 * `1234` → `1.2k`。面板宽度有限，这个数只用来判断量级，不需要精确到个位。
 *
 * 保留一位小数到 99.9k（`>= 100` 才取整）：跨应用汇总出现之后，用户会**把几行加起来
 * 对一眼**。若 10k 以上直接取整，`6.3k + 4.2k` 会和合计 `10k` 对不上 —— 这种"数字不
 * 自洽"的观感比多一个字符严重得多。代价是表头那个 chip 宽一个字符。
 *
 * **M 量级取两位小数**（2026-11-15 修）：同一个理由，只是量级大 1000 倍。
 * 一位小数的 M 只有 100k 的分辨率 —— 合计 `34M` 与分项 `34M + 13.5k` 会看起来对不上
 * （用户实际就是这么报的）。两位小数下变成 `34.01M`，那 13.5k 就能在末位上看见了。
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${trimZero(tokens / 1000)}k`
  return `${trimZero(tokens / 1_000_000, 2)}M`
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
  return msg('error.budget.appExhausted', { used, limit })
}

/**
 * 全局额度撞线时的那句话。
 *
 * 与 `budgetMessage` 分开写，因为**用户接下来该做的事完全不同**：应用额度撞了可以
 * "换个应用继续"，全局额度撞了换到哪儿都一样 —— 只有"等 1 号"或"改上限"两条路。
 * 把两种情况说成同一句，等于把用户推到三分钟后再次撞墙。
 *
 * `window` 必须区分：月度会自己解开，总量不会。用户看到"下月 1 日重置"却撞的是
 * 总量闸时，会一直等到 1 号然后发现还是发不出去。
 */
export function globalBudgetMessage(
  used: UsageTotals,
  budget: Budget,
  dimension: BudgetDimension,
  window: 'month' | 'total',
): string {
  const usedText = dimension === 'cost' ? formatCost(used.costUsd) : `${formatTokens(used.totalTokens)} tokens`
  const limit =
    dimension === 'cost' ? formatCost(budget.maxCostUsd ?? 0) : `${formatTokens(budget.maxTokens ?? 0)} tokens`

  if (window === 'month') {
    return msg('error.budget.globalMonthExhausted', { used: usedText, limit })
  }
  return msg('error.budget.globalTotalExhausted', { used: usedText, limit })
}

/**
 * 去掉尾部多余的 0：`34.00` → `34`、`2.40` → `2.4`、`34.01` 原样保留。
 *
 * 100 以上一律取整（三位数再带小数就太长了），除非调用方显式要求更多位。
 * 注意不能对没有小数点的字符串做 `\.?0+$` —— `100` 会被吃成 `1`。
 */
function trimZero(value: number, precision = 1): string {
  // 100 以上才取整：见 formatTokens 的注释（跨应用汇总要对得上）
  const digits = value >= 100 ? 0 : precision
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}
