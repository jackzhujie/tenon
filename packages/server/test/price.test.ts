/**
 * 模型价格（M5.5）：没有它，「按美元设额度」对 BYOK 用户完全失效。
 *
 * 没有价格表时 `usage.cost.total` 恒为 0 —— 面板上那个 $0.00 不是"便宜"，是"没算"。
 * 这比不给额度更糟：用户会以为自己在安全范围内。
 *
 * 这里钉住四件事：
 * 1. 价格挂在 (provider, 模型) 上，一个 provider 可以有多条（一对一家的 flash/pro）
 * 2. 配了价格之后 `usage.get` 的 `priced` 变 true（界面据此决定显示 $ 还是「未定价」）
 * 3. 删 provider 时它的价格一起走（否则同一家再建 provider 会张冠李戴）
 * 4. 改价格会让当前模型重新解析（否则填了价，面板还是 $0.00）
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, rpc } from './support.js'
import type { RunningServer } from '../src/index.js'

interface ModelState {
  model: { mode: string; providerId: string; modelId: string } | null
  error: string | null
  changed: boolean
}

let dir: string | undefined
let running: RunningServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function withProvider(): Promise<{ profileId: string; appId: string }> {
  dir = await mkdtemp(join(tmpdir(), 'tenon-price-'))
  // 不装依赖、不联网：这一组只验记账
  running = await boot(dir, { env: { TENON_FAUX: '' } })
  const saved = await rpc<{ profile: { id: string } }>(running, 'provider.upsert', {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    modelId: 'deepseek-flash',
    apiKey: 'sk-test',
  })
  const created = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '记账' })
  return { profileId: saved.profile.id, appId: created.app.id }
}

describe('模型价格', () => {
  it('一个 provider 可以挂多个模型的价格', async () => {
    const { profileId } = await withProvider()
    await rpc(running!, 'price.set', {
      profileId,
      modelId: 'deepseek-flash',
      inputPerMTok: 0.14,
      outputPerMTok: 0.28,
    })
    await rpc(running!, 'price.set', {
      profileId,
      modelId: 'deepseek-v4-pro',
      inputPerMTok: 1.4,
      outputPerMTok: 2.8,
    })

    const listed = await rpc<{ prices: { modelId: string; inputPerMTok: number }[] }>(
      running!,
      'price.list',
      { profileId },
    )
    expect(listed.prices.map((price) => price.modelId).sort()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(listed.prices.find((price) => price.modelId === 'deepseek-v4-pro')?.inputPerMTok).toBe(1.4)
  })

  it('同一个模型再写一次是改价，不会长出两行', async () => {
    const { profileId } = await withProvider()
    await rpc(running!, 'price.set', { profileId, modelId: 'm', inputPerMTok: 1, outputPerMTok: 2 })
    await rpc(running!, 'price.set', { profileId, modelId: 'm', inputPerMTok: 3, outputPerMTok: 4 })

    const listed = await rpc<{ prices: { inputPerMTok: number }[] }>(running!, 'price.list', {
      profileId,
    })
    expect(listed.prices).toHaveLength(1)
    expect(listed.prices[0]?.inputPerMTok).toBe(3)
  })

  it('配了价格 → usage 的 priced 变 true；删掉价格 → 变回 false', async () => {
    const { profileId, appId } = await withProvider()

    const before = await rpc<{ snapshot: { priced: boolean } }>(running!, 'usage.get', { appId })
    expect(before.snapshot.priced).toBe(false)

    const saved = await rpc<{ price: { id: string }; applied: ModelState }>(
      running!,
      'price.set',
      { profileId, modelId: 'deepseek-flash', inputPerMTok: 0.14, outputPerMTok: 0.28 },
    )
    // 改价要重建模型：cost 是在解析那一刻烤进 provider 的
    expect(saved.applied.changed).toBe(true)

    const after = await rpc<{ snapshot: { priced: boolean } }>(running!, 'usage.get', { appId })
    expect(after.snapshot.priced).toBe(true)

    await rpc(running!, 'price.remove', { id: saved.price.id })
    const removed = await rpc<{ snapshot: { priced: boolean } }>(running!, 'usage.get', { appId })
    expect(removed.snapshot.priced).toBe(false)
  })

  it('删 provider 时它的价格一起走', async () => {
    const { profileId } = await withProvider()
    await rpc(running!, 'price.set', { profileId, modelId: 'x', inputPerMTok: 1, outputPerMTok: 1 })

    await rpc(running!, 'provider.delete', { id: profileId })
    const listed = await rpc<{ prices: unknown[] }>(running!, 'price.list', {})
    expect(listed.prices).toHaveLength(0)
  })
})
