/**
 * Spike 4 正确性探针（不是延迟压测，是"会不会出错数据"）。
 *
 * 重点 1：PGlite 只有**一个 backend 会话**。TypeORM pool.max>1 时，两个连接
 *        各自 BEGIN 会落到同一个 backend 上 —— 这是比"慢"严重得多的问题。
 * 重点 2：LISTEN/NOTIFY、COPY、大结果集在这个桥接层是否还能用。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DataSource } from 'typeorm'
import { Product } from './entities.js'
import { migrations } from './migrations.js'
import { startPgliteGateway } from './pglite-gateway.js'

const ROOT = new URL('..', import.meta.url).pathname
const DATA_DIR = join(ROOT, 'pgdata-probe')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Check = { name: string; pass: boolean; detail: string }
const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}\n   ${detail}`)
}

function ds(gw: { host: string; port: number }, poolMax: number): DataSource {
  return new DataSource({
    type: 'postgres',
    host: gw.host,
    port: gw.port,
    username: 'postgres',
    password: 'postgres',
    database: 'postgres',
    entities: [Product],
    migrations,
    synchronize: false,
    logging: false,
    extra: { max: poolMax, connectionTimeoutMillis: 15_000, statement_timeout: 20_000 },
  })
}

async function main(): Promise<void> {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  const gw = await startPgliteGateway({ dataDir: DATA_DIR })

  // ---------- 探针 1：pool=2 下两个事务是否互串 ----------
  {
    const d = ds(gw, 2)
    await d.initialize()
    await d.runMigrations()
    await d.query('DELETE FROM products')

    // A：写完睡 150ms 再写第二行，最后提交
    const a = d.transaction(async (m) => {
      await m.query(`INSERT INTO products (sku, title) VALUES ('iso-A','A')`)
      await sleep(150)
      await m.query(`INSERT INTO products (sku, title) VALUES ('iso-A2','A2')`)
    })
    // B：错开后写入，然后抛错回滚
    const b = d.transaction(async (m) => {
      await sleep(50)
      await m.query(`INSERT INTO products (sku, title) VALUES ('iso-B','B')`)
      await sleep(50)
      throw new Error('rollback B')
    })
    const settled = await Promise.allSettled([a, b])
    const rows = (await d.query(`SELECT sku FROM products ORDER BY sku`)).map((r: { sku: string }) => r.sku)
    const aOk = rows.includes('iso-A') && rows.includes('iso-A2')
    const bGone = !rows.includes('iso-B')
    check(
      'pool=2 并发事务隔离',
      aOk && bGone,
      `A 提交结果=[${rows.join(',')}]；a=${settled[0].status} b=${settled[1].status}；` +
        `期望 iso-A,iso-A2 存在且 iso-B 回滚 → ${aOk && bGone ? '隔离成立' : '★ 事务互串，数据不可信'}`,
    )
    await d.destroy()
  }

  // ---------- 探针 2：pool=1 下同样场景（对照组）----------
  {
    const d = ds(gw, 1)
    await d.initialize()
    await d.query('DELETE FROM products')
    const a = d.transaction(async (m) => {
      await m.query(`INSERT INTO products (sku, title) VALUES ('iso-A','A')`)
      await sleep(150)
      await m.query(`INSERT INTO products (sku, title) VALUES ('iso-A2','A2')`)
    })
    const b = d.transaction(async (m) => {
      await sleep(50)
      await m.query(`INSERT INTO products (sku, title) VALUES ('iso-B','B')`)
      await sleep(50)
      throw new Error('rollback B')
    })
    const settled = await Promise.allSettled([a, b])
    const rows = (await d.query(`SELECT sku FROM products ORDER BY sku`)).map((r: { sku: string }) => r.sku)
    const aOk = rows.includes('iso-A') && rows.includes('iso-A2')
    const bGone = !rows.includes('iso-B')
    check(
      'pool=1 并发事务隔离（对照组）',
      aOk && bGone,
      `结果=[${rows.join(',')}]；a=${settled[0].status} b=${settled[1].status} → ${aOk && bGone ? '正确' : '★ 仍互串'}`,
    )
    await d.destroy()
  }

  // LISTEN/NOTIFY 单独验证（src/notify.ts）：结论是不可用，故不放进本组

  // ---------- 探针 4：大结果集 ----------
  {
    const d = ds(gw, 1)
    await d.initialize()
    await d.query('DELETE FROM products')
    await d.query(`
      INSERT INTO products (sku, title, price, attributes)
      SELECT 'bulk-' || i, '批量商品 ' || i, (i % 500)::numeric, jsonb_build_object('i', i, 'tag', 'bulk')
      FROM generate_series(1, 2000) AS i
    `)
    const t0 = performance.now()
    const big = await d.query(`SELECT * FROM products ORDER BY sku`)
    const ms = performance.now() - t0
    const total = (await d.query('SELECT count(*)::int AS c FROM products'))[0].c
    check(
      '大结果集（2000 行 × 7 列）',
      big.length === 2000,
      `返回 ${big.length} 行，表内 ${total} 行，耗时 ${ms.toFixed(1)}ms（含 jsonb 列）`,
    )
    await d.destroy()
  }

  // ---------- 探针 5：PG 专有特性抽查 ----------
  {
    const d = ds(gw, 1)
    await d.initialize()
    const feats: Array<[string, string]> = [
      ['jsonb 查询', `SELECT attributes->>'tag' AS t FROM products WHERE attributes @> '{"tag":"bulk"}'::jsonb LIMIT 1`],
      ['窗口函数', `SELECT sku, row_number() OVER (PARTITION BY attributes->>'tag' ORDER BY sku) rn FROM products LIMIT 1`],
      ['CTE + 递归', `WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT sum(n)::int FROM t`],
      ['gen_random_uuid', `SELECT gen_random_uuid() AS id`],
      ['数组类型', `SELECT ARRAY[1,2,3]::int[] AS a`],
      ['timestamptz 运算', `SELECT now() - interval '1 day' AS d`],
      ['ON CONFLICT', `INSERT INTO products (sku, title) VALUES ('bulk-1','覆盖') ON CONFLICT (sku) DO UPDATE SET title = EXCLUDED.title`],
      ['savepoint', `BEGIN; SAVEPOINT s1; SELECT 1; ROLLBACK TO s1; COMMIT`],
    ]
    for (const [name, sql] of feats) {
      try {
        await d.query(sql)
        check(`PG 特性：${name}`, true, 'ok')
      } catch (err) {
        check(`PG 特性：${name}`, false, err instanceof Error ? err.message.slice(0, 120) : String(err))
      }
    }
    await d.destroy()
  }

  await gw.close()

  const failed = checks.filter((c) => !c.pass)
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('探针失败：', err)
  process.exitCode = 1
})
