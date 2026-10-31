/**
 * 应用数据库的**唯一**抽象（DESIGN §6.4）。
 *
 * 存在的理由：同一个生成应用要能在三种地方跑，而代码一行不改 ——
 * 本地预览（PGlite，WASM 版 PostgreSQL，零安装）、Docker 导出（compose 自带的
 * `postgres:18-alpine`）、用户自备的云 PG。区别只由平台层在这里抹平，
 * 应用侧永远只看到 `DATABASE_URL`（铁律 2）。
 *
 * 两条硬约束写进接口，不写进文档：
 *
 * 1. **`poolMax()` 在 `pglite` 档恒为 1。** PGlite 只有一个 backend 会话，
 *    `pool.max > 1` 时两条连接的事务会落在同一个会话上，一条 `ROLLBACK` 会把
 *    另一条「已写入未提交」的行一起抹掉 —— 这是**静默数据损坏**，不是性能问题
 *    （SPIKES §1 实测：pool=2 时 A 事务两行只剩一行）。要并行只能靠网关的串行队列，
 *    不能靠加连接。改用别的档位时这里也必须显式回答"我的并发上限是多少"。
 * 2. **`connectionString()` 在 `start()` 之前调用要抛错。** 端口是 `start()` 才确定的
 *    （PGlite 走 `listen(0)`），提前给一个猜的端口会让上层拿到「能拼出 URL、
 *    但连不上」的连接串 —— 症状是预览白屏而日志干净。
 */

/** 两档 + 两个逃生口（`embedded` / `sqlite` 只在文档里，接口先留形状） */
export type DbMode = 'pglite' | 'postgres'

export type DbState = 'stopped' | 'starting' | 'ready' | 'failed'

export interface DbStatus {
  readonly mode: DbMode
  readonly state: DbState
  /** 未就绪时为 null（见文件头第 2 条） */
  readonly connectionString: string | null
  readonly port: number | null
  /** 交给生成应用的 `DATABASE_POOL_MAX`（`pglite` 恒为 1） */
  readonly poolMax: number
  /** `pglite` 档是数据目录；`postgres` 档是 null（库不归我们管） */
  readonly dataDir: string | null
  readonly error: string | null
}

/** 一次整库快照。`pglite` 是数据目录归档，`postgres` 是 `pg_dump --format=custom` */
export interface DbSnapshot {
  readonly mode: DbMode
  /** 绝对路径 */
  readonly file: string
  readonly bytes: number
  readonly createdAt: number
}

export interface DatabaseProvider {
  readonly mode: DbMode
  /** 幂等：重复调用不会起第二个实例（同一个数据目录不能被两个 PGlite 打开） */
  start(): Promise<void>
  /** 幂等，且**保留数据目录** —— 停预览不等于删库 */
  stop(): Promise<void>
  connectionString(): string
  /** 见文件头第 1 条 */
  poolMax(): number
  status(): DbStatus
  /** 打快照到 `file`；不传就落在 `snapshotsDir` 下的时间戳文件 */
  dump(file?: string): Promise<DbSnapshot>
  /** 用快照覆盖当前库（会重启实例）。返回后连接串不变，应用不需要重连 */
  restore(snapshot: DbSnapshot): Promise<void>
}

export interface ProviderOptions {
  /** `pglite` 的数据目录；`postgres` 忽略 */
  dataDir?: string
  /** 想固定快照落点就传；不传用 `dataDir` 的兄弟目录 `db-snapshots/` */
  snapshotsDir?: string
  log?: (line: string) => void
}

export interface PostgresProviderOptions extends ProviderOptions {
  /** 外部 PG 的连接串（发布档 / 云托管 / 用户自备） */
  connectionString: string
  /** 这条连接串背后的库允许多少并发（默认 10）。`pglite` 档没有这个自由度 */
  poolMax?: number
}
