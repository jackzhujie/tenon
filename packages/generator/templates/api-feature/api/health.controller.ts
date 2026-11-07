import { Controller, Get } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'

/**
 * `GET /api/health` —— 预览的就绪判定与排障面板都打这条。
 *
 * `poolMax` 特意从**驱动的连接池实例**上读，而不是把环境变量原样回显：
 * 这样"配置有没有真的传到 pg.Pool"是可观测的（PGlite 档必须读到 1）。
 */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get()
  async check(): Promise<Record<string, unknown>> {
    const [db] = await this.db.query<Array<{ database: string; version: string }>>(
      'select current_database() as database, version() as version',
    )
    const pool = (this.db.driver as unknown as { master?: { options?: { max?: number } } }).master
    return {
      ok: true,
      db: {
        database: db?.database ?? null,
        version: (db?.version ?? '').split(' ').slice(0, 2).join(' '),
        poolMax: pool?.options?.max ?? null,
        migrations: await this.appliedMigrations(),
      },
      at: new Date().toISOString(),
    }
  }

  /** 迁移表在 `migrationsRun` 之后才有；万一没有就报 0，别让健康检查自己挂掉 */
  private async appliedMigrations(): Promise<number> {
    try {
      const rows = await this.db.query<Array<{ count: string }>>(
        'select count(*)::text as count from app_migrations',
      )
      return Number(rows[0]?.count ?? 0)
    } catch {
      return 0
    }
  }
}
