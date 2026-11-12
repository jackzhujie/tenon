/**
 * `postgres` 档 —— 发布档：库不归我们管，只负责"连得上"和"能备份"（DESIGN §6.4）。
 *
 * 和 `pglite` 档刻意不一样的三点：
 *
 * 1. **`start()` 只做探活。** Docker compose 里的 `postgres:18-alpine`、云托管、
 *    用户自备的实例，生命周期都该由 Docker / 云厂商 / 用户决定。我们去 kill 别人的库
 *    是越界，也会让「重启预览导致数据库重启」变成事故。
 * 2. **`stop()` 是空操作。** 停预览只该断连接，不该让数据库消失；数据目录也不是我们的。
 * 3. **并发上限由连接串背后的库说话**，默认 10（原生 PG 的常规值）。
 *    这里**没有** `pool.max=1` 那个约束 —— 那是 PGlite 单会话的产物。
 *
 * 备份**不再走 `pg_dump`**（v1.2.16 改）：那个二进制在用户机器上通常不存在，
 * 而"打了快照"只在装了 postgresql-client 的机器上成立，等于在最需要的时候（回滚）
 * 大概率不成立。现在是与跨档迁移同一套做法的纯 JS 逻辑快照（`rows-snapshot.ts`）：
 * 结构与代码同源（migrations 两档都跑），只搬数据。
 * 代价写在 `rows-snapshot.ts` 文件头：目标库缺表 / 缺列时会跳过并如实汇报。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Client } from 'pg'
import { msg, TenonError } from '@tenon/protocol'
import { redact } from './introspect.js'
import {
  decodeRowsSnapshot,
  dumpRowsSnapshot,
  encodeRowsSnapshot,
  restoreRowsSnapshot,
} from './rows-snapshot.js'
import type {
  DatabaseProvider,
  DbSnapshot,
  DbState,
  DbStatus,
  PostgresProviderOptions,
} from './types.js'

const PROBE_TIMEOUT_MS = 8_000

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 连接串进日志前必须洗掉密码，否则一条 preview 日志就能泄一个云库 */
export const redactUrl = redact

export class PostgresProvider implements DatabaseProvider {
  readonly mode = 'postgres' as const
  private state: DbState = 'stopped'
  private error: string | null = null
  private readonly log: (line: string) => void
  private readonly max: number

  constructor(private readonly options: PostgresProviderOptions) {
    this.log = options.log ?? (() => undefined)
    this.max = options.poolMax ?? 10
  }

  connectionString(): string {
    if (this.state !== 'ready') {
      throw new TenonError('DB_NOT_READY', msg('error.db.notLive'), {
        mode: this.mode,
      })
    }
    return this.options.connectionString
  }

  poolMax(): number {
    return this.max
  }

  status(): DbStatus {
    return {
      mode: this.mode,
      state: this.state,
      connectionString: this.state === 'ready' ? this.options.connectionString : null,
      port: null,
      poolMax: this.max,
      dataDir: null,
      error: this.error,
    }
  }

  async start(): Promise<void> {
    if (this.state === 'ready') return
    this.state = 'starting'
    this.error = null
    const client = new Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    })
    try {
      await client.connect()
      const result = await client.query<{ version: string }>('select version() as version')
      this.state = 'ready'
      this.log(`[tenon] 应用库就绪（${redact(this.options.connectionString)}：${result.rows[0]?.version.split(',')[0] ?? 'PG'}）`)
    } catch (err) {
      this.state = 'failed'
      // 用户看到的那句话必须是完整的：只说 "connect ECONNREFUSED" 等于让人猜是哪个库
      const message = `连不上这个 PostgreSQL（${redact(this.options.connectionString)}）：${messageOf(err)}`
      this.error = message
      throw new TenonError('DB_START_FAILED', message, { mode: this.mode })
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  /** 库不归我们管：停预览只该断连接 */
  async stop(): Promise<void> {
    this.state = 'stopped'
  }

  async dump(file?: string): Promise<DbSnapshot> {
    if (this.state !== 'ready') {
      throw new TenonError('DB_NOT_READY', msg('error.db.notReadyForSnapshot'), { mode: this.mode })
    }
    const target = file ?? join(this.snapshotsDir(), `${Date.now()}.rows.json.gz`)
    const client = await this.connect()
    try {
      const snapshot = await dumpRowsSnapshot(client, {
        source: redact(this.options.connectionString),
      })
      const bytes = await encodeRowsSnapshot(snapshot)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      const info = await stat(target)
      this.log(
        `[tenon] 应用库快照 ${target}（${snapshot.tableCount} 张表 / ${snapshot.rowCount} 行 / ` +
          `${(info.size / 1024).toFixed(1)}KB）`,
      )
      return { mode: this.mode, file: target, bytes: info.size, createdAt: Date.now() }
    } catch (err) {
      if (err instanceof TenonError) throw err
      throw new TenonError('DB_DUMP_FAILED', msg('error.db.dumpFailed', { detail: messageOf(err) }), {
        mode: this.mode,
        file: target,
      })
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  async restore(snapshot: DbSnapshot): Promise<void> {
    if (this.state !== 'ready') {
      throw new TenonError('DB_NOT_READY', msg('error.db.notLive'), { mode: this.mode })
    }
    const bytes = await readFile(snapshot.file)
    const file = await decodeRowsSnapshot(bytes)
    const client = await this.connect()
    try {
      const report = await restoreRowsSnapshot(client, file, this.log)
      // 跳过的东西必须出现在日志里：「还原成功」但少了一张表，用户得能看见
      if (report.skippedTables.length > 0) {
        this.log(
          `[tenon] ${report.skippedTables.length} tables in the snapshot do not exist in this database — skipped: ${report.skippedTables.join(', ')}`,
        )
      }
      for (const dropped of report.droppedColumns) {
        this.log(`[tenon] ${dropped.table} 的列 ${dropped.columns.join(', ')} 已不在当前库里，跳过`)
      }
      this.log(`[tenon] app database restored from ${snapshot.file} (${report.totalRows} rows)`)
    } catch (err) {
      if (err instanceof TenonError) throw err
      throw new TenonError('DB_RESTORE_FAILED', msg('error.db.restoreFailed', { detail: messageOf(err) }), {
        mode: this.mode,
        file: snapshot.file,
      })
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  private connect(): Promise<Client> {
    const client = new Client({ connectionString: this.options.connectionString })
    return client.connect().then(() => client)
  }

  private snapshotsDir(): string {
    return this.options.snapshotsDir ?? join(process.cwd(), 'db-snapshots')
  }
}

export function createPostgresProvider(options: PostgresProviderOptions): PostgresProvider {
  return new PostgresProvider(options)
}
