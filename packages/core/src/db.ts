/**
 * `tenon.db` —— 产品库（DESIGN §6.2）。
 *
 * 用 Node 内置 `node:sqlite`（22.5+），因此**安装包里没有任何需要按平台编译的依赖**
 * —— 这是 v1.2 的核心收益，别为了 ORM 好用换成 better-sqlite3。
 *
 * 迁移用 `PRAGMA user_version` 线性推进：M1 只有 1 号。往后每次改 schema 追加一项，
 * 永远不修改已发布的迁移。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        template_id TEXT NOT NULL,
        style_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_opened_at INTEGER
      );
      CREATE INDEX idx_apps_updated ON apps(updated_at DESC);

      CREATE TABLE releases (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_path TEXT,
        image_ref TEXT,
        notes TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_releases_app ON releases(app_id, created_at DESC);

      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT,
        api_key_enc BLOB,
        tier TEXT,
        model_id TEXT,
        params_json TEXT
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE error_groups (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT,
        count INTEGER DEFAULT 1,
        first_seen INTEGER,
        last_seen INTEGER,
        resolved_at INTEGER,
        payload_json TEXT
      );
      CREATE INDEX idx_error_groups_app ON error_groups(app_id, last_seen DESC);
    `,
  },
  {
    version: 2,
    name: 'release-gate',
    /*
     * 发布门禁的留痕（M4 第 7 步）。
     *
     * 两列都必须可空：迁移 2 之前的发布记录**没有跑过门禁**，那时候还没有这个功能。
     * 给个默认 `'pass'` 会把历史记录全部伪造成"检查通过了" —— 而这是这个功能唯一
     * 不能出的错：留痕的价值全在"它说的是真的"。
     */
    sql: `
      ALTER TABLE releases ADD COLUMN gate_status TEXT;
      ALTER TABLE releases ADD COLUMN gate_summary TEXT;
    `,
  },
  {
    version: 3,
    name: 'provider-prices',
    /*
     * 模型价格表（M5.5）。
     *
     * 为什么**单独一张表、而不是塞进 provider_profiles**：一个 provider 可以挂多个模型
     * （同一家厂商的 flash / pro 差价好几倍），塞进 profile 就只能记一个价，
     * 换个模型 id 就全错 —— 而错的代价是"额度算错"，用户不会发现，直到账单来。
     *
     * 单位固定 **美元 / 百万 token**（pi 的 `model.cost` 就是这个单位，用它省一次换算）。
     * 四列都给默认值 0：`cacheRead` / `cacheWrite` 大部分提供商不收钱，逼用户填是刁难。
     */
    sql: `
      CREATE TABLE provider_prices (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        input_per_mtok REAL NOT NULL DEFAULT 0,
        output_per_mtok REAL NOT NULL DEFAULT 0,
        cache_read_per_mtok REAL NOT NULL DEFAULT 0,
        cache_write_per_mtok REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        UNIQUE (profile_id, model_id)
      );
      CREATE INDEX idx_prices_profile ON provider_prices(profile_id);
    `,
  },
]

type Row = Record<string, unknown>

export class TenonDatabase {
  readonly file: string
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync, file: string) {
    this.db = db
    this.file = file
  }

  static open(file: string): TenonDatabase {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    // WAL：读写不互相阻塞；产品库是单机低并发，够用且比默认 rollback journal 稳
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    const instance = new TenonDatabase(db, file)
    instance.migrate()
    return instance
  }

  get schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version')
    return row?.user_version ?? 0
  }

  private migrate(): void {
    const current = this.schemaVersion
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(migration.sql)
        // PRAGMA 不接受参数绑定，只能拼；version 来自本文件的常量，不是外部输入
        this.db.exec(`PRAGMA user_version = ${migration.version}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw new Error(
          `tenon.db 迁移 ${migration.version}(${migration.name}) 失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  get<T>(sql: string, ...params: readonly unknown[]): T | undefined {
    const stmt = this.db.prepare(sql)
    return stmt.get(...(params as never[])) as T | undefined
  }

  all<T>(sql: string, ...params: readonly unknown[]): T[] {
    const stmt = this.db.prepare(sql)
    return stmt.all(...(params as never[])) as T[]
  }

  run(sql: string, ...params: readonly unknown[]): { changes: number; lastInsertRowid: number } {
    const stmt = this.db.prepare(sql)
    const result = stmt.run(...(params as never[]))
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  /** `BEGIN IMMEDIATE` 事务：先拿写锁，避免升级锁时死等 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}

export function asRow<T extends object>(row: Row | undefined): T | undefined {
  return row === undefined ? undefined : ({ ...row } as T)
}

export function asRows<T extends object>(rows: Row[]): T[] {
  return rows.map((row) => ({ ...row }) as T)
}
