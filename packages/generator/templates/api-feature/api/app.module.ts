import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { TypeOrmModule } from '@nestjs/typeorm'
import { dataSourceOptions } from './db'
import { HealthController } from './health.controller'
import { TenonLoggerFilter } from './tenon-logger'

/**
 * 应用的根模块。
 *
 * 刚加上后端时**只有健康检查**：没有业务表、没有示例接口 —— 那样不用假装懂用户要做什么。
 * 加一张表的三步：
 *
 * 1. 写 `api/<名字>/<名字>.entity.ts`（`@Entity`）
 * 2. 在下面 `TypeOrmModule.forFeature([...])` 里登记，控制器与服务加到 `controllers` / `providers`
 * 3. 写 `api/migrations/<时间戳>-Xxx.ts`，重启后端（迁移会自动跑）
 *
 * ★ 不要开 `synchronize`：它会在生产上悄悄删列。schema 只由迁移决定（见 `db.ts`）。
 */
@Module({
  imports: [
    // `migrationsRun: true` 会在连接建立后自动跑 api/migrations/
    TypeOrmModule.forRoot(dataSourceOptions()),
    TypeOrmModule.forFeature([]),
  ],
  controllers: [HealthController],
  providers: [
    // 4xx/5xx 统一成一行日志（输出走 stderr，网关的日志面板按 `api` 来源收）
    { provide: APP_FILTER, useClass: TenonLoggerFilter },
  ],
})
export class AppModule {}
