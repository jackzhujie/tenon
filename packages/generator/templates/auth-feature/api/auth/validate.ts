/**
 * 入参校验：用 `shared/auth-schema.ts` 的同一份 zod 契约。
 *
 * 为什么不让后端自己写一遍 DTO：那样前后端就有两个"邮箱长什么样"的定义，
 * 迟早有一个先改。这里多一层转换，换来的是"规则只有一份"。
 *
 * 报错直接说清是哪个字段：`400 邮箱格式不对` 比 `400 Bad Request` 省一轮排查。
 */
import { BadRequestException } from '@nestjs/common'
import type { ZodType } from 'zod'

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
      .join('；')
    throw new BadRequestException(detail)
  }
  return result.data
}
