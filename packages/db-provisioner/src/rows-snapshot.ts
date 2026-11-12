/**
 * `postgres` 档的整库快照 —— **纯 JS**，不依赖 `pg_dump` / `pg_restore`。
 *
 * 为什么换掉 `pg_dump`：它是 PG 官方的、最忠实的导出，但**用户机器上通常没有**。
 * 这跟跨档迁移当初放弃 `pg_dump` 是同一个理由（`migrate.ts` 文件头），
 * 而"打了快照"这件事如果只在装了 postgresql-client 的机器上成立，
 * 那它在真正需要的时候（用户回滚）大概率不成立。所以这里与迁移保持同一套做法：
 * 用 PG 协议读出来，写成一个自描述的 JSON。
 *
 * **只存数据不存结构**：结构与代码同源（TypeORM migrations 两档都跑）。
 * 这不是偷懒，而是回滚流程本身要求的 —— 回滚是「把代码 revert 回去 + 把数据还原回去」，
 * 表结构不会跟着代码退回去（migrations 只向前跑），所以"按列名取交集再写回去"
 * 恰恰是正确的语义：回滚点之后新加的列会留空，而不会让整次还原失败。
 *
 * 两个必须如实汇报的偏差（不静默）：
 * 1. **目标库里不存在的表** → 跳过并列出（可能是回滚点之后才有的表）
 * 2. **快照里有、目标库里没有的列** → 丢掉这些列并列出（同上）
 *
 * 类型保真度：`pg` 驱动返回的就是 JS 值（`timestamptz` → Date、`numeric` → string、
 * `jsonb` → object、数组 → array），写回时由驱动序列化，来回一趟不失真。
 * 唯一需要打标的是 `bytea` —— 它是 `Buffer`，JSON 化会变成 `{type:'Buffer',data:[…]}`，
 * 写回去就坏了，所以显式编成 base64。
 */
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib'
import { promisify } from 'node:util'
import { msg, TenonError } from '@tenon/protocol'
import type { Client } from 'pg'
import {
  COPY_BATCH,
  listColumns,
  listForeignKeys,
  listTables,
  orderTables,
  qualified,
  quoteIdent,
  refId,
  SKIP_TABLE,
  type ColumnRef,
  type TableRef,
} from './introspect.js'

const gzip = promisify(gzipCallback)
const gunzip = promisify(gunzipCallback)

/** 文件格式的标识。改结构时必须一起改 `version`，否则老快照会被当新格式读 */
const FORMAT = 'tenon-db-rows'
const VERSION = 1

export interface SnapshotTable {
  schema: string
  name: string
  /** 快照里实际存了哪些列（生成列不在里面 —— 它由目标库自己算） */
  columns: string[]
  /** 与 `columns` 对齐的值数组。行是数组不是对象：列名重复一遍会大好几倍 */
  rows: unknown[][]
}

export interface RowsSnapshotFile {
  format: typeof FORMAT
  version: number
  createdAt: number
  /** 洗掉密码的连接串（排障时要知道这份快照来自哪个库） */
  source: string
  /** 表数 / 行数：读文件时不用遍历就能显示"这份快照有多大" */
  tableCount: number
  rowCount: number
  tables: SnapshotTable[]
}

export interface RowsRestoreReport {
  tables: Array<{ table: string; rows: number }>
  totalRows: number
  /** 目标库里不存在、因此被跳过的表（回滚点之后才建的表会出现在这里） */
  skippedTables: string[]
  /** 快照里有、目标库里已经没有的列（回滚点之后删掉的列） */
  droppedColumns: Array<{ table: string; columns: string[] }>
}

/** `bytea` 在 JSON 里必须打标，否则 `Buffer` 会被序列化成 `{type,data}` 再也写不回去 */
interface TaggedBytea {
  __tenon_bytea: string
}

function isTaggedBytea(value: unknown): value is TaggedBytea {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TaggedBytea).__tenon_bytea === 'string' &&
    Object.keys(value).length === 1
  )
}

function encodeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __tenon_bytea: value.toString('base64') } satisfies TaggedBytea
  return value
}

function decodeValue(value: unknown): unknown {
  return isTaggedBytea(value) ? Buffer.from(value.__tenon_bytea, 'base64') : value
}

/** 打快照：读连接上的所有用户表。返回可 JSON 化的结构（不落盘，落盘在 `encodeRowsSnapshot`） */
export async function dumpRowsSnapshot(
  client: Client,
  options: { source: string; schemas?: string[] },
): Promise<RowsSnapshotFile> {
  const schemas = options.schemas ?? ['public']
  const all = await listTables(client, schemas)
  const tables = all.filter((table) => !SKIP_TABLE.test(table.name))

  const snapshotTables: SnapshotTable[] = []
  let rowCount = 0

  for (const table of tables) {
    const columns = await listColumns(client, table)
    // 生成列不存：目标库会按定义自己算出来，存了反而在还原时被拒绝（不能写入生成列）
    const writable = columns.filter((column) => !column.generated)
    if (writable.length === 0) continue

    const columnList = writable.map((column) => quoteIdent(column.name)).join(', ')
    const result = await client.query<Record<string, unknown>>(
      `select ${columnList} from ${qualified(table)}`,
    )
    const rows = result.rows.map((row) => writable.map((column) => encodeValue(row[column.name])))
    rowCount += rows.length
    snapshotTables.push({
      schema: table.schema,
      name: table.name,
      columns: writable.map((column) => column.name),
      rows,
    })
  }

  return {
    format: FORMAT,
    version: VERSION,
    createdAt: Date.now(),
    source: options.source,
    tableCount: snapshotTables.length,
    rowCount,
    tables: snapshotTables,
  }
}

/** 结构 → gzip 字节流 */
export async function encodeRowsSnapshot(file: RowsSnapshotFile): Promise<Buffer> {
  return gzip(Buffer.from(JSON.stringify(file), 'utf8'))
}

/**
 * gzip 字节流 → 结构。
 *
 * 三种失败分开报：不是 gzip、不是 JSON、是 JSON 但格式不对。
 * 合成一句"快照损坏"的话，用户不知道该重打快照还是该升级版本。
 */
export async function decodeRowsSnapshot(bytes: Buffer): Promise<RowsSnapshotFile> {
  let raw: string
  try {
    raw = (await gunzip(bytes)).toString('utf8')
  } catch (error) {
    throw new TenonError('DB_UNSUPPORTED', msg('error.db.notSnapshot', { detail: messageOf(error) }))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new TenonError('DB_UNSUPPORTED', msg('error.db.notJson', { detail: messageOf(error) }))
  }
  if (!isRowsSnapshotFile(parsed)) {
    throw new TenonError('DB_UNSUPPORTED', msg('error.db.unknownSnapshot'))
  }
  if (parsed.version > VERSION) {
    throw new TenonError('DB_UNSUPPORTED', msg('error.db.newerSnapshot', { found: parsed.version, known: VERSION }))
  }
  return parsed
}

function isRowsSnapshotFile(value: unknown): value is RowsSnapshotFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RowsSnapshotFile>
  return (
    candidate.format === FORMAT &&
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.tables) &&
    candidate.tables.every(
      (table) =>
        typeof table === 'object' &&
        table !== null &&
        typeof (table as SnapshotTable).name === 'string' &&
        Array.isArray((table as SnapshotTable).columns) &&
        Array.isArray((table as SnapshotTable).rows),
    )
  )
}

/**
 * 还原：**一个事务里**先按外键逆序删、再按正序插。
 *
 * 为什么整段包在事务里：中途失败（缺外键、值超范围）时如果已经删了一半，
 * 用户手上就是"库被清空了、快照没写进去"。事务让失败变成"什么都没发生"。
 *
 * 为什么不用 `TRUNCATE ... CASCADE`：CASCADE 会连**不在快照里**的引用表一起清空 ——
 * 那等于替用户删数据。按逆序 `DELETE` 只会碰我们准备写回去的那些表。
 */
export async function restoreRowsSnapshot(
  client: Client,
  snapshot: RowsSnapshotFile,
  log?: (line: string) => void,
): Promise<RowsRestoreReport> {
  const schemas = [...new Set(snapshot.tables.map((table) => table.schema))]
  const existing = new Map((await listTables(client, schemas)).map((table) => [table.id, table]))

  const targets: Array<{ ref: TableRef; source: SnapshotTable; columns: string[]; indexes: number[] }> = []
  const skippedTables: string[] = []
  const droppedColumns: Array<{ table: string; columns: string[] }> = []

  for (const table of snapshot.tables) {
    const ref: TableRef = { schema: table.schema, name: table.name, id: `${table.schema}.${table.name}` }
    const live = existing.get(ref.id)
    if (live === undefined) {
      // 只跳过"这次还原前目标库里确实没有"的表，并且要说出来
      skippedTables.push(ref.id)
      continue
    }
    const liveColumns = await listColumns(client, live)
    const writable = new Set(liveColumns.filter((column) => !column.generated).map((c) => c.name))
    const columns = table.columns.filter((name) => writable.has(name))
    const dropped = table.columns.filter((name) => !writable.has(name))
    if (dropped.length > 0) droppedColumns.push({ table: ref.id, columns: dropped })
    if (columns.length === 0) {
      skippedTables.push(ref.id)
      continue
    }
    /*
     * 关键：**按列名取下标**，不能假设"保留下来的列就是行数组的前 N 个"。
     *
     * 少一列（快照之后 `drop column` 过）时，行数组里那个位置之后的全部值都会
     * 往前错一位 —— 类型相容就是**静默写进错误的列**，类型不容才报
     * "malformed array literal"。后者还算好运。
     */
    targets.push({
      ref: live,
      source: table,
      columns,
      indexes: columns.map((name) => table.columns.indexOf(name)),
    })
  }

  if (targets.length === 0) {
    throw new TenonError(
      'DB_RESTORE_FAILED',
      msg('error.db.noTablesInTarget'),
      { skippedTables },
    )
  }

  // 删与插都要按外键顺序：插是父在前，删是子在前
  const fks = await listForeignKeys(client, schemas)
  const ordered = orderTables(
    targets.map((target) => target.ref),
    fks,
  )
  const byId = new Map(targets.map((target) => [target.ref.id, target]))
  const insertOrder = ordered.map((ref) => byId.get(ref.id) as (typeof targets)[number])
  const deleteOrder = [...insertOrder].reverse()

  const report: RowsRestoreReport = {
    tables: [],
    totalRows: 0,
    skippedTables,
    droppedColumns,
  }

  await client.query('begin')
  try {
    for (const target of deleteOrder) {
      await client.query(`delete from ${qualified(target.ref)}`)
    }

    for (const target of insertOrder) {
      const columnList = target.columns.map((name) => quoteIdent(name)).join(', ')
      const liveColumns = await listColumns(client, target.ref)
      const overriding = target.columns.some((name) => hasAlwaysIdentity(liveColumns, name))
        ? ' overriding system value'
        : ''

      let written = 0
      for (let offset = 0; offset < target.source.rows.length; offset += COPY_BATCH) {
        const chunk = target.source.rows.slice(offset, offset + COPY_BATCH)
        const values: unknown[] = []
        const placeholders: string[] = []
        for (const row of chunk) {
          const slots: string[] = []
          for (const sourceIndex of target.indexes) {
            values.push(decodeValue(row[sourceIndex]))
            slots.push(`$${values.length}`)
          }
          placeholders.push(`(${slots.join(', ')})`)
        }
        const inserted = await client.query(
          `insert into ${qualified(target.ref)} (${columnList})${overriding}
             values ${placeholders.join(', ')}`,
          values,
        )
        written += inserted.rowCount ?? 0
      }

      await syncSequences(client, target.ref, target.columns)
      report.tables.push({ table: refId(target.ref), rows: written })
      report.totalRows += written
      log?.(`[tenon] 还原 ${refId(target.ref)}：${written} 行`)
    }

    await client.query('commit')
    return report
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw new TenonError('DB_RESTORE_FAILED', msg('error.db.restoreRolledBack', { detail: messageOf(error) }))
  }
}

/** 这一列是不是 `GENERATED ALWAYS AS IDENTITY`（插入时必须 OVERRIDING SYSTEM VALUE） */
function hasAlwaysIdentity(columns: ColumnRef[], name: string): boolean {
  return columns.some((column) => column.name === name && column.alwaysIdentity)
}

/**
 * 还原之后把序列推到当前最大值。
 *
 * 跟迁移里那步是同一个道理：不做的话还原当场全绿，用户点"新建"才主键冲突。
 * 这里以**还原后的库**为准（`max(列)`），不以快照里的数据为准 ——
 * 因为交集可能丢掉了一些列，快照里的 max 不一定写进去了。
 */
async function syncSequences(client: Client, ref: TableRef, columns: string[]): Promise<void> {
  const live = await listColumns(client, ref)
  for (const column of live) {
    if (column.sequence === null) continue
    if (!columns.includes(column.name)) continue
    const current = await client.query<{ last: string | null }>(
      `select max(${quoteIdent(column.name)})::text as last from ${qualified(ref)}`,
    )
    const last = current.rows[0]?.last
    if (last === null || last === undefined) continue
    const sequence = await client.query<{ seq: string | null }>(
      `select pg_get_serial_sequence($1, $2) as seq`,
      [refId(ref), column.name],
    )
    const seq = sequence.rows[0]?.seq
    if (seq === null || seq === undefined) continue
    await client.query('select setval($1::regclass, $2::bigint, true)', [seq, last])
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
