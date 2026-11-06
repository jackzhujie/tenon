/**
 * 跨档迁移的测试（DESIGN §17 DoD ③）。
 *
 * 本机没有 `pg_dump`、没有 Docker，所以这里**两端都是 PGlite** —— 但走的是
 * 真 PG 协议 + 真 SQL（PGlite 通过 pg-gateway 暴露的就是 PostgreSQL wire protocol），
 * 和 `postgres` 档唯一的差别是连接串。被验证的是迁移逻辑本身：
 *
 * 1. 外键顺序（父表先插）
 * 2. 序列对齐（**最隐蔽**：不对齐的话迁移全绿，用户第一次新建就 500）
 * 3. 目标库缺表时明确报错（跨档只搬数据不搬结构）
 * 4. 可重跑（`on conflict do nothing`）
 * 5. 生成列不进 INSERT 列清单
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntitySchema } from 'typeorm'
import { DataSource as TypeOrmDataSource } from 'typeorm'

/*
 * 这个文件里的用例**要起两个 PGlite**（WASM 版的 PG）再跑一次真 SQL 迁移。
 * 本机冷启动 2–4 秒，Windows runner 上十几秒 —— 两个加起来就会顶到默认的 30 秒，
 * 表现是 "Test timed out in 30000ms"，看着像逻辑挂了，其实只是慢。
 * 超时不是判据，所以给足预算（真挂住时仍然会失败，只是晚 60 秒）。
 */
vi.setConfig({ testTimeout: 90_000 })
import {
  createPgliteProvider,
  migrateDatabase,
  orderTables,
  redact,
  type DatabaseProvider,
} from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-migrate-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function bootDb(): Promise<DatabaseProvider> {
  const dir = await tempDir()
  const provider = createPgliteProvider({ dataDir: dir })
  await provider.start()
  cleanups.push(() => provider.stop())
  return provider
}

async function withClient<T>(
  provider: DatabaseProvider,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: provider.connectionString() })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

/** 源库的结构：父表 + 子表（外键）+ 一个生成列 */
const DDL = [
  `create table parents (
     id serial primary key,
     name text not null
   )`,
  `create table items (
     id serial primary key,
     parent_id integer references parents(id),
     title text not null,
     done boolean not null default false,
     created_at timestamptz not null default now(),
     label text generated always as (title || ' / ' || parent_id::text) stored
   )`,
]

async function seedSource(provider: DatabaseProvider): Promise<void> {
  await withClient(provider, async (client) => {
    for (const ddl of DDL) await client.query(ddl)
    await client.query(`insert into parents (name) values ('甲'), ('乙')`)
    await client.query(
      `insert into items (parent_id, title, done)
       values (1, '第一条', false), (1, '第二条', true), (2, '第三条', false),
              (2, '第四条', true), (1, '第五条', false)`,
    )
  })
}

/** 目标库：同样的结构，空数据（模拟"应用在 postgres 档启动过一次"） */
async function emptyTarget(provider: DatabaseProvider): Promise<void> {
  await withClient(provider, async (client) => {
    for (const ddl of DDL) await client.query(ddl)
  })
}

describe('migrateDatabase：pglite → pglite（与 pglite → postgres 同一份代码）', () => {
  it('两张表的数据全搬过去，外键、布尔、时间戳、生成列都对', async () => {
    const source = await bootDb()
    const target = await bootDb()
    await seedSource(source)
    await emptyTarget(target)

    const report = await migrateDatabase({ from: source, to: target })

    expect(report.tables.map((table) => table.table).sort()).toEqual([
      'public.items',
      'public.parents',
    ])
    expect(report.totalRows).toBe(7)

    const rows = await withClient(target, async (client) => {
      const result = await client.query<{
        id: number
        parent_id: number
        title: string
        done: boolean
        created_at: Date
        label: string
      }>('select id, parent_id, title, done, created_at, label from items order by id')
      return result.rows
    })

    expect(rows).toHaveLength(5)
    expect(rows[1]).toMatchObject({ id: 2, parent_id: 1, title: '第二条', done: true })
    expect(rows[1]?.created_at).toBeInstanceOf(Date)
    // 生成列由目标库自己算出来，不该被我们写进去
    expect(rows[1]?.label).toBe('第二条 / 1')
  })

  it('序列对齐：迁完立刻新建记录不撞主键（不做 setval 就会撞）', async () => {
    const source = await bootDb()
    const target = await bootDb()
    await seedSource(source)
    await emptyTarget(target)
    await migrateDatabase({ from: source, to: target })

    const inserted = await withClient(target, async (client) => {
      const result = await client.query<{ id: number }>(
        `insert into items (parent_id, title) values (1, '迁移后新增') returning id`,
      )
      return result.rows[0]?.id
    })
    // 源里 5 行，新行必须是 6
    expect(inserted).toBe(6)
  })

  it('目标库缺表：明确报错并指路（跨档只搬数据不搬结构）', async () => {
    const source = await bootDb()
    const target = await bootDb()
    await seedSource(source) // 目标库空着，什么都不建

    await expect(migrateDatabase({ from: source, to: target })).rejects.toMatchObject({
      code: 'DB_MIGRATE_FAILED',
    })
    await expect(migrateDatabase({ from: source, to: target })).rejects.toThrow(
      /先让应用在目标档启动一次/,
    )
  })

  it('可重跑：第二次不报错也不重复插入', async () => {
    const source = await bootDb()
    const target = await bootDb()
    await seedSource(source)
    await emptyTarget(target)

    await migrateDatabase({ from: source, to: target })
    const second = await migrateDatabase({ from: source, to: target })

    expect(second.tables.every((table) => table.rows === 0)).toBe(true)
    const count = await withClient(target, async (client) => {
      const result = await client.query<{ n: string }>('select count(*)::text as n from items')
      return Number(result.rows[0]?.n ?? '0')
    })
    expect(count).toBe(5)
  })

  it('目标库已有"迁移之后新写的数据"时，重跑仍然成立', async () => {
    /*
     * 旧校验是「源行数 == 目标行数」，这种情况下会把一次**正确**的重跑判成
     * "行数不一致"，并提示"先清空目标表再迁" —— 那是在建议用户删数据。
     * 现在按「目标(后) == 目标(前) + 实写」，并且把 on conflict 跳过的行数
     * 如实放进报告的 `skipped`。
     */
    const source = await bootDb()
    const target = await bootDb()
    await seedSource(source)
    await emptyTarget(target)
    await migrateDatabase({ from: source, to: target })

    await withClient(target, async (client) => {
      await client.query(`insert into items (parent_id, title, done) values (1, '迁移之后新建的', false)`)
    })

    const again = await migrateDatabase({ from: source, to: target })
    expect(again.totalRows).toBe(0)
    expect(again.totalSkipped).toBe(7) // parents 2 + items 5，全都撞主键
  })

  it('进度回调能画出"第几张表 / 共几张"', async () => {
    const source = await bootDb()
    const target = await bootDb()
    await seedSource(source)
    await emptyTarget(target)

    const phases: string[] = []
    const seen = new Set<string>()
    await migrateDatabase({
      from: source,
      to: target,
      onProgress: (event) => {
        phases.push(event.phase)
        if (event.total !== undefined) seen.add(`${event.done}/${event.total}`)
      },
    })

    expect(phases[0]).toBe('connect')
    expect(phases).toContain('copy')
    expect(phases.at(-1)).toBe('verify')
    expect([...seen]).toEqual(['1/2', '2/2'])
  })
})

describe('orderTables：父表先插', () => {
  const tables = [
    { schema: 'public', name: 'items', id: 'public.items' },
    { schema: 'public', name: 'parents', id: 'public.parents' },
  ]

  it('按外键依赖排序（与输入顺序无关）', () => {
    const ordered = orderTables(tables, [{ child: 'public.items', parent: 'public.parents' }])
    expect(ordered.map((table) => table.id)).toEqual(['public.parents', 'public.items'])
  })

  it('自引用外键不算环（树形表很常见）', () => {
    const ordered = orderTables(tables, [{ child: 'public.items', parent: 'public.items' }])
    expect(ordered).toHaveLength(2)
  })

  it('循环外键直接报错，不猜顺序（猜错会在目标库留一半数据）', () => {
    expect(() =>
      orderTables(tables, [
        { child: 'public.items', parent: 'public.parents' },
        { child: 'public.parents', parent: 'public.items' },
      ]),
    ).toThrow(/循环外键/)
  })
})

describe('redact', () => {
  it('洗掉密码，其余原样（错误信息里会带它给用户看）', () => {
    expect(redact('postgres://u:s3cret@db.internal:5432/app')).toBe(
      'postgres://u:***@db.internal:5432/app',
    )
    expect(redact('不是 URL')).toBe('(无法解析的连接串)')
  })
})

describe('TypeORM 建出来的表也能迁（nest-api 的真实形态）', () => {
  interface Note {
    id: number
    title: string
    done: boolean
  }

  const NoteSchema = new EntitySchema<Note>({
    name: 'Note',
    tableName: 'notes',
    columns: {
      id: { type: Number, primary: true, generated: true },
      title: { type: String },
      done: { type: Boolean, default: false },
    },
  })

  async function dataSource(provider: DatabaseProvider, synchronize: boolean): Promise<TypeOrmDataSource> {
    const ds = new TypeOrmDataSource({
      type: 'postgres',
      url: provider.connectionString(),
      entities: [NoteSchema],
      synchronize,
      // PGlite 只有一个 backend 会话，这是全局硬约束（SPIKES §1）
      extra: { max: 1 },
    })
    await ds.initialize()
    cleanups.push(() => (ds.isInitialized ? ds.destroy() : Promise.resolve()))
    return ds
  }

  it('TypeORM 生成的表名与序列名都能被识别（不用手写 DDL）', async () => {
    const source = await bootDb()
    const target = await bootDb()

    // 源：TypeORM 建表 + 写数据（serial 列 → 序列名由 TypeORM 决定）
    const srcDs = await dataSource(source, true)
    await srcDs.getRepository<Note>('Note').save([
      { title: '第一条', done: false },
      { title: '第二条', done: true },
    ])

    // 目标：同样的实体再建一次表（等价于"应用在 postgres 档启动过"）
    await dataSource(target, true)

    const report = await migrateDatabase({ from: source, to: target })
    // `skipped` 是"目标已有同主键所以没写"的行数；第一次迁应该是 0
    expect(report.tables).toEqual([{ table: 'public.notes', rows: 2, skipped: 0 }])

    // 迁完继续用 TypeORM 写（序列要对齐，否则这里会主键冲突）
    const tgtDs = await dataSource(target, false)
    const saved = await tgtDs.getRepository<Note>('Note').save({ title: '第三条', done: false })
    expect(saved.id).toBe(3)
  })
})
