/**
 * 用量与预算的算术（M4 第 3 步）。
 *
 * 这一层全是纯函数，所以断言可以精确到"哪一个维度、用 `>=` 还是 `>`"。
 * 拦截逻辑的正确性最终靠这些：上层的集成测试只能验"拦住了"，验不了"为什么在这一格拦住"。
 */
import type { Budget } from '@tenon/protocol'
import { describe, expect, it } from 'vitest'
import {
  addUsage,
  breached,
  diffUsage,
  levelOf,
  sumUsage,
  totalsOf,
  ZERO_USAGE,
} from '../src/usage.js'

const budget = (over: Partial<Budget> = {}): Budget => ({
  maxCostUsd: null,
  maxTokens: null,
  ...over,
})

describe('totalsOf', () => {
  it('把 pi 的 Usage 映射成我们的计数（成本取 cost.total）', () => {
    const totals = totalsOf({
      input: 100,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
      totalTokens: 460,
      cost: { total: 0.0123 },
    })
    expect(totals).toEqual({
      input: 100,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
      totalTokens: 460,
      costUsd: 0.0123,
    })
  })

  it('缺 totalTokens 时自己加 —— 这一格缺了 token 上限就永远拦不住', () => {
    const totals = totalsOf({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 })
    expect(totals.totalTokens).toBe(20)
  })

  it('字段全缺 / undefined 输入都给零，不抛', () => {
    expect(totalsOf(undefined)).toEqual(ZERO_USAGE)
    expect(totalsOf({})).toEqual(ZERO_USAGE)
    // 宿主把数字写成字符串时当 0（宁可少报，也别让 NaN 污染整本账）
    expect(totalsOf({ input: '12' as unknown as number }).totalTokens).toBe(0)
  })
})

describe('sumUsage', () => {
  it('models 与 tools 都计入总量，但分桶各自保留', () => {
    const { totals, models, tools } = sumUsage({
      models: { 'faux/mini': { input: 100, output: 10, totalTokens: 110 } },
      tools: { bash: { input: 20, output: 2, totalTokens: 22 } },
    })
    expect(totals.totalTokens).toBe(132)
    expect(models['faux/mini']?.input).toBe(100)
    expect(tools['bash']?.totalTokens).toBe(22)
  })

  it('空账本是零，不是 undefined', () => {
    expect(sumUsage({})).toEqual({ totals: ZERO_USAGE, models: {}, tools: {} })
    expect(sumUsage({ models: {} }).totals).toEqual(ZERO_USAGE)
  })
})

describe('diffUsage', () => {
  it('逐项相减', () => {
    const turn = diffUsage({ ...ZERO_USAGE, totalTokens: 130, costUsd: 0.5 }, {
      ...ZERO_USAGE,
      totalTokens: 100,
      costUsd: 0.2,
    })
    expect(turn.totalTokens).toBe(30)
    expect(turn.costUsd).toBeCloseTo(0.3)
  })

  it('基数比现在大时夹到 0 —— 面板上出现负数用量是纯粹的胡说', () => {
    const turn = diffUsage({ ...ZERO_USAGE, totalTokens: 5 }, { ...ZERO_USAGE, totalTokens: 100 })
    expect(turn.totalTokens).toBe(0)
  })
})

describe('breached / levelOf', () => {
  it('两条线都没设 = 永不拦，哪怕已经花了很多', () => {
    const totals = { ...ZERO_USAGE, totalTokens: 9_999_999, costUsd: 999 }
    expect(breached(totals, budget())).toBeNull()
    expect(levelOf(totals, budget())).toBe('ok')
  })

  it('用满就是没有余额（>= 而不是 >）', () => {
    const totals = { ...ZERO_USAGE, totalTokens: 1000 }
    expect(breached(totals, budget({ maxTokens: 1000 }))).toBe('tokens')
    expect(breached(totals, budget({ maxTokens: 1001 }))).toBeNull()
  })

  it('上限设 0 等于关掉这个应用，不是"不设限"', () => {
    expect(breached(ZERO_USAGE, budget({ maxTokens: 0 }))).toBe('tokens')
  })

  it('钱够了但 token 没够也拦，反之亦然', () => {
    const totals = { ...ZERO_USAGE, totalTokens: 10, costUsd: 5 }
    expect(breached(totals, budget({ maxCostUsd: 1 }))).toBe('cost')
    expect(breached(totals, budget({ maxCostUsd: 1, maxTokens: 1000 }))).toBe('cost')
    expect(breached(totals, budget({ maxCostUsd: 100, maxTokens: 5 }))).toBe('tokens')
  })

  it('八成给出 warn（不拦），过了就 over', () => {
    expect(levelOf({ ...ZERO_USAGE, totalTokens: 790 }, budget({ maxTokens: 1000 }))).toBe('ok')
    expect(levelOf({ ...ZERO_USAGE, totalTokens: 800 }, budget({ maxTokens: 1000 }))).toBe('warn')
    expect(levelOf({ ...ZERO_USAGE, totalTokens: 1000 }, budget({ maxTokens: 1000 }))).toBe('over')
    // 上限 0 时别去算比例（0 做分母）
    expect(levelOf(ZERO_USAGE, budget({ maxTokens: 0 }))).toBe('over')
  })
})

describe('addUsage', () => {
  it('逐项相加（只加非零的桶不该丢字段）', () => {
    const sum = addUsage({ ...ZERO_USAGE, input: 1 }, { ...ZERO_USAGE, output: 2 })
    expect(sum).toEqual({ ...ZERO_USAGE, input: 1, output: 2 })
  })
})
