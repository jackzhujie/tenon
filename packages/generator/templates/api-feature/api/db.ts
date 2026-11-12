/**
 * 数据源配置。
 *
 * ★ **应用只认一个 `DATABASE_URL`**（DESIGN §6.4 / 铁律 2）：本地预览时它指向
 * PGlite（WASM 版 PostgreSQL），导出到 Docker 时它指向 compose 里的 `postgres`。
 * 这个文件里没有任何"我跑在桌面还是容器里"的分支 —— 一旦有，导出就必然破。
 *
 * `DATABASE_POOL_MAX` 不是环境判断，是**并发容量参数**：
 * PGlite 只有一个 backend 会话，平台会把它设成 1（`pool.max>1` 会让并发事务
 * 互相回滚，是静默数据损坏，见 SPIKES §1）；真 PG 上它就是普通的连接池上限。
 */
import { join } from 'node:path'
import type { DataSourceOptions } from 'typeorm'

export function databaseUrl(): string {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is missing. Tenon injects it when it starts a preview; for a manual run, set your own postgres:// connection string.',
    )
  }
  return url
}

export function poolMax(): number {
  const raw = Number(process.env['DATABASE_POOL_MAX'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10
}

/**
 * 实体清单。
 *
 * 加了 `@Entity` 之后**必须**在这里登记（导出到 Docker 时没有 `autoLoadEntities` 的
 * 扫描上下文，漏登记的表在容器里就是「表不存在」）。刚加上后端时是空的。
 */
export const entities = [] as const

export function dataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl(),
    entities: [...entities],
    // 迁移按文件名自动发现：加一个文件就生效，不用回来改这张表
    migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],
    migrationsTableName: 'app_migrations',
    // 起服务即迁移：预览/容器启动都不该多一步手工命令
    migrationsRun: true,
    // 永远不开 synchronize：它会在生产上悄悄删列，schema 只由迁移决定
    synchronize: false,
    logging: false,
    extra: {
      max: poolMax(),
      connectionTimeoutMillis: 15_000,
    },
  }
}
