import { describe, expect, it } from 'vitest'
import { TenonDatabase } from '../src/db.js'
import {
  GLOBAL_BASE_KEY,
  NO_GLOBAL_BUDGET,
  currentMonth,
  hasAnyLimit,
  readGlobalBudget,
  readMonthBase,
  writeGlobalBudget,
  writeMonthBase,
} from '../src/setting-keys.js'
import { SettingsStore } from '../src/stores/settings.js'
import { ZERO_USAGE } from '../src/usage.js'

function fresh(): { db: TenonDatabase; settings: SettingsStore } {
  const db = TenonDatabase.open(':memory:')
  return { db, settings: new SettingsStore(db) }
}

describe('全局额度的读写（纯函数这一层）', () => {
  it('没配过 = 两道闸都不设限', () => {
    const { settings } = fresh()
    expect(readGlobalBudget(settings)).toEqual(NO_GLOBAL_BUDGET)
  })

  it('形状坏了退回"不设限"，不让整个面板崩掉', () => {
    const { settings } = fresh()
    // 手工写一条垃圾（模拟旧版本 / 手改过库）
    settings.set({ 'budget.global': { monthly: '不是对象', oops: true } })
    expect(readGlobalBudget(settings)).toEqual(NO_GLOBAL_BUDGET)
  })

  it('负数与 NaN 落库时被规整成"不设"', () => {
    const { settings } = fresh()
    writeGlobalBudget(settings, {
      monthly: { maxCostUsd: -1, maxTokens: Number.NaN },
      lifetime: { maxCostUsd: 100, maxTokens: null },
    })
    const read = readGlobalBudget(settings)
    // 负数上限会让 `used >= limit` 永远成立 —— 等于把产品锁死
    expect(read.monthly).toEqual({ maxCostUsd: null, maxTokens: null })
    expect(read.lifetime.maxCostUsd).toBe(100)
  })

  it('★ 改额度不会碰到月初基线（两条记录分开存的理由）', () => {
    const { settings } = fresh()
    const base = { month: '2026-11', totals: { ...ZERO_USAGE, totalTokens: 4321 } }
    writeMonthBase(settings, base)

    writeGlobalBudget(settings, {
      monthly: { maxCostUsd: 20, maxTokens: null },
      lifetime: { maxCostUsd: null, maxTokens: null },
    })

    // 基线还在，且数值没被冲掉 —— 冲掉的话本月用量会归零，闸就永远不拦
    expect(readMonthBase(settings)).toEqual(base)
  })

  it('基线缺字段 / 类型不对 → 当作没有（调用方会重新落一次）', () => {
    const { settings } = fresh()
    settings.set({ [GLOBAL_BASE_KEY]: { month: '2026-11' } })
    expect(readMonthBase(settings)).toBeNull()

    settings.set({ [GLOBAL_BASE_KEY]: { month: 11, totals: ZERO_USAGE } })
    expect(readMonthBase(settings)).toBeNull()
  })

  it('hasAnyLimit：有一维设了才算配了闸', () => {
    expect(hasAnyLimit({ maxCostUsd: null, maxTokens: null })).toBe(false)
    expect(hasAnyLimit({ maxCostUsd: 0, maxTokens: null })).toBe(true)
    expect(hasAnyLimit({ maxCostUsd: null, maxTokens: 0 })).toBe(true)
  })
})

describe('currentMonth', () => {
  it('本地时区的年月，月份补零', () => {
    expect(currentMonth(new Date(2026, 0, 15))).toBe('2026-01')
    expect(currentMonth(new Date(2026, 10, 11, 23, 59))).toBe('2026-11')
    // 跨年
    expect(currentMonth(new Date(2027, 0, 1, 0, 0))).toBe('2027-01')
  })
})
