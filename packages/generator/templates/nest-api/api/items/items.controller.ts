import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { ItemInput, ItemPatch, type Item } from '../../shared/schema'
import type { ItemEntity } from './item.entity'
import { ItemsService } from './items.service'

function toDto(item: ItemEntity): Item {
  return {
    id: item.id,
    title: item.title,
    done: item.done,
    createdAt: item.createdAt.toISOString(),
  }
}

function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new BadRequestException(`invalid id: ${raw}`)
  return id
}

/**
 * 入参一律先用 zod 过一遍（契约在 `shared/schema.ts`，前端拿的是同一份类型）。
 * 不用 class-validator：多一个装饰器体系就多一处前后端不一致的机会。
 */
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  async list(): Promise<{ items: Item[] }> {
    return { items: (await this.items.list()).map(toDto) }
  }

  @Post()
  async create(@Body() body: unknown): Promise<Item> {
    const parsed = ItemInput.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('；'))
    }
    return toDto(await this.items.create(parsed.data))
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: unknown): Promise<Item> {
    const parsed = ItemPatch.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('；'))
    }
    return toDto(await this.items.setDone(parseId(id), parsed.data.done))
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: true }> {
    await this.items.remove(parseId(id))
    return { ok: true }
  }
}
