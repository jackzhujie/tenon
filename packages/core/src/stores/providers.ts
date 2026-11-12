/**
 * 模型提供商配置（BYOK）。
 *
 * 对外契约里**永远没有明文密钥**（`ProviderProfile.hasApiKey` 只是布尔），
 * 明文只经 `SecretBox` 加密后进 `api_key_enc`。
 */
import type { ModelTier, ProviderKind, ProviderProfile } from '@tenon/protocol'
import { msg, TenonError } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'
import { newId } from '../ids.js'
import type { SecretBox } from '../secrets.js'

interface ProfileRow {
  id: string
  label: string
  kind: string
  base_url: string | null
  api_key_enc: Uint8Array | null
  tier: string | null
  model_id: string | null
  params_json: string | null
}

function toProfile(row: ProfileRow): ProviderProfile {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as ProviderKind,
    baseUrl: row.base_url,
    tier: (row.tier ?? 'auto') as ModelTier,
    modelId: row.model_id ?? '',
    paramsJson: row.params_json,
    hasApiKey: row.api_key_enc !== null && row.api_key_enc !== undefined,
  }
}

export interface UpsertProviderInput {
  id?: string | undefined
  label: string
  kind: ProviderKind
  baseUrl: string | null
  tier: ModelTier
  modelId: string
  paramsJson: string | null
  apiKey: string | null
}

export class ProviderStore {
  constructor(
    private readonly db: TenonDatabase,
    private readonly box: SecretBox,
  ) {}

  list(): ProviderProfile[] {
    return this.db
      .all<ProfileRow>('SELECT * FROM provider_profiles ORDER BY label')
      .map((row) => toProfile({ ...row }))
  }

  find(id: string): ProviderProfile | undefined {
    const row = this.db.get<ProfileRow>('SELECT * FROM provider_profiles WHERE id = ?', id)
    return row === undefined ? undefined : toProfile({ ...row })
  }

  /** 只有 agent 层需要明文；明文不进任何 API 响应 */
  revealApiKey(id: string): string | undefined {
    const row = this.db.get<ProfileRow>('SELECT * FROM provider_profiles WHERE id = ?', id)
    if (row?.api_key_enc === null || row === undefined) return undefined
    return this.box.unseal(row.api_key_enc)
  }

  upsert(input: UpsertProviderInput): ProviderProfile {
    const id = input.id ?? newId('prov')
    const existing = this.find(id)
    if (input.id !== undefined && existing === undefined) {
      throw new TenonError('APP_NOT_FOUND', msg('error.provider.notFound', { id: input.id }))
    }
    const sealed = input.apiKey === null ? undefined : this.box.seal(input.apiKey)

    this.db.transaction(() => {
      if (existing === undefined) {
        this.db.run(
          `INSERT INTO provider_profiles (id, label, kind, base_url, api_key_enc, tier, model_id, params_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.label,
          input.kind,
          input.baseUrl,
          sealed ?? null,
          input.tier,
          input.modelId,
          input.paramsJson,
        )
        return
      }
      // apiKey 传 null = 保留原密钥；要清空请显式调 delete 后重建（避免误抹掉用户密钥）
      if (sealed === undefined) {
        this.db.run(
          `UPDATE provider_profiles SET label = ?, kind = ?, base_url = ?, tier = ?, model_id = ?, params_json = ?
           WHERE id = ?`,
          input.label,
          input.kind,
          input.baseUrl,
          input.tier,
          input.modelId,
          input.paramsJson,
          id,
        )
      } else {
        this.db.run(
          `UPDATE provider_profiles SET label = ?, kind = ?, base_url = ?, api_key_enc = ?, tier = ?, model_id = ?, params_json = ?
           WHERE id = ?`,
          input.label,
          input.kind,
          input.baseUrl,
          sealed,
          input.tier,
          input.modelId,
          input.paramsJson,
          id,
        )
      }
    })

    const profile = this.find(id)
    if (profile === undefined) throw new TenonError('INTERNAL', msg('error.provider.unreadable'))
    return profile
  }

  delete(id: string): void {
    const result = this.db.run('DELETE FROM provider_profiles WHERE id = ?', id)
    if (result.changes === 0) throw new TenonError('APP_NOT_FOUND', msg('error.provider.notFound', { id }))
  }
}
