/**
 * Spike 4 压测主程序。
 * 覆盖 STATUS §4.1 第 4 条要求的四类场景：并发 20 请求 / 事务回滚 / 连接复用 / 迁移执行。
 *
 * 运行：pnpm --filter @tenon/spike-db start
 * 产物：results/spike-db.json（原始数据）+ 控制台 markdown 表
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DataSource } from 'typeorm'
import { Product } from './entities.js'
import { migrations } from './migrations.js'
import { startPgliteGateway, type PgliteGateway } from './pglite-gateway.js'

const req = createRequire(import.meta.url)

const ROOT = new URL('..', import.meta.url).pathname
const DATA_DIR = join(ROOT, 'pgdata')
const RESULTS_DIR = join(ROOT, 'results')

type Op = { ok: boolean; ms: number; error?: string }
type Phase = {
  name: string
  note: string
  poolMax: number
  concurrency: number
  ops: number
  ok: number
  err: number
  p50: number
  p95: number
  p99: number
  max: number
  wallMs: number
  errors: string[]
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] as number
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function summarize(name: string, note: string, poolMax: number, concurrency: number, results: Op[]): Phase {
  const lat = results.map((r) => r.ms).sort((a, b) => a - b)
  const errors = [...new Set(results.filter((r) => !r.ok).map((r) => r.error ?? 'unknown'))].slice(0, 5)
  return {
    name,
    note,
    poolMax,
    concurrency,
    ops: results.length,
    ok: results.filter((r) => r.ok).length,
    err: results.filter((r) => !r.ok).length,
    p50: round(pct(lat, 0.5)),
    p95: round(pct(lat, 0.95)),
    p99: round(pct(lat, 0.99)),
    max: round(pct(lat, 1)),
    wallMs: round(lat.reduce((a, b) => a + b, 0)),
    errors,
  }
}

function errMsg(err: unknown): string {
  const m = err instanceof Error ? ` ${err.message}` : ` ${String(err)}`
  return m.trim().slice(0, 160)
}

/** 以 n 个并发跑 count 次操作，返回每次操作的端到端耗时（含连接排队）*/
async function burst(n: number, count: number, fn: (i: number) => Promise<unknown>): Promise<Op[]> {
  const out: Op[] = []
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= count) return
      const t0 = performance.now()
      try {
        await fn(i)
        out.push({ ok: true, ms: performance.now() - t0 })
      } catch (err) {
        out.push({ ok: false, ms: performance.now() - t0, error: errMsg(err) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, count) }, () => worker()))
  return out
}

function makeDs(gw: PgliteGateway, poolMax: number): DataSource {
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
    extra: {
      max: poolMax,
      // 关键：连不上/拿不到连接就快点失败，别让压测看起来"没超时"
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 2_000,
      statement_timeout: 20_000,
      application_name: `tenon-spike-pool${poolMax}`,
    },
  })
}

const phases: Phase[] = []
const notes: string[] = []

async function phase(
  gw: PgliteGateway,
  ds: DataSource,
  name: string,
  note: string,
  poolMax: number,
  concurrency: number,
  count: number,
  fn: (i: number) => Promise<unknown>,
): Promise<Phase> {
  const results = await burst(concurrency, count, fn)
  const p = summarize(name, note, poolMax, concurrency, results)
  phases.push(p)
  console.log(
    `  ${name.padEnd(30)} pool=${String(poolMax).padEnd(2)} conc=${String(concurrency).padEnd(2)} ` +
      `ok=${p.ok}/${p.ops} p50=${String(p.p50).padStart(7)}ms p95=${String(p.p95).padStart(7)}ms max=${String(p.max).padStart(8)}ms`,
  )
  if (p.err > 0) console.log(`      ! errors: ${p.errors.join(' | ')}`)
  void ds
  return p
}

async function main(): Promise<void> {
  console.log('Spike 4 — PGlite + pg-gateway + TypeORM')
  console.log('='.repeat(78))

  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(RESULTS_DIR, { recursive: true })

  // ---------- 阶段 0：网关启动 ----------
  const bootStart = performance.now()
  let gw = await startPgliteGateway({ dataDir: DATA_DIR })
  const bootMs = round(performance.now() - bootStart)
  console.log(`PGlite 启动 + 网关监听 :${gw.port}  用时 ${bootMs}ms`)
  notes.push(`PGlite(文件模式) 冷启动 + TCP 网关就绪：${bootMs}ms，端口 ${gw.port}`)

  // ---------- 阶段 1：迁移（pool.max=1）----------
  const ds1 = makeDs(gw, 1)
  const migStart = performance.now()
  await ds1.initialize()
  const applied = await ds1.runMigrations({ transaction: 'each' })
  const migMs = round(performance.now() - migStart)
  console.log(`迁移执行：${applied.length} 个，用时 ${migMs}ms`)
  notes.push(`pool.max=1 下 initialize + 2 个迁移（含 GIN 索引）共 ${migMs}ms`)

  // ---------- 阶段 2：单连接基线 ----------
  await phase(gw, ds1, 'baseline-seq', '单连接顺序查询基线', 1, 1, 50, () => ds1.query('SELECT 1 AS n'))

  // ---------- 阶段 3：并发 20（pool 1 / 2 / 10 对照）----------
  await phase(gw, ds1, 'conc20-select', '并发 20 读，pool=1', 1, 20, 20, () =>
    ds1.query('SELECT count(*)::int AS c FROM products'),
  )
  await phase(
    gw,
    ds1,
    'conc20-insert',
    '并发 20 写，pool=1',
    1,
    20,
    20,
    (i) =>
      ds1.query(`INSERT INTO products (sku, title, price, attributes) VALUES ($1,$2,$3,$4::jsonb)`, [
        `sku-p1-${i}`,
        `商品 ${i}`,
        '19.90',
        JSON.stringify({ tag: 'a', i }),
      ]),
  )

  const ds2 = makeDs(gw, 2)
  await ds2.initialize()
  await phase(gw, ds2, 'conc20-select', '并发 20 读，pool=2', 2, 20, 20, () =>
    ds2.query('SELECT count(*)::int AS c FROM products'),
  )
  await phase(
    gw,
    ds2,
    'conc20-insert',
    '并发 20 写，pool=2',
    2,
    20,
    20,
    (i) =>
      ds2.query(`INSERT INTO products (sku, title, price, attributes) VALUES ($1,$2,$3,$4::jsonb)`, [
        `sku-p2-${i}`,
        `商品 ${i}`,
        '29.90',
        JSON.stringify({ tag: 'b', i }),
      ]),
  )

  // ---------- 阶段 4：事务回滚正确性 ----------
  const before = await ds1.query('SELECT count(*)::int AS c FROM products')
  await phase(gw, ds1, 'tx-rollback', '10 个事务各插 2 行后回滚', 1, 10, 10, async (i) => {
    try {
      await ds1.transaction(async (m) => {
        await m.query(`INSERT INTO products (sku, title) VALUES ($1,$2)`, [`tx-a-${i}`, 'a'])
        await m.query(`INSERT INTO products (sku, title) VALUES ($1,$2)`, [`tx-b-${i}`, 'b'])
        throw new Error('intentional rollback')
      })
    } catch (err) {
      // 期望抛错；只有没抛错才算这次操作失败
      if (err instanceof Error && err.message === 'intentional rollback') return
      throw err
    }
    throw new Error('事务应当回滚但成功提交了')
  })
  const afterRollback = await ds1.query('SELECT count(*)::int AS c FROM products')
  const rolledBack = Number(before[0].c) === Number(afterRollback[0].c)
  console.log(`事务回滚后行数不变：${rolledBack ? '✅' : '❌'} (${before[0].c} → ${afterRollback[0].c})`)
  notes.push(
    `事务回滚：10 个并发事务各写 2 行后抛错，行数 ${before[0].c} → ${afterRollback[0].c}（${rolledBack ? '无泄漏' : '有泄漏！'}）`,
  )

  // ---------- 阶段 5：真实事务提交（3 查询/请求）----------
  // 注意：事务必须走 pool=1。pool>1 时两个连接共用同一个 PGlite backend，
  // 一个 ROLLBACK 会把另一个事务的写入一起抹掉（见 probe.ts 的隔离探针）。
  await phase(gw, ds1, 'conc20-mixed-tx', '20 并发事务（3 查询/请求）', 1, 20, 20, async (i) => {
    await ds1.transaction(async (m) => {
      await m.query(`INSERT INTO products (sku, title, price) VALUES ($1,$2,$3)`, [`mix-${i}`, `混合 ${i}`, '9.90'])
      await m.query(`UPDATE products SET stock = stock + 1 WHERE sku = $1`, [`mix-${i}`])
      await m.query(`SELECT id, sku, attributes FROM products WHERE sku = $1`, [`mix-${i}`])
    })
  })

  // ---------- 阶段 5b：持续负载（查长跑是否退化）----------
  await phase(gw, ds1, 'sustained-300', '持续 300 次混合读写（单连接）', 1, 10, 300, async (i) => {
    if (i % 3 === 0) {
      await ds1.query(`INSERT INTO products (sku, title) VALUES ($1,$2)`, [`sus-${i}`, `持续 ${i}`])
    } else {
      await ds1.query(`SELECT count(*)::int AS c FROM products`)
    }
  })

  // ---------- 阶段 6：连接复用（长跑）----------
  const socketsBefore = gw.stats.socketsOpened
  await phase(gw, ds1, 'reuse-200', '200 次顺序查询（单连接复用）', 1, 1, 200, () =>
    ds1.query('SELECT id FROM products ORDER BY created_at DESC LIMIT 5'),
  )
  const socketsUsed = gw.stats.socketsOpened - socketsBefore
  notes.push(`连接复用：200 次顺序查询只新开 ${socketsUsed} 个 socket（nginx 式长连接复用是否成立）`)

  // ---------- 阶段 7：pool=10（DESIGN 点名的失效假设）----------
  const ds10 = makeDs(gw, 10)
  await ds10.initialize()
  await phase(
    gw,
    ds10,
    'conc40-select-pool10',
    'DESIGN 警告场景：并发 40 / pool=10',
    10,
    40,
    40,
    () => ds10.query('SELECT count(*)::int AS c FROM products'),
  )
  await ds10.destroy()

  // ---------- 阶段 8：运行期迁移（数据已在）----------
  const ds3 = makeDs(gw, 2)
  await ds3.initialize()
  const mig2Start = performance.now()
  const applied2 = await ds3.runMigrations({ transaction: 'each' })
  const mig2Ms = round(performance.now() - mig2Start)
  const cols = await ds3.query<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'products' ORDER BY ordinal_position`,
  )
  const hasStock = cols.some((c) => c.column_name === 'stock')
  console.log(`运行期迁移：新执行 ${applied2.length} 个，${mig2Ms}ms，stock 列存在=${hasStock}`)
  notes.push(`运行期迁移（库里有数据时）：${mig2Ms}ms，stock 列${hasStock ? '已生效' : '缺失'}`)
  await ds3.destroy()

  // ---------- 阶段 9：快照与持久化 ----------
  const dumpStart = performance.now()
  const dump = await gw.db.dumpDataDir('gzip')
  const dumpBytes = Number((dump as File | Blob).size)
  const dumpMs = round(performance.now() - dumpStart)
  const rowsBeforeRestart = Number((await ds1.query('SELECT count(*)::int AS c FROM products'))[0].c)

  await ds1.destroy()
  await gw.close()
  const restartStart = performance.now()
  gw = await startPgliteGateway({ dataDir: DATA_DIR })
  const restartMs = round(performance.now() - restartStart)
  const ds4 = makeDs(gw, 1)
  await ds4.initialize()
  const rowsAfterRestart = Number((await ds4.query('SELECT count(*)::int AS c FROM products'))[0].c)
  console.log(
    `快照 dump：${(dumpBytes / 1024).toFixed(1)}KB / ${dumpMs}ms；重启 ${restartMs}ms；` +
      `行数 ${rowsBeforeRestart} → ${rowsAfterRestart}`,
  )
  notes.push(
    `dumpDataDir('gzip')：${(dumpBytes / 1024).toFixed(1)}KB，${dumpMs}ms；进程重启后数据 ${rowsBeforeRestart === rowsAfterRestart ? '完好' : '丢失'}（${restartMs}ms 恢复）`,
  )
  const dirBytes = await dirSize(DATA_DIR)
  notes.push(`pgdata 目录体积：${(dirBytes / 1024 / 1024).toFixed(1)}MB（${rowsAfterRestart} 行 seed 数据）`)
  await ds4.destroy()
  await gw.close()

  // ---------- 汇总 ----------
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    versions: {
      pglite: pkgVersion('@electric-sql/pglite'),
      pgGateway: pkgVersion('pg-gateway'),
      typeorm: pkgVersion('typeorm'),
      pg: pkgVersion('pg'),
    },
    bootMs,
    migrationMs: migMs,
    phases,
    gatewayStats: gw.stats,
    notes,
  }
  await writeFile(join(RESULTS_DIR, 'spike-db.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log('\n## 汇总\n')
  console.log('| 阶段 | pool | 并发 | 成功/总数 | p50 | p95 | p99 | 最大 |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const p of phases) {
    console.log(
      `| ${p.name} | ${p.poolMax} | ${p.concurrency} | ${p.ok}/${p.ops} | ${p.p50}ms | ${p.p95}ms | ${p.p99}ms | ${p.max}ms |`,
    )
  }
  console.log('\n### 结论要点')
  for (const n of notes) console.log(`- ${n}`)
  console.log(`\n原始数据：spikes/db/results/spike-db.json`)
}

async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(p)
    else total += (await stat(p)).size
  }
  return total
}

function pkgVersion(name: string): string {
  try {
    return (req(`${name}/package.json`) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

main().catch((err) => {
  console.error('压测失败：', err)
  process.exitCode = 1
})
