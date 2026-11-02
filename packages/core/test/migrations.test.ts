/**
 * 产品库迁移（`PRAGMA user_version`）。
 *
 * 这里只盯一件最贵的事：**迁移不许改写历史记录的含义**。
 *
 * 迁移 2 给 `releases` 加了门禁两列，但迁移 2 之前发出去的版本**没有跑过门禁** ——
 * 那时候还没有这个功能。如果给这两列一个 `'pass'` 默认值，历史发布会全部变成
 * "检查通过了"，而这是这个功能唯一不能出的错：留痕的价值全在"它说的是真的"。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, ReleaseStore, TenonDatabase } from '../src/index.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-migrate-'))
  file = join(dir, 'tenon.db')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 造一个「迁移 1 时代」的库：只跑第一个迁移，然后塞一条发布记录 */
function makeV1Database(): void {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  const first = MIGRATIONS[0] as (typeof MIGRATIONS)[number]
  db.exec(first.sql)
  db.exec(`PRAGMA user_version = ${first.version}`)
  db.exec(
    `INSERT INTO apps (id, name, slug, template_id, style_id, status, created_at, updated_at)
     VALUES ('app-old', '老应用', 'old', 'react-vite', NULL, 'idle', 1, 1)`,
  )
  db.exec(
    `INSERT INTO releases (id, app_id, version, commit_sha, kind, artifact_path, image_ref, notes, created_at)
     VALUES ('rel-old', 'app-old', 'v2026.10.01-1', 'deadbeef', 'push', '/tmp/backup', NULL, NULL, 1)`,
  )
  db.close()
}

describe('tenon.db 迁移', () => {
  it('从迁移 1 升到最新：老记录的 gateStatus 是 null，不是被伪造成 pass', () => {
    makeV1Database()

    const db = TenonDatabase.open(file)
    try {
      expect(db.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version)

      const releases = new ReleaseStore(db).list('app-old')
      expect(releases).toHaveLength(1)
      expect(releases[0]?.version).toBe('v2026.10.01-1')
      // 这一条是整个迁移的重点
      expect(releases[0]?.gateStatus).toBeNull()
      expect(releases[0]?.gateSummary).toBeNull()
    } finally {
      db.close()
    }
  })

  it('升完之后新写入的记录能带上门禁留痕', () => {
    makeV1Database()
    const db = TenonDatabase.open(file)
    try {
      const store = new ReleaseStore(db)
      const created = store.add({
        appId: 'app-old',
        version: 'v2026.11.02-1',
        commitSha: 'cafebabe',
        kind: 'push',
        gateStatus: 'forced',
        gateSummary: '类型检查 ✗ · 测试 ⏭',
      })
      expect(created.gateStatus).toBe('forced')
      expect(created.gateSummary).toBe('类型检查 ✗ · 测试 ⏭')

      // 两条并存：老的是 null，新的是 forced —— 不能互相影响
      const all = store.list('app-old')
      expect(all.map((release) => release.gateStatus)).toEqual(['forced', null])
    } finally {
      db.close()
    }
  })

  it('重复打开不会重跑迁移（版本号是幂等的）', () => {
    const first = TenonDatabase.open(file)
    const version = first.schemaVersion
    first.close()

    const second = TenonDatabase.open(file)
    try {
      expect(second.schemaVersion).toBe(version)
    } finally {
      second.close()
    }
  })
})
