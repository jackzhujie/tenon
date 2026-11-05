/**
 * 真 PostgreSQL 的端到端：**跨档迁移 + 纯 JS 快照**。
 *
 * 为什么必须有一个"真 PG"的验证：`migrate.test.ts` / `rows-snapshot.test.ts` 两端
 * 都是 PGlite（真协议、真 SQL，但仍是同一个引擎的三个实现细节不同）：
 *
 *   - `information_schema.columns` 的 `is_identity` / `identity_generation`
 *   - `pg_get_serial_sequence()` 对 `generated always as identity` 的回答
 *   - `setval()` 对 identity 序列的效果（PGlite 走的是自己那套）
 *
 * 这三处只要有一处不同，"迁移全绿、用户点新建就 500"就会在真库上发生。所以这里
 * 起一个真的 `postgres:18-alpine`，把同一份结构与数据搬过去，然后**在真库上**
 * 验行数、生成列、序列续号、重跑幂等，再验快照的 dump / restore。
 *
 * 用法：`pnpm e2e:postgres`（没有 docker 或拉不到镜像就 skip，不算失败）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPgliteProvider,
  createPostgresProvider,
  decodeRowsSnapshot,
  migrateDatabase,
  probePostgres,
  withPostgres,
  type DatabaseProvider,
} from '../packages/db-provisioner/src/index.js'

const IMAGE = 'postgres:18-alpine'
const PASSWORD = 'tenon-e2e'
/**
 * docker 的绝对路径。
 *
 * 不往 PATH 里塞 /usr/local/bin：那里有个 brew 装的 Node 20，会把它放到项目要求的
 * Node 22 前面（症状是 `No such built-in module: node:sqlite`）。
 */
const DOCKER = existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

function docker(args: string[], timeoutMs = 5 * 60 * 1000) {
  const result = spawnSync(DOCKER, args, { encoding: 'utf8', timeout: timeoutMs })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

/* ---------- 0. 没有 docker / 没有镜像就跳过 ---------- */
const probe = spawnSync(DOCKER, ['info'], { encoding: 'utf8', timeout: 30_000 })
if (probe.status !== 0) {
  console.log('跳过：本机没有可用的 docker（真 PG 只验真机，不做假）')
  process.exit(0)
}
const hasImage = docker(['image', 'inspect', IMAGE], 30_000).code === 0
if (!hasImage) {
  console.log(`本地没有 ${IMAGE}，尝试拉取…`)
  const pulled = docker(['pull', IMAGE], 10 * 60 * 1000)
  if (pulled.code !== 0) {
    console.log(`跳过：拉不到 ${IMAGE}（先手动 docker pull ${IMAGE}）。${pulled.out.slice(-300)}`)
    process.exit(0)
  }
}

/**
 * 结构与数据都刻意带坑（与单测同一套，但这里跑在真 PG 上）：
 * - `accounts.id`：`generated always as identity` → 插入必须 OVERRIDING SYSTEM VALUE
 * - `items.title_upper`：生成列 → 不能出现在 INSERT 列清单里
 * - `items` 的 score / labels / meta / blob / created_at：numeric / 数组 / jsonb / bytea / 时区
 * - `tags` 指向 items、`nodes` 自引用 → 外键顺序（自引用不参与排序）
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
  `create table nodes (
     id serial primary key,
     parent_id integer references nodes(id),
     name text not null
   )`,
]

const home = await mkdtemp(join(tmpdir(), 'tenon-pg-e2e-'))
const snapshotsDir = await mkdtemp(join(tmpdir(), 'tenon-pg-snap-'))
const container = `tenon-e2e-pg-${process.pid}`
let source: DatabaseProvider | null = null
let target: DatabaseProvider | null = null
let pgUrl = ''

console.log(`工作目录 ${home}\n容器 ${container}`)

try {
  /* ---------- 1. 起一个真 PostgreSQL ---------- */
  console.log('\n1) 起真 PostgreSQL（postgres:18-alpine）')
  const port = await freePort()
  const started = docker([
    'run', '-d', '--rm',
    '--name', container,
    '-e', 'POSTGRES_USER=app',
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=app',
    '-p', `${port}:5432`,
    IMAGE,
  ])
  check('容器起来了', started.code === 0, started.out.slice(-400))
  pgUrl = `postgres://app:${PASSWORD}@127.0.0.1:${port}/app`

  const ready = await waitForPg(pgUrl, 90_000)
  check('PG 接受连接（真服务器，不是 WASM）', ready.version !== '', ready.version)

  /* ---------- 2. 源库：PGlite 里建表并塞数据 ---------- */
  console.log('\n2) 源库（pglite 档）：建表 + 塞数据')
  source = createPgliteProvider({ dataDir: join(home, 'pgdata') })
  await source.start()
  await withClient(source, async (client) => {
    for (const ddl of DDL) await client.query(ddl)
    await client.query(`insert into accounts (name) values ('甲'), ('乙')`)
    await client.query(
      `insert into items (account_id, title, note, score, labels, meta, blob)
       values
         (1, 'Alpha', null, 12.5, array['a','b'], '{"k":1}'::jsonb, '\\x0102ff'::bytea),
         (1, 'Beta', '有备注', null, null, null, null),
         (2, '中文与 emoji 🚀', '第三条', 0.01, array['中文'], '{"nest":{"x":[1,2]}}'::jsonb, null)`,
    )
    await client.query(`insert into tags (item_id, label) values (1, 't1'), (1, 't2'), (2, 't3')`)
    await client.query(`insert into nodes (parent_id, name) values (null, '根'), (1, '子'), (2, '孙')`)
  })
  const sourceCounts = await counts(source)
  check('源库有 4 张表、11 行', sum(sourceCounts) === 11, JSON.stringify(sourceCounts))

  /* ---------- 3. 目标库：模拟"应用在 postgres 档起过一次" ---------- */
  console.log('\n3) 目标库（真 PG）：建出同样的结构（迁移只搬数据不搬结构）')
  target = createPostgresProvider({ connectionString: pgUrl, snapshotsDir })
  await target.start()
  await withClient(target, async (client) => {
    for (const ddl of DDL) await client.query(ddl)
  })
  check('目标库探活成功且结构就位', sum(await counts(target)) === 0)

  /* ---------- 4. 迁移 ---------- */
  console.log('\n4) 跨档迁移 pglite → 真 PG')
  const report = await migrateDatabase({ from: source, to: target })
  check('迁移报告覆盖 4 张表', report.tables.length === 4, JSON.stringify(report.tables))
  check('迁了 11 行', report.totalRows === 11, String(report.totalRows))
  check('连接串里的密码被洗掉', !report.to.includes(PASSWORD), report.to)

  const targetCounts = await counts(target)
  check('逐表行数一致', JSON.stringify(targetCounts) === JSON.stringify(sourceCounts), JSON.stringify(targetCounts))

  /* ---------- 5. 真 PG 上的语义验证 ---------- */
  console.log('\n5) 真 PG 上验"搬得对"（这几条是 PGlite 验不出来的）')
  const semantics = await withClient(target, async (client) => {
    const item = await client.query(
      `select title, title_upper, score::text as score, labels, meta,
              encode(blob,'hex') as blob_hex, created_at
         from items where id = 1`,
    )
    const tagged = await client.query(
      `select title, note, labels, meta from items where id = 2`,
    )
    const tree = await client.query(`select count(*)::int as n from nodes where parent_id is not null`)
    return { item: item.rows[0], tagged: tagged.rows[0], tree: Number(tree.rows[0]?.n ?? 0) }
  })
  check('生成列由真库算出来（不是搬过去的）', semantics.item?.title_upper === 'ALPHA', String(semantics.item?.title_upper))
  check('numeric 精度没丢', semantics.item?.score === '12.50', String(semantics.item?.score))
  check('text[] 原样', JSON.stringify(semantics.item?.labels) === '["a","b"]', JSON.stringify(semantics.item?.labels))
  check('jsonb 原样', semantics.item?.meta?.k === 1, JSON.stringify(semantics.item?.meta))
  check('bytea 原样（十六进制）', semantics.item?.blob_hex === '0102ff', String(semantics.item?.blob_hex))
  check('timestamptz 有值', semantics.item?.created_at instanceof Date, String(semantics.item?.created_at))
  check('NULL 还是 NULL', semantics.tagged?.note === '有备注' && semantics.tagged?.labels === null)
  check('自引用表（树）也搬了', semantics.tree === 2, String(semantics.tree))

  console.log('\n6) 序列对齐：在真库上新建记录不撞主键')
  const inserted = await withClient(target, async (client) => {
    const item = await client.query<{ id: number }>(
      `insert into items (account_id, title) values (1, '迁移之后新建的') returning id`,
    )
    const account = await client.query<{ id: string }>(
      `insert into accounts (name) values ('丙') returning id`,
    )
    const tag = await client.query<{ id: number }>(`insert into tags (item_id, label) values (1, 't9') returning id`)
    return { item: item.rows[0]?.id, account: Number(account.rows[0]?.id), tag: tag.rows[0]?.id }
  })
  check('items 新 id = 4（serial）', inserted.item === 4, String(inserted.item))
  check('accounts 新 id = 3（identity always）', inserted.account === 3, String(inserted.account))
  check('tags 新 id = 4', inserted.tag === 4, String(inserted.tag))

  console.log('\n7) 迁移可重跑（中断后重来的场景，且目标库已有迁移后新写的数据）')
  const beforeRerun = await counts(target)
  const again = await migrateDatabase({ from: source, to: target })
  const afterRerun = await counts(target)
  /*
   * 这一条以前会失败：旧校验是「源行数 == 目标行数」，而目标库里有迁移之后新建的
   * 那几条（丙 / id=4 的 items / t9），于是把一次**正确**的重跑判成"行数不一致"，
   * 并建议"先清空目标表再迁" —— 那是在建议用户删数据。现在校验改成
   * 「目标(后) == 目标(前) + 实写」。
   */
  check('重跑不再把"目标已有数据"当成失败', JSON.stringify(afterRerun) === JSON.stringify(beforeRerun), JSON.stringify(afterRerun))
  check('第二遍实际写入 0 行', again.totalRows === 0, String(again.totalRows))
  check('第二遍如实报告"跳过了 11 行（主键已存在）"', again.totalSkipped === 11, String(again.totalSkipped))

  console.log('\n8) 目标库缺表时明确报错（跨档只搬数据不搬结构）')
  const missing = await (async () => {
    await withClient(target as DatabaseProvider, async (client) => {
      await client.query('create database app2')
    })
    const empty = createPostgresProvider({
      connectionString: (() => {
        // 不能用 replace('/app', …)：那会先命中 `//app:密码@` 里的用户名
        const url = new URL(pgUrl)
        url.pathname = '/app2'
        return url.toString()
      })(),
      snapshotsDir,
    })
    try {
      await empty.start()
      await migrateDatabase({ from: source as DatabaseProvider, to: empty })
      return { threw: false, message: '' }
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) }
    } finally {
      await empty.stop().catch(() => undefined)
    }
  })()
  check('抛错而不是静默跳过', missing.threw)
  check('错误里指名缺哪张表', missing.message.includes('accounts'), missing.message.slice(0, 200))

  /* ---------- 9. 快照：纯 JS，打到真 PG ---------- */
  console.log('\n9) 快照（纯 JS，不依赖 pg_dump）：dump → 破坏 → restore')
  const before = await withClient(target, async (client) => {
    const row = await client.query(
      `select id, title, score::text as score, labels, encode(blob,'hex') as blob_hex
         from items order by id limit 1`,
    )
    return row.rows[0]
  })
  const snapshot = await (target as DatabaseProvider).dump(join(snapshotsDir, 'db.rows.json.gz'))
  check('快照文件生成了', (await stat(snapshot.file)).size > 0, snapshot.file)
  const file = await decodeRowsSnapshot(await readFile(snapshot.file))
  check('是自描述的纯 JS 格式', file.format === 'tenon-db-rows', file.format)
  check('快照里没有生成列', !file.tables.find((t) => t.name === 'items')?.columns.includes('title_upper'))

  await withClient(target, async (client) => {
    await client.query('delete from tags')
    await client.query('delete from nodes')
    await client.query('delete from items')
    await client.query('delete from accounts')
    await client.query(`insert into accounts (name) values ('删完再加的')`)
  })
  check('破坏之后库是空的（只有 1 行）', sum(await counts(target)) === 1, JSON.stringify(await counts(target)))

  await (target as DatabaseProvider).restore(snapshot)
  const restored = await counts(target)
  check('还原到快照那一刻（含迁移后新建的那条）', JSON.stringify(restored) === JSON.stringify(afterRerun), JSON.stringify(restored))
  const after = await withClient(target, async (client) => {
    const row = await client.query(
      `select id, title, score::text as score, labels, encode(blob,'hex') as blob_hex
         from items order by id limit 1`,
    )
    return row.rows[0]
  })
  check('值逐列一致（numeric / 数组 / bytea 都没错位）', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))

  const afterRestoreInsert = await withClient(target, async (client) => {
    const row = await client.query<{ id: number }>(
      `insert into items (account_id, title) values (1, '还原之后新建的') returning id`,
    )
    return row.rows[0]?.id
  })
  check('还原之后序列也对齐（新 id 继续往后）', typeof afterRestoreInsert === 'number' && afterRestoreInsert > 4, String(afterRestoreInsert))
} finally {
  console.log('\n10) 拆掉')
  await source?.stop().catch(() => undefined)
  await target?.stop().catch(() => undefined)
  docker(['rm', '-f', container], 60_000)
  await rm(home, { recursive: true, force: true }).catch(() => undefined)
  await rm(snapshotsDir, { recursive: true, force: true }).catch(() => undefined)
  console.log('  容器与临时目录已清理')
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过：同一份数据在真 PostgreSQL 上搬得过去、也退得回来。')

/* ---------- 辅助 ---------- */

async function withClient<T>(
  provider: DatabaseProvider,
  run: (client: Parameters<Parameters<typeof withPostgres>[1]>[0]) => Promise<T>,
): Promise<T> {
  return withPostgres(provider.connectionString(), run)
}

async function counts(provider: DatabaseProvider): Promise<Record<string, number>> {
  return withClient(provider, async (client) => {
    const result: Record<string, number> = {}
    for (const table of ['accounts', 'items', 'tags', 'nodes']) {
      const row = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`)
      result[table] = Number(row.rows[0]?.n ?? '0')
    }
    return result
  })
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

/** 等真 PG 起来：容器 running 不代表能连接（initdb 还没跑完） */
async function waitForPg(connectionString: string, timeoutMs: number): Promise<{ version: string }> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      return await probePostgres(connectionString, 3_000)
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() > deadline) throw new Error(`等不到 PostgreSQL：${last}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
