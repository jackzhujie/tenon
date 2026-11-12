/**
 * 跨档数据迁移：把 `pglite` 档里的数据搬进 `postgres` 档（DESIGN §17 DoD ③）。
 *
 * **为什么不用 `pg_dump` / `pg_restore` 管道**（DESIGN v1.2 原方案）：
 * 那两个二进制在用户机器上通常不存在 —— 一个「双击装完、零安装」的产品
 * 让用户先去 `brew install postgresql` 才能发布，等于把最难的一步留给了最后。
 * 所以改成**纯 JS 逻辑拷贝**：两边都通过 PG 协议连接（PGlite 那边是 pg-gateway
 * 暴露的真协议端），用最普通的 SQL 读出来再写进去。零二进制依赖，两档通用。
 *
 * **只搬数据，不搬结构**：表结构由 TypeORM migrations 在目标库跑出来，
 * 与代码同源（同一份 migration 两档都跑，这是 M2 第 1 步的成果）。
 * 所以目标库里表必须已经存在 —— 不存在就报错并说清楚"先让应用在目标档起一次"。
 *
 * 三条容易踩的坑，都在下面代码里：
 *
 * 1. **外键顺序**：父表先插。按 FK 依赖做拓扑排序，有环就明确报错（不猜）。
 * 2. **序列**：搬完数据必须 `setval`，否则下一次插入会撞主键（这条最隐蔽 ——
 *    迁移当场全绿，用户点"新建"才 500）。
 * 3. **生成列 / identity**：生成列不能出现在 INSERT 的列清单里；`GENERATED ALWAYS`
 *    的 identity 列必须配 `OVERRIDING SYSTEM VALUE`，否则整批插入直接失败。
 *
 * 表/列/外键的内省在 `introspect.ts` —— 快照（`rows-snapshot.ts`）用的是同一份，
 * 避免"迁移认得生成列、快照不认得"这种只修一半的偏差。
 */
import { msg, TenonError } from '@tenon/protocol'
import { Client } from 'pg'
import {
  countRows,
  listColumns,
  listForeignKeys,
  listTables,
  orderTables,
  qualified,
  quoteIdent,
  redact,
  refId,
  SKIP_TABLE,
  tableExists,
  type ColumnRef,
  type TableRef,
} from './introspect.js'
import type { DatabaseProvider } from './types.js'

/** 迁移与快照都从 `introspect.ts` 拿，这里只做 re-export 保持公开 API 不变 */
export { orderTables, redact }

/** 每批多少行。500 在 PGlite 与真 PG 上都是一个"稳且不慢"的数 */
export const BATCH = 500

export interface MigrateProgress {
  phase: 'connect' | 'inspect' | 'copy' | 'sequence' | 'verify'
  /** 当前表（`public.items`），inspect/verify 阶段可能为空 */
  table?: string
  rows?: number
  /** 已完成的表数 / 总表数 */
  done?: number
  total?: number
}

export interface MigrateTableReport {
  table: string
  /** 实际写进去的行数 */
  rows: number
  /** 因为目标库里已有同主键而跳过的行数（`on conflict do nothing` 的结果） */
  skipped: number
}

export interface MigrateReport {
  tables: MigrateTableReport[]
  totalRows: number
  /** 所有表加起来被 `on conflict` 跳过的行数。> 0 说明目标库里本来就有这些主键 */
  totalSkipped: number
  durationMs: number
  /** 源与目标各自的连接串（已洗掉密码），排障时对一下就知道迁的哪两个库 */
  from: string
  to: string
}

export interface MigrateOptions {
  /** 源库（通常是应用当前在用的 pglite 档） */
  from: DatabaseProvider
  /** 目标库（通常是刚探活的 postgres 档） */
  to: DatabaseProvider
  /** 只迁这些 schema，默认 `['public']` */
  schemas?: string[]
  onProgress?: (event: MigrateProgress) => void
}

async function connect(
  provider: DatabaseProvider,
  signal: AbortSignal | undefined,
): Promise<Client> {
  const client = new Client({ connectionString: provider.connectionString() })
  try {
    await client.connect()
  } catch (error) {
    throw new TenonError(
      'DB_MIGRATE_FAILED',
      msg('error.db.connectFailed', {
        mode: provider.mode,
        url: redact(provider.connectionString()),
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  signal?.addEventListener('abort', () => {
    void client.end().catch(() => undefined)
  }, { once: true })
  return client
}

/**
 * 把一张表的数据从 source 搬到 target。
 *
 * `ON CONFLICT DO NOTHING` 让迁移可重跑：上次中断在这里，再跑一次不会主键冲突。
 * 返回实际写进去的行数（重跑时可能小于源表行数 —— 那是正常的）。
 */
async function copyTable(
  source: Client,
  target: Client,
  ref: TableRef,
  columns: ColumnRef[],
  onProgress: ((event: MigrateProgress) => void) | undefined,
  index: number,
  total: number,
): Promise<{ written: number; read: number }> {
  const writable = columns.filter((column) => !column.generated)
  if (writable.length === 0) {
    throw new TenonError('DB_MIGRATE_FAILED', msg('error.db.noWritableColumns', { table: refId(ref) }))
  }

  const columnList = writable.map((column) => quoteIdent(column.name)).join(', ')
  const overriding = writable.some((column) => column.alwaysIdentity) ? ' overriding system value' : ''

  const result = await source.query<Record<string, unknown>>(
    `select ${columnList} from ${qualified(ref)}`,
  )

  let written = 0
  for (let offset = 0; offset < result.rows.length; offset += BATCH) {
    const rows = result.rows.slice(offset, offset + BATCH)
    const values: unknown[] = []
    const placeholders: string[] = []
    for (const row of rows) {
      const slots = writable.map((column) => {
        values.push(row[column.name])
        return `$${values.length}`
      })
      placeholders.push(`(${slots.join(', ')})`)
    }

    const inserted = await target.query(
      `insert into ${qualified(ref)} (${columnList})${overriding} values ${placeholders.join(', ')}
         on conflict do nothing`,
      values,
    )
    written += inserted.rowCount ?? 0
    onProgress?.({
      phase: 'copy',
      table: refId(ref),
      rows: written,
      done: index,
      total,
    })
  }

  return { written, read: result.rows.length }
}

/**
 * 把序列推到表里的最大值。
 *
 * 不做这一步的后果：迁移报告全绿，然后用户第一次新建记录 → 主键冲突 500。
 * 这是本文件里最值得写测试的一步。
 */
async function syncSequences(
  source: Client,
  target: Client,
  ref: TableRef,
  columns: ColumnRef[],
): Promise<void> {
  for (const column of columns) {
    if (column.sequence === null) continue
    const current = await source.query<{ last: string | null }>(
      `select max(${quoteIdent(column.name)})::text as last from ${qualified(ref)}`,
    )
    const last = current.rows[0]?.last
    if (last === null || last === undefined) continue // 空表：序列不用动

    const sequence = await target.query<{ seq: string | null }>(
      `select pg_get_serial_sequence($1, $2) as seq`,
      [refId(ref), column.name],
    )
    const seq = sequence.rows[0]?.seq
    if (seq === null || seq === undefined) continue
    // 第三参数 true：即使这个值还没被取过也设进去（is_called）
    await target.query(`select setval($1::regclass, $2::bigint, true)`, [seq, last])
  }
}

/**
 * 迁移入口。
 *
 * 调用前两边都得 `start()` 过（本函数只连、不改进程状态）。
 * 迁移期间源库被应用占用也没关系（PGlite 的协议端是串行的，只是会排队）——
 * 但**迁移完要重启应用**，因为它缓存的 prepared statement / 序列状态都是旧的。
 */
export async function migrateDatabase(options: MigrateOptions): Promise<MigrateReport> {
  const startedAt = Date.now()
  const schemas = options.schemas ?? ['public']
  const onProgress = options.onProgress

  onProgress?.({ phase: 'connect' })
  const from = redact(options.from.connectionString())
  const to = redact(options.to.connectionString())

  const source = await connect(options.from, undefined)
  let target: Client | null = null
  try {
    target = await connect(options.to, undefined)

    onProgress?.({ phase: 'inspect' })
    const allTables = await listTables(source, schemas)
    const tables = allTables.filter((table) => !SKIP_TABLE.test(table.name))
    if (tables.length === 0) {
      throw new TenonError('DB_MIGRATE_FAILED', msg('error.db.noUserTables', { schemas: schemas.join(', ') }))
    }

    // 目标库必须已经跑过 migrations：结构来自代码，不来自这次拷贝
    const missing: string[] = []
    for (const table of tables) {
      if (!(await tableExists(target, table))) missing.push(refId(table))
    }
    if (missing.length > 0) {
      throw new TenonError(
        'DB_MIGRATE_FAILED',
        msg('error.db.missingTables', { tables: missing.join(', ') }),
      )
    }

    const fks = await listForeignKeys(source, schemas)
    const ordered = orderTables(tables, fks)

    /*
     * 迁之前先记下目标库各表现有的行数。
     *
     * 校验用「目标(后) == 目标(前) + 实写」而不是「源 == 目标」：
     * 后者在"目标库里本来就有数据"时会把一次**正确**的迁移判成失败，
     * 而那时的提示是"先清空目标表再迁" —— 那是在建议用户删数据。
     */
    const before = new Map<string, number>()
    for (const table of ordered) before.set(table.id, await countRows(target, table))

    const reports: MigrateTableReport[] = []
    for (const [index, table] of ordered.entries()) {
      const columns = await listColumns(source, table)
      const copied = await copyTable(source, target, table, columns, onProgress, index + 1, ordered.length)

      onProgress?.({ phase: 'sequence', table: refId(table), done: index + 1, total: ordered.length })
      await syncSequences(source, target, table, columns)

      reports.push({
        table: refId(table),
        rows: copied.written,
        skipped: copied.read - copied.written,
      })
    }

    // 校验：**写完不算成功，读回来对得上才算**
    onProgress?.({ phase: 'verify' })
    for (const table of ordered) {
      const written = reports.find((report) => report.table === refId(table))?.rows ?? 0
      const expected = (before.get(table.id) ?? 0) + written
      const actual = await countRows(target, table)
      if (actual !== expected) {
        throw new TenonError(
          'DB_MIGRATE_FAILED',
          msg('error.db.rowCountMismatch', {
            table: refId(table),
            before: before.get(table.id) ?? 0,
            written,
            expected,
            actual,
          }),
        )
      }
    }

    return {
      tables: reports,
      totalRows: reports.reduce((sum, report) => sum + report.rows, 0),
      totalSkipped: reports.reduce((sum, report) => sum + report.skipped, 0),
      durationMs: Date.now() - startedAt,
      from,
      to,
    }
  } finally {
    await source.end().catch(() => undefined)
    if (target !== null) await target.end().catch(() => undefined)
  }
}
