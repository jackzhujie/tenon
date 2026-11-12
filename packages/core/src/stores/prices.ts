/**
 * 模型价格表（M5.5）：一个 provider 可以挂多个模型，所以它是独立的一张表。
 *
 * 为什么必须有这张表：没有它，`usage.cost.total` 恒为 0（pi 用 `model.cost` 算钱），
 * 于是「按美元设额度」对 BYOK 用户**完全失效** —— 界面上那个 $0.00 不是"便宜"，
 * 是"没算"。这比不给额度更糟：用户会以为自己在安全范围内。
 *
 * 单位：**美元 / 百万 token**。与 pi 的 `model.cost` 一致，不做二次换算。
 */
import { msg, type ModelPrice } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'
import { newId } from '../ids.js'

interface PriceRow {
  id: string
  profile_id: string
  model_id: string
  input_per_mtok: number
  output_per_mtok: number
  cache_read_per_mtok: number
  cache_write_per_mtok: number
  updated_at: number
}

function toPrice(row: PriceRow): ModelPrice {
  return {
    id: row.id,
    profileId: row.profile_id,
    modelId: row.model_id,
    inputPerMTok: row.input_per_mtok,
    outputPerMTok: row.output_per_mtok,
    cacheReadPerMTok: row.cache_read_per_mtok,
    cacheWritePerMTok: row.cache_write_per_mtok,
    updatedAt: row.updated_at,
  }
}

export interface UpsertPriceInput {
  id?: string | undefined
  profileId: string
  modelId: string
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

export class PriceStore {
  constructor(private readonly db: TenonDatabase) {}

  list(profileId?: string): ModelPrice[] {
    const rows =
      profileId === undefined
        ? this.db.all<PriceRow>('SELECT * FROM provider_prices ORDER BY profile_id, model_id')
        : this.db.all<PriceRow>(
            'SELECT * FROM provider_prices WHERE profile_id = ? ORDER BY model_id',
            profileId,
          )
    return rows.map((row) => toPrice({ ...row }))
  }

  /** 精确到「哪个 provider 的哪个模型」—— 同名模型在不同 provider 上价格不一样 */
  find(profileId: string, modelId: string): ModelPrice | undefined {
    const row = this.db.get<PriceRow>(
      'SELECT * FROM provider_prices WHERE profile_id = ? AND model_id = ?',
      profileId,
      modelId,
    )
    return row === undefined ? undefined : toPrice({ ...row })
  }

  /**
   * 按 (profileId, modelId) 唯一：同一条再写就是改价，不会长出两行。
   * 唯一索引在表上，这里靠 `ON CONFLICT` 而不是"先查再写"（后者并发下会插两条）。
   */
  upsert(input: UpsertPriceInput): ModelPrice {
    const now = Date.now()
    this.db.run(
      `INSERT INTO provider_prices
         (id, profile_id, model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, model_id) DO UPDATE SET
         input_per_mtok = excluded.input_per_mtok,
         output_per_mtok = excluded.output_per_mtok,
         cache_read_per_mtok = excluded.cache_read_per_mtok,
         cache_write_per_mtok = excluded.cache_write_per_mtok,
         updated_at = excluded.updated_at`,
      input.id ?? newId('price'),
      input.profileId,
      input.modelId,
      input.inputPerMTok,
      input.outputPerMTok,
      input.cacheReadPerMTok,
      input.cacheWritePerMTok,
      now,
    )
    const saved = this.find(input.profileId, input.modelId)
    if (saved === undefined) throw new Error(msg('error.prices.readBack'))
    return saved
  }

  remove(id: string): boolean {
    const before = this.db.get<{ id: string }>('SELECT id FROM provider_prices WHERE id = ?', id)
    if (before === undefined) return false
    this.db.run('DELETE FROM provider_prices WHERE id = ?', id)
    return true
  }

  /** 删 provider 时一并清掉它的价格（外键 CASCADE 之外再兜一层，测试里也能直接调） */
  removeByProfile(profileId: string): number {
    const rows = this.list(profileId)
    this.db.run('DELETE FROM provider_prices WHERE profile_id = ?', profileId)
    return rows.length
  }
}
