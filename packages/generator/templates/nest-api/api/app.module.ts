import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { TypeOrmModule } from '@nestjs/typeorm'
import { dataSourceOptions } from './db'
import { HealthController } from './health.controller'
import { ItemEntity } from './items/item.entity'
import { ItemsController } from './items/items.controller'
import { ItemsService } from './items/items.service'
import { TenonLoggerFilter } from './tenon-logger'

@Module({
  imports: [
    // forRoot 里的 migrationsRun: true 会在连接建立后自动跑 api/migrations/
    TypeOrmModule.forRoot(dataSourceOptions()),
    TypeOrmModule.forFeature([ItemEntity]),
  ],
  controllers: [HealthController, ItemsController],
  providers: [
    ItemsService,
    // 4xx/5xx 统一成一行日志（输出走 stderr，网关的日志面板按 `api` 来源收）
    { provide: APP_FILTER, useClass: TenonLoggerFilter },
  ],
})
export class AppModule {}
