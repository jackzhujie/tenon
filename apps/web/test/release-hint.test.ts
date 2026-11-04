/**
 * 顶栏发布徽标的算法（见 `release-hint.ts` 的注释）。
 *
 * 这四条都是真会发生的状态，而它们的区别只体现在"数字与文案"上：
 * 新应用 / 发过又改了 / 刚发完 / 发布点比最近 30 版还早。
 */
import { describe, expect, it } from 'vitest'
import { releaseBadge, releaseHint, releaseTooltip } from '../src/lib/release-hint.js'

const c = (sha: string): { sha: string } => ({ sha })
const r = (commitSha: string): { commitSha: string } => ({ commitSha })

describe('releaseHint', () => {
  it('没有任何提交 → 不显示（空应用不该顶一个徽标）', () => {
    expect(releaseHint([], [])).toBeNull()
  })

  it('从没发布过 → 数字是版本数，且标成"还没发过"', () => {
    const hint = releaseHint([c('a'), c('b'), c('c')], [])
    // 只有 3 条、没被截断 → 数字是精确的，不该带 +
    expect(hint).toEqual({ count: 3, saturated: false, ever: false })
    expect(releaseBadge(hint!)).toBe('3')
    expect(releaseTooltip(hint!)).toContain('还没发布过')
  })

  it('刚发布完（HEAD 就是发布点）→ 不显示，而不是显示 0', () => {
    expect(releaseHint([c('a'), c('b')], [r('a')])).toBeNull()
  })

  it('发过又改了 2 版 → 精确数字，不带 +', () => {
    const hint = releaseHint([c('d'), c('c'), c('b'), c('a')], [r('b')])
    expect(hint).toEqual({ count: 2, saturated: false, ever: true })
    expect(releaseBadge(hint!)).toBe('2')
    expect(releaseTooltip(hint!)).toContain('又改了 2 个版本')
  })

  it('发布点在最近 30 条之外 → 只能说"至少 N"，不能编精确数', () => {
    // 默认窗口 20 条：拉满了还没碰到发布点 → 只能说下限
    const commits = Array.from({ length: 20 }, (_, i) => c(`s${i}`))
    const hint = releaseHint(commits, [r('很久以前的 sha')])
    expect(hint).toEqual({ count: 20, saturated: true, ever: true })
    expect(releaseBadge(hint!)).toBe('20+')
    expect(releaseTooltip(hint!)).toContain('至少 20')
  })

  it('同一个 commit 发过多次（重发同一版）不影响计数', () => {
    const hint = releaseHint([c('c'), c('b'), c('a')], [r('a'), r('a')])
    expect(hint).toEqual({ count: 2, saturated: false, ever: true })
  })
})
