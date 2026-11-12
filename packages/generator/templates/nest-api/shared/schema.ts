/**
 * 前后端共用的契约（zod）。
 *
 * 这里是**唯一**定义"事项长什么样"的地方：后端用它校验入参，前端用它拿类型，
 * 两边不可能漂移。也是 DESIGN §7.1 说的"生成应用的 shared schema 复用同一套写法"。
 */
import { z } from 'zod'

export const ItemInput = z.object({
  title: z.string().trim().min(1, 'the title is required').max(120, 'the title is at most 120 characters'),
})
export type ItemInput = z.infer<typeof ItemInput>

export const ItemPatch = z.object({
  done: z.boolean(),
})
export type ItemPatch = z.infer<typeof ItemPatch>

export const Item = z.object({
  id: z.number().int(),
  title: z.string(),
  done: z.boolean(),
  createdAt: z.string(),
})
export type Item = z.infer<typeof Item>
