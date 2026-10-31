import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { dataSourceOptions } from './db'
import { HealthController } from './health.controller'
import { ItemEntity } from './items/item.entity'
import { ItemsController } from './items/items.controller'
import { ItemsService } from './items/items.service'

@Module({
  imports: [
    // forRoot 里的 migrationsRun: true 会在连接建立后自动跑 api/migrations/
    TypeOrmModule.forRoot(dataSourceOptions()),
    TypeOrmModule.forFeature([ItemEntity]),
  ],
  controllers: [HealthController, ItemsController],
  providers: [ItemsService],
})
export class AppModule {}
