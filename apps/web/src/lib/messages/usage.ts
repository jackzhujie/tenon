/**
 * 用量与额度面板的文案。
 */
export const usageEn = {
  'usage.title': 'Usage & budget',
  'usage.chip': 'Usage',
  'usage.allApps': 'All apps',
  'usage.unpriced': 'Unpriced',
  'usage.notRun': 'not run yet',
  'usage.noLedger': 'These apps have not finished a turn yet, so there is no ledger.',
  'usage.row.appTotal': 'This app, total',
  'usage.row.thisTurn': 'This turn',
  'usage.unit.usd': 'USD',
  'usage.note.server': 'The real numbers live on the server — they survive restarts.',
  'usage.tip.app': 'Usage of this app',
  'usage.tip.cumulative': 'Total {tokens} tokens · {cost}; click to set a budget',
  'usage.error.limit': 'Enter a number of at least 0; leave empty to leave that dimension unlimited',

  'usage.level.ok': 'Fine',
  'usage.level.warn': 'Nearly used up',
  'usage.level.over': 'Used up',

  'usage.global.title': 'Global budget (all apps combined)',
  'usage.global.monthly': 'Per month',
  'usage.global.monthUsed': 'this month {cost}',
  'usage.global.totalCap': 'Lifetime',
  'usage.global.totalUsed': 'total {cost}',
  'usage.global.note.before': 'The monthly cap follows the ',
  'usage.global.note.emphasis': 'calendar month',
  'usage.global.note.after':
    ' and resets on the 1st. The lifetime cap never resets — when you hit it, raise it or clear it by hand.',
  'usage.global.emptyHint': 'Empty = that gate stays unlimited',

  'usage.total.more': '…and {count} more apps',
  'usage.total.failed': '{count} app(s) have no readable ledger (not counted): {names}',
  'usage.total.error': 'Could not read the totals: {detail}',
  'usage.budget.title': 'Budget (no more turns once used up; leave empty = no limit)',
  'usage.global.unreadable': '{count} app(s) have no readable ledger — the two numbers above exclude them.',
} as const

export type UsageKey = keyof typeof usageEn

export const usageZh: Record<UsageKey, string> = {
  'usage.title': '用量与额度',
  'usage.chip': '用量',
  'usage.allApps': '全部应用',
  'usage.unpriced': '未定价',
  'usage.notRun': '还没跑过',
  'usage.noLedger': '这些应用还没跑过一轮，没有账本',
  'usage.row.appTotal': '本应用累计',
  'usage.row.thisTurn': '这一轮',
  'usage.unit.usd': '美元',
  'usage.note.server': '真值在服务端，重启不丢',
  'usage.tip.app': '这个应用的用量',
  'usage.tip.cumulative': '累计 {tokens} tokens · {cost}；点开设额度',
  'usage.error.limit': '上限要填一个不小于 0 的数；留空 = 这条不设限',

  'usage.level.ok': '正常',
  'usage.level.warn': '快用完了',
  'usage.level.over': '已用完',

  'usage.global.title': '全局额度（所有应用合计）',
  'usage.global.monthly': '每月封顶',
  'usage.global.monthUsed': '本月 {cost}',
  'usage.global.totalCap': '总量封顶',
  'usage.global.totalUsed': '累计 {cost}',
  'usage.global.note.before': '每月那道按',
  'usage.global.note.emphasis': '自然月',
  'usage.global.note.after': '算，下月 1 日自动回到零；总量那道不会自己解开，撞上就得手动调高或清空。',
  'usage.global.emptyHint': '置空 = 那道闸不设限',

  'usage.total.more': '…另有 {count} 个应用',
  'usage.total.failed': '{count} 个应用的账本读不到（没算进合计）：{names}',
  'usage.total.error': '读不到汇总：{detail}',
  'usage.budget.title': '额度（用完就不让再发；留空 = 不设限）',
  'usage.global.unreadable': '有 {count} 个应用账本读不到，那两个数里不含它们。',
}
