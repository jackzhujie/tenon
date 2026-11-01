/**
 * `@tenon/db-provisioner` —— 应用数据库供给（DESIGN §6.4）。
 *
 * 依赖方向：`gateway → db-provisioner → {core, protocol}`。
 * 本包不认识 HTTP、不认识 RPC、不认识模板：给它一个 appId（或一个数据目录），
 * 它把数据库拉起来并给出一个 `DATABASE_URL`；应用侧永远只认这一个变量（铁律 2）。
 *
 * 两档：
 * - `pglite`（默认）：WASM 版 PostgreSQL 暴露成 TCP 端口，零安装，`pool.max` **恒为 1**
 * - `postgres`（发布）：外部连接串，只探活不接管生命周期
 */
export type {
  DatabaseProvider,
  DbMode,
  DbSnapshot,
  DbState,
  DbStatus,
  PostgresProviderOptions,
  ProviderOptions,
} from './types.js'
export { createPgliteProvider, PgliteProvider } from './pglite.js'
export { createPostgresProvider, PostgresProvider, redactUrl } from './postgres.js'
export { DatabaseManager, type DatabaseManagerOptions } from './manager.js'
export {
  migrateDatabase,
  orderTables,
  redact,
  type MigrateOptions,
  type MigrateProgress,
  type MigrateReport,
  type MigrateTableReport,
} from './migrate.js'
