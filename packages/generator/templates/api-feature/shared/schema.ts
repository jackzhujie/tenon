/**
 * 前后端共用的契约（zod）。
 *
 * 这里是**唯一**定义"接口返回什么形状"的地方：后端用它约束出参，前端用它拿类型，
 * 两边不可能漂移。加业务接口时照着它的写法往下加即可。
 *
 * 为什么值得多写一层：前端 `fetch` 拿回来的是 `unknown`。没有共享 schema 时，
 * 后端改一个字段名，前端要到运行时才炸，而且炸在某个 `undefined.map` 上。
 */
import { z } from 'zod'

/** `GET /api/health` 的响应 */
export const Health = z.object({
  ok: z.boolean(),
  db: z.object({
    database: z.string().nullable(),
    version: z.string(),
    /** 从**驱动的连接池实例**上读回来的上限（PGlite 档必须是 1） */
    poolMax: z.number().nullable(),
    migrations: z.number().int(),
  }),
  at: z.string(),
})
export type Health = z.infer<typeof Health>
