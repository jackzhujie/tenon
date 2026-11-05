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
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { appPaths, type TenonHome } from '@tenon/core'
import { TenonError } from '@tenon/protocol'
import { migrateDatabase, type MigrateReport } from './migrate.js'
import { createPgliteProvider } from './pglite.js'
import { createPostgresProvider } from './postgres.js'
import type { DatabaseProvider, DbMode, DbSnapshot } from './types.js'

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

  /**
   * 把应用数据迁到另一个档（发布路径：`pglite` → `postgres`）。
   *
   * 两条约束写在这里而不是文档里：
   * 1. **源永远是当前档在用的那个库**（`acquire` 出来的 provider），目标是**临时**起的，
   *    迁完就关掉。切换档位靠的是重启进程时改 `TENON_DB_MODE` —— 同一进程里两档并用
   *    只会让人分不清"现在到底在写哪个库"。
   * 2. **只搬数据不搬结构**：目标库表不存在时直接报错，并提示先让应用在目标档启动一次
   *    （TypeORM migrations 会建表）。结构与代码同源是这个产品的前提。
   */
  async migrate(
    appId: string,
    target: { mode: DbMode; connectionString?: string | null },
  ): Promise<MigrateReport> {
    const source = await this.acquire(appId)
    if (target.mode === source.mode) {
      throw new TenonError(
        'DB_UNSUPPORTED',
        `源和目标都是 ${source.mode} 档，没有可迁的东西。跨档迁移才有意义。`,
        { mode: source.mode },
      )
    }

    const paths = appPaths(this.options.home, appId)
    const to: DatabaseProvider =
      target.mode === 'postgres'
        ? createPostgresProvider({
            connectionString: target.connectionString ?? this.requirePostgresUrl(),
            snapshotsDir: paths.exportsDir,
            ...(this.options.log === undefined ? {} : { log: this.options.log }),
          })
        : createPgliteProvider({
            // 反向迁移（把云 PG 拉回本地）落到兄弟目录，绝不覆盖正在用的数据目录
            dataDir: `${paths.pgdataDir}-imported`,
            snapshotsDir: paths.exportsDir,
            ...(this.options.log === undefined ? {} : { log: this.options.log }),
          })

    await to.start()
    try {
      return await migrateDatabase({ from: source, to })
    } finally {
      await to.stop().catch(() => undefined)
    }
  }

  /**
   * 给应用库打一份快照，按 commit sha 归档。
   *
   * **为什么按 sha 归档**：快照要能回答"回到某一版时代码该配哪个库"。按时间戳命名的话，
   * 回滚时还得反查"哪个文件对应哪个提交"，等于把关系存两遍。
   *
   * **什么时候不存**：`pglite` 档的数据目录还不存在时直接返回 `null` —— 那说明这个应用
   * 从没起过带库的预览，库是空的，存一份空库只会让"有快照"变成一个骗人的信号。
   *
   * **为什么不主动把库拉起来**：`dump()` 要求实例就绪，起一次 PGlite 要 2.4s / 38MB。
   * 但如果数据目录在、库却没跑，那多半是用户刚关掉预览 —— 里面确实有数据，必须存。
   * 所以判据是"目录在不在"而不是"库跑没跑"，跑起来存完再按原状放回去。
   */
  async snapshot(appId: string, sha: string): Promise<DbSnapshot | null> {
    const dir = this.snapshotDir(appId, sha)
    const paths = appPaths(this.options.home, appId)

    if (this.dbMode === 'pglite') {
      const exists = await stat(paths.pgdataDir).then(
        (info) => info.isDirectory(),
        () => false,
      )
      if (!exists) return null
    }

    const provider = this.providerFor(appId)
    const wasReady = provider.status().state === 'ready'
    const running = wasReady ? provider : await this.acquire(appId)
    try {
      await mkdir(dir, { recursive: true })
      /*
       * 扩展名带出档位信息：`.tar.gz` 是 pglite 的数据目录归档，
       * `.rows.json.gz` 是 postgres 档的纯 JS 行快照（`findSnapshot` 靠它判档位）。
       * 旧版用 `.dump`（`pg_dump --format=custom`），还原时会明确报"格式不认识"，
       * 不会把两种格式混着读。
       */
      const name = this.dbMode === 'postgres' ? 'db.rows.json.gz' : 'db.tar.gz'
      const snapshot = await running.dump(join(dir, name))
      this.options.log?.(`[tenon] 库快照 ${sha.slice(0, 7)}（${(snapshot.bytes / 1024 / 1024).toFixed(1)}MB）`)
      return snapshot
    } finally {
      // 本来就没跑：存完按原状停掉，别为了一个快照把内存占着
      if (!wasReady) await this.release(appId)
    }
  }

  /** 找某个 commit 的快照；没有返回 `null`（不抛错 —— "没有"是正常状态） */
  async findSnapshot(appId: string, sha: string): Promise<DbSnapshot | null> {
    const dir = this.snapshotDir(appId, sha)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return null
    }
    const name = names.find((candidate) => candidate.startsWith('db.'))
    if (name === undefined) return null
    const file = join(dir, name)
    try {
      const info = await stat(file)
      return {
        // 只有 pglite 的归档叫 db.tar.gz；其余（含旧的 db.dump）一律按 postgres 档算
        mode: name.endsWith('.tar.gz') ? 'pglite' : 'postgres',
        file,
        bytes: info.size,
        createdAt: info.mtimeMs,
      }
    } catch {
      return null
    }
  }

  /**
   * 用快照覆盖当前库。
   *
   * 两个前提写在签名外面，因为违反了会以很难查的方式坏掉：
   * 1. **调用方负责先把预览停掉。** `pglite` 的 `restore()` 会销毁实例重建，
   *    这时候 Nest 进程还连着的话，它会看到连接被掐断并开始刷错误日志 ——
   *    数据本身不会坏，但日志面板会红一片，用户以为出了大事。
   * 2. **档位不匹配直接拒绝。** 拿一个 `pglite` 的 tar.gz 去当行快照解，只会得到
   *    一句"这不是一份 Tenon 的库快照（gzip 解不开）"，不如在这里说清楚。
   */
  async restoreSnapshot(appId: string, snapshot: DbSnapshot): Promise<void> {
    if (snapshot.mode !== this.dbMode) {
      throw new TenonError(
        'DB_RESTORE_FAILED',
        `快照是 ${snapshot.mode} 档的，当前是 ${this.dbMode} 档，不能直接还原。`,
        { snapshotMode: snapshot.mode, mode: this.dbMode },
      )
    }

    const provider = this.providerFor(appId)
    const wasReady = provider.status().state === 'ready'
    // postgres 档的 restore() 要求先探活成功；pglite 的不要求（它自己会起停）
    if (this.dbMode === 'postgres' && !wasReady) await provider.start()
    try {
      await provider.restore(snapshot)
      this.options.log?.(`[tenon] 库已还原到 ${snapshot.file}`)
    } finally {
      if (!wasReady) await this.release(appId)
    }
  }

  private snapshotDir(appId: string, sha: string): string {
    // `exports/` 在 `.gitignore` 的 PRUNE_DIRS 里，不会被提交，也不会被当成应用文件
    return join(appPaths(this.options.home, appId).exportsDir, 'db', sha)
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
