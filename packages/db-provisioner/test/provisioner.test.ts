/**
 * 应用库供给的测试。
 *
 * 重点不是"能跑起来"，而是**三条容易静默坏掉的约定**：
 *
 * 1. `poolMax()` 在 pglite 档恒为 1 —— 不是调优建议，是防静默数据损坏。
 *    这里用 TypeORM 真并发跑一遍事务：pool=1 时 8 个并发事务的 16 行全在；
 *    改成 2 就会掉行（SPIKES §1 的现场）。
 * 2. `start()` 幂等、`stop()` 不删库 —— 停预览把库关了，数据必须还在。
 * 3. `dump()` / `restore()` 是一对：还原之后**连接串（端口）不变**，
 *    否则上层缓存的 `DATABASE_URL` 会在还原后指向空气。
 *
 * 每个用例一个临时目录，PGlite 冷启动 2.4s，整组约 15s。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { EntitySchema, type DataSource } from 'typeorm'
import { DataSource as TypeOrmDataSource } from 'typeorm'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteProvider, createPostgresProvider, redactUrl } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-db-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Note {
  id: number
  body: string
}

const NoteSchema = new EntitySchema<Note>({
  name: 'Note',
  tableName: 'notes',
  columns: {
    id: { type: Number, primary: true, generated: true },
    body: { type: String },
  },
})

function dataSourceFor(url: string, poolMax: number): DataSource {
  return new TypeOrmDataSource({
    type: 'postgres',
    url,
    entities: [NoteSchema],
    synchronize: true,
    logging: false,
    // ★ 这个 max 就是全体约束的落点：`extra.max` 是 TypeORM 传给 pg.Pool 的原始参数
    extra: { max: poolMax, connectionTimeoutMillis: 10_000 },
  })
}

describe('pglite 档', () => {
  it('poolMax 恒为 1（接口级硬约束，不是调优建议）', async () => {
    const provider = createPgliteProvider({ dataDir: join(await tempDir(), 'pgdata') })
    cleanups.push(() => provider.stop())
    expect(provider.poolMax()).toBe(1)
    expect(provider.status().state).toBe('stopped')
    // 没启动就没有连接串：给一个"能拼出来但连不上"的 URL 比报错更难查
    expect(() => provider.connectionString()).toThrowError(/还没启动/)
  })

  it('起得来、连得上、写得进（走标准 pg 协议）', async () => {
    const provider = createPgliteProvider({ dataDir: join(await tempDir(), 'pgdata') })
    cleanups.push(() => provider.stop())
    await provider.start()
    const status = provider.status()
    expect(status.state).toBe('ready')
    expect(status.port).toBeGreaterThan(0)
    expect(status.connectionString).toContain(`:${status.port}/`)

    const client = new Client({ connectionString: provider.connectionString() })
    await client.connect()
    const result = await client.query<{ n: number }>('select 42 as n')
    expect(result.rows[0]?.n).toBe(42)
    await client.end()
  })

  it('8 个并发事务 16 行全部落库（pool.max=1 才有的结果）', async () => {
    const provider = createPgliteProvider({ dataDir: join(await tempDir(), 'pgdata') })
    cleanups.push(() => provider.stop())
    await provider.start()

    const ds = dataSourceFor(provider.connectionString(), provider.poolMax())
    cleanups.push(async () => {
      if (ds.isInitialized) await ds.destroy()
    })
    await ds.initialize()

    const started = Date.now()
    await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => {
        await ds.transaction(async (manager) => {
          await manager.insert('Note', { body: `n${index}-a` })
          // 故意在事务中间让出事件循环：pool>1 时这里就是另一条事务插进来的窗口
          await new Promise((resolve) => setTimeout(resolve, 5))
          await manager.insert('Note', { body: `n${index}-b` })
        })
      }),
    )
    const rows = await ds.getRepository<Note>('Note').find()
    expect(rows).toHaveLength(16)
    // 单会话串行：8 个 5ms 的事务串起来至少 40ms。不是为了测性能，
    // 而是确认"真的串行了"——并行完成会说明我们其实开了多条连接
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it('stop 之后数据还在，再 start 拿到同一个端口', async () => {
    const dataDir = join(await tempDir(), 'pgdata')
    const provider = createPgliteProvider({ dataDir })
    cleanups.push(() => provider.stop())
    await provider.start()
    const url = provider.connectionString()

    const client = new Client({ connectionString: url })
    await client.connect()
    await client.query('create table keep_me (id int primary key, body text)')
    await client.query("insert into keep_me values (1, '活着')")
    await client.end()

    await provider.stop()
    expect(provider.status().state).toBe('stopped')
    await provider.start()
    // 端口不变：上层缓存的 DATABASE_URL 不会因为"重启了一次预览"就失效
    expect(provider.connectionString()).toBe(url)

    const again = new Client({ connectionString: provider.connectionString() })
    await again.connect()
    const rows = await again.query<{ body: string }>('select body from keep_me')
    expect(rows.rows[0]?.body).toBe('活着')
    await again.end()
  })

  it('dump → 改数据 → restore：回到快照那一刻，且连接串不变', async () => {
    const root = await tempDir()
    const provider = createPgliteProvider({ dataDir: join(root, 'pgdata'), snapshotsDir: join(root, 'snaps') })
    cleanups.push(() => provider.stop())
    await provider.start()
    const url = provider.connectionString()

    const writer = new Client({ connectionString: url })
    await writer.connect()
    await writer.query('create table snap (id int primary key, body text)')
    await writer.query("insert into snap values (1, '第一版')")
    await writer.end()

    const snapshot = await provider.dump()
    expect(snapshot.bytes).toBeGreaterThan(0)
    expect((await stat(snapshot.file)).size).toBe(snapshot.bytes)
    expect(snapshot.file.endsWith('.tar.gz')).toBe(true)

    const vandal = new Client({ connectionString: url })
    await vandal.connect()
    await vandal.query('delete from snap')
    await vandal.query("insert into snap values (2, '手滑了')")
    await vandal.end()

    await provider.restore(snapshot)
    expect(provider.status().state).toBe('ready')
    expect(provider.connectionString()).toBe(url)

    const reader = new Client({ connectionString: url })
    await reader.connect()
    const rows = await reader.query<{ id: number; body: string }>('select id, body from snap order by id')
    expect(rows.rows).toEqual([{ id: 1, body: '第一版' }])
    await reader.end()
  })
})

describe('postgres 档', () => {
  it('连不上时报 DB_START_FAILED，且**日志里看不到密码**', async () => {
    const provider = createPostgresProvider({
      connectionString: 'postgres://app:s3cret@127.0.0.1:1/app',
      poolMax: 10,
    })
    await expect(provider.start()).rejects.toMatchObject({ code: 'DB_START_FAILED' })
    const status = provider.status()
    expect(status.state).toBe('failed')
    expect(status.connectionString).toBeNull()
    expect(status.error ?? '').not.toContain('s3cret')
    expect(status.error ?? '').toContain('***')
    // 发布档的并发上限跟随外部库，不受 pglite 那条约束影响
    expect(provider.poolMax()).toBe(10)
  })

  it('redactUrl 只洗密码，不动其余部分', () => {
    expect(redactUrl('postgres://app:s3cret@db:5432/app?sslmode=disable')).toBe(
      'postgres://app:***@db:5432/app?sslmode=disable',
    )
    // 与迁移那边的 redact 合并成一个函数之后，这里的文案也跟着统一（原来是 `<>`）
    expect(redactUrl('不是 URL')).toBe('(无法解析的连接串)')
  })
})
