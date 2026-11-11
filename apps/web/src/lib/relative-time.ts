/**
 * 相对时间：「刚刚」/「3 分钟前」/「2 天前」。
 *
 * 抽出来是因为**第三处要用了**（`ChatPanel` 的会话时间、`DiffPanel` 的提交时间、
 * 现在还有发布对话框的"上次检查"）。前两处原本各写了一份，而且细节还不一样：
 * 一个用 `Math.round`、一个用 `Math.floor`；超过一天一个显示「N 天前」、一个显示日期。
 *
 * **没有强行统一成一种**，因为两种都对：
 * - 会话列表问的是"这条有多新" → 「2 天前」
 * - 提交列表问的是"这是哪一天的" → 「11/5」
 *
 * 但 `round → floor` 统一了：90 秒时 `round` 会说"2 分钟前"（还没到 2 分钟），
 * `floor` 说"1 分钟前"。后者才是人的直觉。
 *
 * 文案走 `t()`，日期格式走 locale —— 英文用 `11/5`，中文也是 `11/5`，
 * 但月份名称一旦要写全（`Nov 5`）就必须分开，所以这里就按 locale 分。
 */
import type { Locale, TFunction } from './i18n.js'

export interface TimeWords {
  t: TFunction
  locale: Locale
}

/**
 * @param at 过去某个时刻的时间戳（毫秒）
 * @param words 文案函数与 locale（组件里 `useT()` 直接给）
 * @param beyondDay 超过一天之后怎么显示：`days` = 「2 天前」，`date` = 「11/5」
 */
export function relativeTime(at: number, words: TimeWords, beyondDay: 'days' | 'date' = 'days'): string {
  const { t, locale } = words
  const delta = Date.now() - at
  // 时钟回拨或未来时间：不显示"-3 分钟前"这种让人困惑的东西
  if (delta < 60_000) return t('time.justNow')
  if (delta < 3_600_000) return t('time.minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('time.hoursAgo', { count: Math.floor(delta / 3_600_000) })
  if (beyondDay === 'date') {
    return new Date(at).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
    })
  }
  return t('time.daysAgo', { count: Math.floor(delta / 86_400_000) })
}
