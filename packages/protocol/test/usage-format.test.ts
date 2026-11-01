/**
 * 用量展示格式（M4 第 3 步）。
 *
 * 这些函数被服务端的拦截文案与浏览器的面板共用，所以断言要钉住**具体写法**：
 * `$0` / `<$0.01` / `$0.123` 三档混了，用户在两个地方看到的数就不一样。
 */
import { describe, expect, it } from 'vitest'
import { budgetMessage, formatCost, formatTokens } from '../src/usage-format.js'
import type { Budget, UsageTotals } from '../src/domain.js'

const totals = (patch: Partial<UsageTotals> = {}): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costUsd: 0,
  ...patch,
})

const budget = (patch: Partial<Budget> = {}): Budget => ({
  maxCostUsd: null,
  maxTokens: null,
  ...patch,
})

describe('formatTokens', () => {
  it('只表示量级', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(45_600)).toBe('46k')
    expect(formatTokens(2_400_000)).toBe('2.4M')
  })

  it('负数与非数字都当 0（面板上出现 NaN 比不显示更糟）', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
  })
})

describe('formatCost', () => {
  it('零、小额、正常三档分开写', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.0042)).toBe('<$0.01')
    expect(formatCost(0.1234)).toBe('$0.123')
    expect(formatCost(12.345)).toBe('$12.35')
    expect(formatCost(Number.NaN)).toBe('$0')
  })
})

describe('budgetMessage', () => {
  it('按维度说出用了多少、上限多少', () => {
    const tokensMsg = budgetMessage(totals({ totalTokens: 12_000 }), budget({ maxTokens: 10_000 }), 'tokens')
    expect(tokensMsg).toContain('12k tokens')
    expect(tokensMsg).toContain('10k tokens')

    const costMsg = budgetMessage(totals({ costUsd: 5.5 }), budget({ maxCostUsd: 5 }), 'cost')
    expect(costMsg).toContain('$5.50')
    expect(costMsg).toContain('上限 $5.00')
  })

  it('告诉用户下一步该做什么，而不是只说"超了"', () => {
    expect(budgetMessage(totals(), budget({ maxTokens: 1 }), 'tokens')).toContain('调高上限')
  })
})
