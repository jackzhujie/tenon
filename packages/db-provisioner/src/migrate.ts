/**
 * 跨档数据迁移：把 `pglite` 档里的数据搬进 `postgres` 档（DESIGN §17 DoD ③）。
 *
 * **为什么不用 `pg_dump` / `pg_restore` 管道**（DESIGN v1.2 原方案）：
 * 那两个二进制在用户机器上通常不存在 —— 一个「双击装完、零安装」的产品
 * 让用户先去 `brew install postgresql` 才能发布，等于把最难的一步留给了最后。
 * 本机实测（2026-11-01）也没有：`pg_dump not found`、`docker not found`。
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
 */
import { TenonError } from '@tenon/protocol'
import { Client } from 'pg'
import type { DatabaseProvider } from './types.js'

/** 每批多少行。500 在 PGlite 与真 PG 上都是一个"稳且不慢"的数 */
const BATCH = 500

/** 永远不迁的 schema（系统自己的） */
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])

/** 迁移工具的记账表/迁移表：它们描述的是"怎么建表"，不是用户数据 */
const SKIP_TABLE = /^(typeorm_|migrations$|pg_)/i

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
  rows: number
}

export interface MigrateReport {
  tables: MigrateTableReport[]
  totalRows: number
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

interface TableRef {
  schema: string
  name: string
  /** `schema.name`，日志与排序用 */
  id: string
}

interface ColumnRef {
  name: string
  /** `GENERATED ALWAYS AS (...) STORED` 之类的列：不能出现在 INSERT 里 */
  generated: boolean
  /** identity / serial：搬完要对齐序列 */
  sequence: string | null
  /** `GENERATED ALWAYS AS IDENTITY`：插入时必须 `OVERRIDING SYSTEM VALUE` */
  alwaysIdentity: boolean
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function refId(ref: TableRef): string {
  return `${ref.schema}.${ref.name}`
}

function qualified(ref: TableRef): string {
  return `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`
}

/** 洗掉连接串里的密码（错误信息里会带着它给用户看） */
export function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString)
    if (url.password !== '') url.password = '***'
    return url.toString()
  } catch {
    return '(无法解析的连接串)'
  }
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
      `连不上 ${provider.mode} 档（${redact(provider.connectionString())}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  signal?.addEventListener('abort', () => {
    void client.end().catch(() => undefined)
  }, { once: true })
  return client
}

async function listTables(client: Client, schemas: string[]): Promise<TableRef[]> {
  const result = await client.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name
       from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema = any($1::text[])
      order by table_schema, table_name`,
    [schemas],
  )
  return result.rows.map((row) => ({
    schema: row.table_schema,
    name: row.table_name,
    id: `${row.table_schema}.${row.table_name}`,
  }))
}

/**
 * FK 依赖：父表必须先插。
 *
 * 用 `pg_constraint` 而不是 `information_schema` —— 后者在复合外键上会给出行级重复，
 * 拼出来的边会把图弄乱（拓扑排序看不出问题，但顺序会错）。
 */
async function listForeignKeys(
  client: Client,
  schemas: string[],
): Promise<Array<{ child: string; parent: string }>> {
  const result = await client.query<{ child: string; parent: string }>(
    `select format('%I.%I', ns_child.nspname, child.relname) as child,
            format('%I.%I', ns_parent.nspname, parent.relname) as parent
       from pg_constraint con
       join pg_class child on child.oid = con.conrelid
       join pg_namespace ns_child on ns_child.oid = child.relnamespace
       join pg_class parent on parent.oid = con.confrelid
       join pg_namespace ns_parent on ns_parent.oid = parent.relnamespace
      where con.contype = 'f'
        and ns_child.nspname = any($1::text[])
        and ns_parent.nspname = any($1::text[])`,
    [schemas],
  )
  return result.rows
}

/**
 * 拓扑排序（Kahn）：父表在前。
 *
 * 有环（比如 a.b_id → b.a_id）时**不猜顺序**：直接报错并列出环上的表。
 * 猜错的后果是迁移中途外键报错、目标库留下一半数据 —— 比一开始就失败难收拾得多。
 */
export function orderTables(
  tables: TableRef[],
  foreignKeys: Array<{ child: string; parent: string }>,
): TableRef[] {
  const byId = new Map(tables.map((table) => [table.id, table]))
  const indegree = new Map<string, number>(tables.map((table) => [table.id, 0]))
  /** parent → children */
  const edges = new Map<string, string[]>()

  for (const fk of foreignKeys) {
    if (!byId.has(fk.child) || !byId.has(fk.parent)) continue
    if (fk.child === fk.parent) continue // 自引用（树形表）不需要排序
    const list = edges.get(fk.parent) ?? []
    if (!list.includes(fk.child)) {
      list.push(fk.child)
      edges.set(fk.parent, list)
      indegree.set(fk.child, (indegree.get(fk.child) ?? 0) + 1)
    }
  }

  const queue = tables.filter((table) => (indegree.get(table.id) ?? 0) === 0).map((t) => t.id)
  const ordered: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    ordered.push(id)
    for (const child of edges.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1
      indegree.set(child, next)
      if (next === 0) queue.push(child)
    }
  }

  const stuck = tables.filter((table) => !ordered.includes(table.id)).map((t) => t.id)
  if (stuck.length > 0) {
    throw new TenonError(
      'DB_MIGRATE_FAILED',
      `表之间有循环外键，无法确定插入顺序：${stuck.join(', ')}。` +
        '请先把其中一条外键改成可空，迁完数据再改回来。',
    )
  }

  return ordered.map((id) => byId.get(id) as TableRef)
}

async function listColumns(client: Client, ref: TableRef): Promise<ColumnRef[]> {
  const result = await client.query<{
    column_name: string
    is_generated: string
    is_identity: string
    identity_generation: string | null
    column_default: string | null
  }>(
    `select column_name, is_generated, is_identity, identity_generation, column_default
       from information_schema.columns
      where table_schema = $1 and table_name = $2
      order by ordinal_position`,
    [ref.schema, ref.name],
  )

  const columns: ColumnRef[] = []
  for (const row of result.rows) {
    const isIdentity = row.is_identity === 'YES'
    const columnDefault = row.column_default ?? ''
    columns.push({
      name: row.column_name,
      generated: row.is_generated === 'ALWAYS',
      sequence:
        isIdentity || columnDefault.startsWith('nextval(')
          ? `${ref.schema}.${ref.name}.${row.column_name}`
          : null,
      alwaysIdentity: isIdentity && row.identity_generation === 'ALWAYS',
    })
  }
  return columns
}

/** 目标库里这张表存在吗（不存在说明 migrations 还没在目标档跑过） */
async function tableExists(client: Client, ref: TableRef): Promise<boolean> {
  const result = await client.query(
    `select 1 from information_schema.tables
      where table_schema = $1 and table_name = $2 and table_type = 'BASE TABLE'`,
    [ref.schema, ref.name],
  )
  return result.rowCount !== null && result.rowCount > 0
}

async function countRows(client: Client, ref: TableRef): Promise<number> {
  const result = await client.query<{ n: string }>(`select count(*)::text as n from ${qualified(ref)}`)
  return Number(result.rows[0]?.n ?? '0')
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
): Promise<number> {
  const writable = columns.filter((column) => !column.generated)
  if (writable.length === 0) {
    throw new TenonError('DB_MIGRATE_FAILED', `${refId(ref)} 没有可写的列（全是生成列？）`)
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
      const slots = writable.map((column, columnIndex) => {
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

  return written
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
      throw new TenonError('DB_MIGRATE_FAILED', `源库里没有任何用户表（schemas: ${schemas.join(', ')}）`)
    }

    // 目标库必须已经跑过 migrations：结构来自代码，不来自这次拷贝
    const missing: string[] = []
    for (const table of tables) {
      if (!(await tableExists(target, table))) missing.push(refId(table))
    }
    if (missing.length > 0) {
      throw new TenonError(
        'DB_MIGRATE_FAILED',
        `目标库里缺少这些表：${missing.join(', ')}。` +
          '跨档迁移只搬数据不搬结构 —— 先让应用在目标档启动一次（迁移会自动跑），再迁移数据。',
      )
    }

    const fks = await listForeignKeys(source, schemas)
    const ordered = orderTables(tables, fks)

    const reports: MigrateTableReport[] = []
    for (const [index, table] of ordered.entries()) {
      const columns = await listColumns(source, table)
      const rows = await copyTable(source, target, table, columns, onProgress, index + 1, ordered.length)

      onProgress?.({ phase: 'sequence', table: refId(table), done: index + 1, total: ordered.length })
      await syncSequences(source, target, table, columns)

      reports.push({ table: refId(table), rows })
    }

    // 校验：逐表比对行数。**写完不算成功，读回来一致才算**
    onProgress?.({ phase: 'verify' })
    for (const table of ordered) {
      const [sourceCount, targetCount] = await Promise.all([
        countRows(source, table),
        countRows(target, table),
      ])
      if (sourceCount !== targetCount) {
        throw new TenonError(
          'DB_MIGRATE_FAILED',
          `${refId(table)} 行数不一致：源 ${sourceCount}，目标 ${targetCount}` +
            '（目标库原本就有同主键的行时会出现这种情况，先清空目标表再迁）',
        )
      }
    }

    return {
      tables: reports,
      totalRows: reports.reduce((sum, report) => sum + report.rows, 0),
      durationMs: Date.now() - startedAt,
      from,
      to,
    }
  } finally {
    await source.end().catch(() => undefined)
    if (target !== null) await target.end().catch(() => undefined)
  }
}
