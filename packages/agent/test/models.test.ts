/**
 * 价格 → `model.cost` 的映射。
 *
 * 这个函数只做一件事，但它错了就是三个数量级的账：pi 的 `model.cost` 单位是
 * **美元 / 百万 token**，价格表也是这个单位，所以**不做任何换算**。
 * 单测在这里守着"别顺手乘除"。
 */
import { describe, expect, it } from 'vitest'
import { modelCost } from '../src/models.js'
import type { ModelPrice } from '@tenon/protocol'

function coreOf(prices: ModelPrice[]): { prices: { find(profileId: string, modelId: string): ModelPrice | undefined } } {
  return {
    prices: {
      find: (profileId, modelId) =>
        prices.find((price) => price.profileId === profileId && price.modelId === modelId),
    },
  }
}

function price(overrides: Partial<ModelPrice> = {}): ModelPrice {
  return {
    id: 'price-1',
    profileId: 'prov-1',
    modelId: 'm',
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('价格映射', () => {
  it('原样交给 pi，不做换算', () => {
    const cost = modelCost(coreOf([price()]), 'prov-1', 'm')
    expect(cost).toEqual({ input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 })
  })

  it('没有这条价格 → 全 0（pi 算出来就是 $0，界面要显示"未定价"而不是 $0.00）', () => {
    expect(modelCost(coreOf([]), 'prov-1', 'm')).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('同名模型挂在别的 provider 上不算数', () => {
    const cost = modelCost(coreOf([price({ profileId: 'other' })]), 'prov-1', 'm')
    expect(cost.input).toBe(0)
  })

  it('缓存读写价也带过去', () => {
    const cost = modelCost(
      coreOf([price({ cacheReadPerMTok: 0.014, cacheWritePerMTok: 0.28 })]),
      'prov-1',
      'm',
    )
    expect(cost.cacheRead).toBe(0.014)
    expect(cost.cacheWrite).toBe(0.28)
  })
})
