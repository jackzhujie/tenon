/**
 * 按应用管理数据库实例（DESIGN §6.4 第 2 条：端口与生命周期归 App Gateway 管）。
 *
 * 两条设计选择值得记下来：
 *
 * 1. **provider 按 appId 缓存，只 stop 不丢弃。** 停预览会把 PGlite 关掉（省内存），
 *    但下一次 `acquire()` 复用同一个对象 —— 于是**端口不变**，上层（Nest 进程、
 *    前端记住的 `DATABASE_URL`）都不需要重连到新地址。
 * 2. **档位是平台设置，不是应用代码的分支。** 应用永远只拿到一个连接串；
 *    `TENON_DB_MODE` 决定这个串背后是 WASM 版 PG 还是一个真的 PG（铁律 2）。
 */
import { appPaths, type TenonHome } from '@tenon/core'
import { TenonError } from '@tenon/protocol'
import { createPgliteProvider } from './pglite.js'
import { createPostgresProvider } from './postgres.js'
import type { DatabaseProvider, DbMode } from './types.js'

export interface DatabaseManagerOptions {
  home: TenonHome
  /** 默认 `pglite`。发布档由 `TENON_DB_MODE=postgres` + `TENON_DATABASE_URL` 打开 */
  mode?: DbMode
  /** `postgres` 档必填（也接受 env 里的 `TENON_DATABASE_URL`） */
  connectionString?: string | null
  /** `postgres` 档的并发上限（默认 10）。`pglite` 档恒为 1，这里传什么都不生效 */
  poolMax?: number
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

export class DatabaseManager {
  private readonly providers = new Map<string, DatabaseProvider>()
  private readonly options: DatabaseManagerOptions
  private readonly dbMode: DbMode
  private readonly connectionString: string | null

  constructor(options: DatabaseManagerOptions) {
    this.options = options
    const env = options.env ?? process.env
    const fromEnv = env['TENON_DB_MODE']
    this.dbMode = options.mode ?? (fromEnv === 'postgres' ? 'postgres' : 'pglite')
    this.connectionString =
      options.connectionString ?? (env['TENON_DATABASE_URL'] ?? null) ?? null
  }

  get mode(): DbMode {
    return this.dbMode
  }

  /** 只建不启：需要连接串之前先看一眼状态时用 */
  providerFor(appId: string): DatabaseProvider {
    const cached = this.providers.get(appId)
    if (cached !== undefined) return cached

    const paths = appPaths(this.options.home, appId)
    const log = this.options.log
    const provider: DatabaseProvider =
      this.dbMode === 'postgres'
        ? createPostgresProvider({
            connectionString: this.requirePostgresUrl(),
            ...(this.options.poolMax === undefined ? {} : { poolMax: this.options.poolMax }),
            snapshotsDir: paths.exportsDir,
            ...(log === undefined ? {} : { log }),
          })
        : createPgliteProvider({
            dataDir: paths.pgdataDir,
            snapshotsDir: paths.exportsDir,
            ...(log === undefined ? {} : { log }),
          })
    this.providers.set(appId, provider)
    return provider
  }

  /** 起库并拿到可用的连接串（幂等） */
  async acquire(appId: string): Promise<DatabaseProvider> {
    const provider = this.providerFor(appId)
    await provider.start()
    return provider
  }

  /** 停库但保留数据目录与缓存的 provider（下次 acquire 端口不变） */
  async release(appId: string): Promise<void> {
    const provider = this.providers.get(appId)
    if (provider === undefined) return
    await provider.stop().catch(() => undefined)
  }

  status(appId: string) {
    return this.providers.get(appId)?.status() ?? null
  }

  async closeAll(): Promise<void> {
    const all = [...this.providers.values()]
    this.providers.clear()
    await Promise.all(all.map((provider) => provider.stop().catch(() => undefined)))
  }

  private requirePostgresUrl(): string {
    if (this.connectionString === null || this.connectionString === '') {
      throw new TenonError(
        'DB_START_FAILED',
        '当前是 postgres 档，但没有连接串。设 TENON_DATABASE_URL（或改用默认的 pglite 档）。',
        { mode: this.dbMode },
      )
    }
    return this.connectionString
  }
}
