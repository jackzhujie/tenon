/**
 * 库结构内省：表 / 列 / 外键 / 行数。**跨档迁移与快照共用这一份**。
 *
 * 为什么值得单独一个文件：迁移（`migrate.ts`）和快照（`rows-snapshot.ts`）问的是
 * 同一批问题 —— "有哪些用户表""谁依赖谁""哪些列不能写"。两处各写一份的话，
 * 迟早出现"迁移认得生成列、快照不认得"这类只在一半代码里修的偏差，
 * 而症状是数据少一列、或者插入直接报错。
 *
 * 这里只读不写：任何一个函数都不该改变数据库状态。
 */
import type { Client } from 'pg'
import { msg, TenonError } from '@tenon/protocol'

/** 永远不碰的 schema（系统自己的） */
export const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])

/**
 * 每批多少行。500 在 PGlite 与真 PG 上都是一个"稳且不慢"的数。
 * 迁移与快照共用 —— 两处各调一个数字，压测时不知道该信哪个。
 */
export const COPY_BATCH = 500

/** 记账表 / 迁移表：它们描述的是"怎么建表"，不是用户数据 */
export const SKIP_TABLE = /^(typeorm_|migrations$|pg_)/i

export interface TableRef {
  schema: string
  name: string
  /** `schema.name`，日志与排序用 */
  id: string
}

export interface ColumnRef {
  name: string
  /** `GENERATED ALWAYS AS (...) STORED` 之类的列：不能出现在 INSERT 里 */
  generated: boolean
  /** identity / serial：搬完要对齐序列 */
  sequence: string | null
  /** `GENERATED ALWAYS AS IDENTITY`：插入时必须 `OVERRIDING SYSTEM VALUE` */
  alwaysIdentity: boolean
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function refId(ref: TableRef): string {
  return `${ref.schema}.${ref.name}`
}

export function qualified(ref: TableRef): string {
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

export async function listTables(client: Client, schemas: string[]): Promise<TableRef[]> {
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
export async function listForeignKeys(
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
    throw new TenonError('DB_MIGRATE_FAILED', msg('error.db.cyclicFk', { tables: stuck.join(', ') }))
  }

  return ordered.map((id) => byId.get(id) as TableRef)
}

export async function listColumns(client: Client, ref: TableRef): Promise<ColumnRef[]> {
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
export async function tableExists(client: Client, ref: TableRef): Promise<boolean> {
  const result = await client.query(
    `select 1 from information_schema.tables
      where table_schema = $1 and table_name = $2 and table_type = 'BASE TABLE'`,
    [ref.schema, ref.name],
  )
  return result.rowCount !== null && result.rowCount > 0
}

export async function countRows(client: Client, ref: TableRef): Promise<number> {
  const result = await client.query<{ n: string }>(`select count(*)::text as n from ${qualified(ref)}`)
  return Number(result.rows[0]?.n ?? '0')
}
