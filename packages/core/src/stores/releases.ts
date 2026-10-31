import type { Release, ReleaseKind } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'
import { newId } from '../ids.js'

interface ReleaseRow {
  id: string
  app_id: string
  version: string
  commit_sha: string
  kind: string
  artifact_path: string | null
  image_ref: string | null
  notes: string | null
  created_at: number
}

function toRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    commitSha: row.commit_sha,
    kind: row.kind as ReleaseKind,
    artifactPath: row.artifact_path,
    imageRef: row.image_ref,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

export interface CreateReleaseInput {
  appId: string
  version: string
  commitSha: string
  kind: ReleaseKind
  artifactPath?: string | null
  imageRef?: string | null
  notes?: string | null
}

/** 发布记录。M1 只落地读写，真正的导出/推送在 M2 之后。 */
export class ReleaseStore {
  constructor(private readonly db: TenonDatabase) {}

  list(appId: string, limit = 20): Release[] {
    return this.db
      .all<ReleaseRow>(
        'SELECT * FROM releases WHERE app_id = ? ORDER BY created_at DESC LIMIT ?',
        appId,
        limit,
      )
      .map((row) => toRelease({ ...row }))
  }

  add(input: CreateReleaseInput): Release {
    const id = newId('rel')
    const createdAt = Date.now()
    this.db.run(
      `INSERT INTO releases (id, app_id, version, commit_sha, kind, artifact_path, image_ref, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.appId,
      input.version,
      input.commitSha,
      input.kind,
      input.artifactPath ?? null,
      input.imageRef ?? null,
      input.notes ?? null,
      createdAt,
    )
    const row = this.db.get<ReleaseRow>('SELECT * FROM releases WHERE id = ?', id)
    if (row === undefined) throw new Error('写入发布记录后读不回来')
    return toRelease({ ...row })
  }
}
