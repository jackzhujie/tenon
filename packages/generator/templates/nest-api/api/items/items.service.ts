import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import type { Repository } from 'typeorm'
import type { ItemInput } from '../../shared/schema'
import { ItemEntity } from './item.entity'

@Injectable()
export class ItemsService {
  constructor(@InjectRepository(ItemEntity) private readonly items: Repository<ItemEntity>) {}

  list(): Promise<ItemEntity[]> {
    return this.items.find({ order: { id: 'ASC' } })
  }

  create(input: ItemInput): Promise<ItemEntity> {
    return this.items.save(this.items.create({ title: input.title, done: false }))
  }

  async setDone(id: number, done: boolean): Promise<ItemEntity> {
    const item = await this.items.findOne({ where: { id } })
    if (item === null) throw new NotFoundException(`没有 id=${id} 的事项`)
    item.done = done
    return this.items.save(item)
  }

  async remove(id: number): Promise<void> {
    const result = await this.items.delete({ id })
    if (result.affected === 0) throw new NotFoundException(`没有 id=${id} 的事项`)
  }
}
