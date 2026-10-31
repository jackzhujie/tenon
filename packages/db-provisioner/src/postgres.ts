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
 * 备份走 `pg_dump --format=custom`：它是 PG 官方的逻辑导出，跨版本、跨档都能导回，
 * 也是「本地 PGlite → 云 PG」迁移的落点。没装 `pg_dump` 时明确报 `DB_UNSUPPORTED`，
 * 不要静默降级成一个"看起来成功了"的假备份。
 */
import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { TenonError } from '@tenon/protocol'
import type {
  DatabaseProvider,
  DbSnapshot,
  DbState,
  DbStatus,
  PostgresProviderOptions,
} from './types.js'

const run = promisify(execFile)
const PROBE_TIMEOUT_MS = 8_000
const DUMP_TIMEOUT_MS = 5 * 60 * 1000

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 连接串进日志前必须洗掉密码，否则一条 preview 日志就能泄一个云库 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password !== '') parsed.password = '***'
    return parsed.toString()
  } catch {
    return '<无法解析的连接串>'
  }
}

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
      throw new TenonError('DB_NOT_READY', '数据库还没探活成功，先别急着拿连接串', {
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
      this.log(`[tenon] 应用库就绪（${redactUrl(this.options.connectionString)}：${result.rows[0]?.version.split(',')[0] ?? 'PG'}）`)
    } catch (err) {
      this.state = 'failed'
      // 用户看到的那句话必须是完整的：只说 "connect ECONNREFUSED" 等于让人猜是哪个库
      const message = `连不上这个 PostgreSQL（${redactUrl(this.options.connectionString)}）：${messageOf(err)}`
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
      throw new TenonError('DB_NOT_READY', '数据库没探活成功，不能打快照', { mode: this.mode })
    }
    const target = file ?? join(this.snapshotsDir(), `${Date.now()}.dump`)
    await mkdir(dirname(target), { recursive: true })
    try {
      await run('pg_dump', ['--format=custom', `--file=${target}`, `--dbname=${this.options.connectionString}`], {
        timeout: DUMP_TIMEOUT_MS,
      })
      const info = await stat(target)
      return { mode: this.mode, file: target, bytes: info.size, createdAt: Date.now() }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new TenonError(
          'DB_UNSUPPORTED',
          '这台机器上没有 pg_dump，打不了原生 PG 的快照。装 postgresql-client 后重试，或改用 pglite 档。',
          { mode: this.mode },
        )
      }
      throw new TenonError('DB_DUMP_FAILED', `pg_dump 失败：${messageOf(err)}`, {
        mode: this.mode,
        file: target,
      })
    }
  }

  async restore(snapshot: DbSnapshot): Promise<void> {
    if (this.state !== 'ready') {
      throw new TenonError('DB_NOT_READY', '数据库没探活成功，不能还原', { mode: this.mode })
    }
    try {
      await run(
        'pg_restore',
        ['--clean', '--if-exists', '--no-owner', `--dbname=${this.options.connectionString}`, snapshot.file],
        { timeout: DUMP_TIMEOUT_MS },
      )
      this.log(`[tenon] 应用库已还原到 ${snapshot.file}`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new TenonError('DB_UNSUPPORTED', '这台机器上没有 pg_restore，还原不了原生 PG 的快照', {
          mode: this.mode,
        })
      }
      throw new TenonError('DB_RESTORE_FAILED', `pg_restore 失败：${messageOf(err)}`, {
        mode: this.mode,
        file: snapshot.file,
      })
    }
  }

  private snapshotsDir(): string {
    return this.options.snapshotsDir ?? join(process.cwd(), 'db-snapshots')
  }
}

export function createPostgresProvider(options: PostgresProviderOptions): PostgresProvider {
  return new PostgresProvider(options)
}
