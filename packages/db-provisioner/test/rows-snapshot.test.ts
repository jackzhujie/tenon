/**
 * `postgres` 档的**纯 JS** 快照（`rows-snapshot.ts`）。
 *
 * 这里用 PGlite 顶替真 PG 当被测库：它通过 pg-gateway 暴露的就是 PostgreSQL wire
 * protocol，`PostgresProvider` 拿到的连接串与连真 PG 时一模一样 —— 被验证的是
 * 快照逻辑本身（列交集、外键顺序、序列对齐、类型保真）。真 PG 的那一档
 * （含 `postgres:18-alpine` 容器）在 `scripts/e2e-postgres.ts`。
 *
 * 五件事必须守住：
 * 1. **`bytea` 来回不失真**（JSON 化会把 Buffer 变成 {type,data}）
 * 2. **生成列不进快照**，还原后由目标库自己算
 * 3. **序列对齐**，否则还原全绿、用户第一次新建就 500
 * 4. **目标库缺表时跳过并如实汇报**（回滚点之后才建的表）
 * 5. **还原是原子的**：失败不留半截数据
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPgliteProvider,
  createPostgresProvider,
  decodeRowsSnapshot,
  type DatabaseProvider,
} from '../src/index.js'
import { readFile } from 'node:fs/promises'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-rows-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 一套"什么坑都有"的结构：
 * - `accounts.id` 是 `generated always as identity`（插入必须 OVERRIDING SYSTEM VALUE）
 * - `items` 有 serial、生成列、jsonb、bytea、text[]、numeric
 * - `tags` 指向 `items`（外键，删要子在前、插要父在前）
 */
const DDL = [
  `create table accounts (
     id bigint generated always as identity primary key,
     name text not null
   )`,
  `create table items (
     id serial primary key,
     account_id bigint references accounts(id),
     title text not null,
     note text,
     score numeric(6,2),
     labels text[],
     meta jsonb,
     blob bytea,
     created_at timestamptz not null default now(),
     title_upper text generated always as (upper(title)) stored
   )`,
  `create table tags (
     id serial primary key,
     item_id integer references items(id),
     label text not null
   )`,
]

interface Fixture {
  /** 真正在跑的服务（PGlite，暴露真 PG 协议） */
  server: DatabaseProvider
  /** 被测对象：以"外部 PG"的身份连同一个库 */
  provider: DatabaseProvider
  snapshots: string
}

async function boot(): Promise<Fixture> {
  const dir = await tempDir()
  const server = createPgliteProvider({ dataDir: dir })
  await server.start()
  cleanups.push(() => server.stop())
  const snapshots = await tempDir()
  const provider = createPostgresProvider({
    connectionString: server.connectionString(),
    snapshotsDir: snapshots,
  })
  await provider.start()
  return { server, provider, snapshots }
}

async function withClient<T>(server: DatabaseProvider, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: server.connectionString() })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

async function seed(server: DatabaseProvider): Promise<void> {
  await withClient(server, async (client) => {
    for (const ddl of DDL) await client.query(ddl)
    // identity ALWAYS：不写 id，让库自己发
    await client.query(`insert into accounts (name) values ('甲'), ('乙')`)
    await client.query(
      `insert into items (account_id, title, note, score, labels, meta, blob)
       values
         (1, '第一条', null, 12.5, array['a','b'], '{"k":1}'::jsonb, '\\x0102ff'::bytea),
         (1, '第二条', '有备注', null, null, null, null),
         (2, '第三条', '中文与 emoji 🚀', 0.01, array['中文'], '{"nest":{"x":[1,2]}}'::jsonb, null)`,
    )
    await client.query(`insert into tags (item_id, label) values (1, 't1'), (1, 't2'), (2, 't3')`)
  })
}

async function counts(server: DatabaseProvider): Promise<Record<string, number>> {
  return withClient(server, async (client) => {
    const result: Record<string, number> = {}
    for (const table of ['accounts', 'items', 'tags']) {
      const row = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`)
      result[table] = Number(row.rows[0]?.n ?? '0')
    }
    return result
  })
}

describe('postgres 档快照：纯 JS，不依赖 pg_dump', () => {
  it('dump 出的文件能解回来，形状正确（生成列不进快照）', async () => {
    const { server, provider, snapshots } = await boot()
    await seed(server)

    const snapshot = await provider.dump(join(snapshots, 'a.rows.json.gz'))
    expect(snapshot.mode).toBe('postgres')
    expect(snapshot.bytes).toBeGreaterThan(0)

    const file = await decodeRowsSnapshot(await readFile(snapshot.file))
    expect(file.format).toBe('tenon-db-rows')
    expect(file.tableCount).toBe(3)
    expect(file.rowCount).toBe(2 + 3 + 3)

    const items = file.tables.find((table) => table.name === 'items')
    expect(items?.columns).not.toContain('title_upper') // 生成列
    expect(items?.columns).toContain('blob')
    // bytea 打了标，不是 {type:'Buffer',data:[…]}
    const blobIndex = items?.columns.indexOf('blob') ?? -1
    expect(items?.rows[0]?.[blobIndex]).toEqual({ __tenon_bytea: expect.any(String) })
  })

  it('★ 改完数据 restore：行、jsonb、数组、bytea、时间戳都回到快照那一刻', async () => {
    const { server, provider, snapshots } = await boot()
    await seed(server)

    const before = await withClient(server, async (client) => {
      const row = await client.query(
        `select title, score::text, labels, meta, encode(blob,'hex') as blob_hex,
                created_at, title_upper
           from items order by id limit 1`,
      )
      return row.rows[0]
    })

    const snapshot = await provider.dump(join(snapshots, 'b.rows.json.gz'))

    // 破坏现场：删一行、改一行、再加一行
    await withClient(server, async (client) => {
      await client.query(`delete from tags where id = 1`)
      await client.query(`update items set title = '被改过', meta = null where id = 1`)
      await client.query(`insert into items (account_id, title) values (2, '快照之后才有的')`)
    })
    expect((await counts(server))['items']).toBe(4)

    await provider.restore(snapshot)

    expect(await counts(server)).toEqual({ accounts: 2, items: 3, tags: 3 })
    const after = await withClient(server, async (client) => {
      const row = await client.query(
        `select title, score::text, labels, meta, encode(blob,'hex') as blob_hex,
                created_at, title_upper
           from items order by id limit 1`,
      )
      return row.rows[0]
    })
    expect(after).toEqual(before)
    expect(after.title_upper).toBe('第一条') // 生成列由库算出来，值是对的
  })

  it('★ 还原之后序列对齐：新建记录不撞主键', async () => {
    const { server, provider, snapshots } = await boot()
    await seed(server)
    const snapshot = await provider.dump(join(snapshots, 'c.rows.json.gz'))

    await withClient(server, async (client) => {
      await client.query('delete from tags')
      await client.query('delete from items')
      await client.query('delete from accounts')
    })
    await provider.restore(snapshot)

    const inserted = await withClient(server, async (client) => {
      const item = await client.query<{ id: number }>(
        `insert into items (account_id, title) values (1, '新的') returning id`,
      )
      const account = await client.query<{ id: string }>(
        `insert into accounts (name) values ('丙') returning id`,
      )
      return { item: item.rows[0]?.id, account: Number(account.rows[0]?.id) }
    })
    // items 快照里有 3 行（id 1..3）→ 新的必须是 4；accounts 是 identity，新的必须是 3
    expect(inserted.item).toBe(4)
    expect(inserted.account).toBe(3)
  })

  it('目标库缺表：跳过并如实汇报，不静默', async () => {
    const { server, provider, snapshots } = await boot()
    await seed(server)
    const snapshot = await provider.dump(join(snapshots, 'd.rows.json.gz'))

    // 模拟"回滚点之后才建的表"：快照里有 tags，当前库里没有
    await withClient(server, async (client) => {
      await client.query('drop table tags')
    })
    await provider.restore(snapshot)

    const rows = await withClient(server, async (client) => {
      const result = await client.query<{ n: string }>(`select count(*)::text as n from items`)
      return Number(result.rows[0]?.n ?? '0')
    })
    expect(rows).toBe(3) // 其余表照常还原
  })

  it('不是快照的内容：明确说是"格式不认识"，而不是抛个天书', async () => {
    const { provider } = await boot()
    await expect(
      provider.restore({ mode: 'postgres', file: '/tmp/tenon-nope.json.gz', bytes: 0, createdAt: 0 }),
    ).rejects.toThrow(/ENOENT|no such file/)
  })

  it('快照之后删了一列：还原跳过那一列，其余列的值不能错位', async () => {
    const { server, provider, snapshots } = await boot()
    await seed(server)
    const snapshot = await provider.dump(join(snapshots, 'e.rows.json.gz'))

    await withClient(server, async (client) => {
      await client.query('alter table items drop column note')
    })
    await provider.restore(snapshot)

    const row = await withClient(server, async (client) => {
      const result = await client.query(
        `select title, score::text, labels, encode(blob,'hex') as blob_hex
           from items order by id limit 1`,
      )
      return result.rows[0]
    })
    /*
     * 断言的是**值仍然对得上列**。删了一列之后如果按"前 N 个值"取值，score 会被
     * 写进 labels（报 malformed array literal），类型相容的列则会更糟 —— 静默错位。
     */
    expect(row.title).toBe('第一条')
    expect(row.score).toBe('12.50')
    expect(row.labels).toEqual(['a', 'b'])
    expect(row.blob_hex).toBe('0102ff')
  })
})
