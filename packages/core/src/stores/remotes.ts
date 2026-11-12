/**
 * 每个应用的远端仓库（`app_remotes`）。
 *
 * 这个 store 是**唯一**碰得到令牌明文的地方，而且只在 `reveal()` 里 —— 其余接口
 * 一律只回答"有没有"和尾四位。想加"显示令牌"按钮的人先读完这句话：回显之后，
 * 它就等于写在配置文件里，加密也就白做了。
 */
import type { ReleaseRemote } from '@tenon/protocol'
import { msg, TenonError } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'
import type { SecretBox } from '../secrets.js'

interface RemoteRow {
  app_id: string
  url: string
  username: string | null
  token_enc: Uint8Array | null
  branch: string
  updated_at: number
}

export interface UpsertRemoteInput {
  appId: string
  url: string
  username?: string | null
  /** 空串 / null 表示"不动已有的令牌"，不是"清掉" —— 改个 url 不该逼人重填令牌 */
  token?: string | null
  branch?: string
}

/**
 * 只允许 HTTPS，且拒绝把凭据写在 URL 里。
 *
 * 两条都是硬要求，不是洁癖：
 * - `http://` 会把令牌明文发到线上，而用户填的往往是"我自己服务器"的内网地址，
 *   他以为没人看得见
 * - `https://user:pass@host/repo` 这种写法会被原样存库、原样显示在界面上。用户从别处
 *   粘过来时根本不会注意到自己把密码带进来了
 */
export function assertSafeRemoteUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new TenonError('VALIDATION_FAILED', msg('error.remote.badUrl', { url: raw }))
  }
  if (parsed.protocol !== 'https:') {
    throw new TenonError('VALIDATION_FAILED', msg('error.remote.notHttps'))
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TenonError(
      'VALIDATION_FAILED',
      msg('error.secret.urlCredentials'),
    )
  }
  return parsed
}

function toRemote(row: RemoteRow, box: SecretBox): ReleaseRemote {
  const token = revealOrNull(row.token_enc, box)
  return {
    appId: row.app_id,
    url: row.url,
    username: row.username,
    branch: row.branch,
    hasToken: token !== null,
    tokenHint: token === null ? null : `…${token.slice(-4)}`,
    updatedAt: row.updated_at,
  }
}

function revealOrNull(blob: Uint8Array | null, box: SecretBox): string | null {
  if (blob === null || blob.byteLength === 0) return null
  try {
    return box.unseal(blob)
  } catch {
    // 换过机器 / 删过 secret.key：密文解不开。对外表现成"没配令牌"，
    // 而不是让整个发布页崩掉 —— 用户重新填一次就好
    return null
  }
}

export class RemoteStore {
  constructor(
    private readonly db: TenonDatabase,
    private readonly box: SecretBox,
  ) {}

  get(appId: string): ReleaseRemote | null {
    const row = this.db.get<RemoteRow>('SELECT * FROM app_remotes WHERE app_id = ?', appId)
    return row === undefined ? null : toRemote(row, this.box)
  }

  /** 明文令牌。**只给推送用**，不要把这个方法的返回值往外传 */
  reveal(appId: string): { url: string; username: string | null; token: string | null; branch: string } | null {
    const row = this.db.get<RemoteRow>('SELECT * FROM app_remotes WHERE app_id = ?', appId)
    if (row === undefined) return null
    return {
      url: row.url,
      username: row.username,
      token: revealOrNull(row.token_enc, this.box),
      branch: row.branch,
    }
  }

  upsert(input: UpsertRemoteInput): ReleaseRemote {
    const parsed = assertSafeRemoteUrl(input.url.trim())
    const branch = (input.branch ?? 'main').trim() === '' ? 'main' : (input.branch ?? 'main').trim()
    const existing = this.db.get<RemoteRow>('SELECT * FROM app_remotes WHERE app_id = ?', input.appId)

    // 令牌的三种情况：给了新的 → 覆盖；明确传 null/'' → 保持原样；原来就没有 → 仍是 null
    const token = input.token?.trim() ?? ''
    const sealed =
      token === ''
        ? (existing?.token_enc ?? null)
        : this.box.seal(token)

    this.db.run(
      `INSERT INTO app_remotes (app_id, url, username, token_enc, branch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         url = excluded.url,
         username = excluded.username,
         token_enc = excluded.token_enc,
         branch = excluded.branch,
         updated_at = excluded.updated_at`,
      input.appId,
      parsed.toString(),
      input.username?.trim() || null,
      sealed,
      branch,
      Date.now(),
    )
    return this.get(input.appId) as ReleaseRemote
  }

  clear(appId: string): void {
    this.db.run('DELETE FROM app_remotes WHERE app_id = ?', appId)
  }
}
