/** 统一响应封装（DESIGN §7.4）。服务端只吐这两种形状，前端只解这两种。 */
import { z } from 'zod'
import { ErrorPayload } from './errors.js'

export const RpcSuccess = z.object({
  ok: z.literal(true),
  data: z.unknown(),
})
export type RpcSuccess<T = unknown> = { ok: true; data: T }

export const RpcFailure = z.object({
  ok: z.literal(false),
  error: ErrorPayload,
})
export type RpcFailure = z.infer<typeof RpcFailure>

export type RpcEnvelope<T = unknown> = RpcSuccess<T> | RpcFailure

export function rpcOk<T>(data: T): RpcSuccess<T> {
  return { ok: true, data }
}

export function rpcFail(error: z.infer<typeof ErrorPayload>): RpcFailure {
  return { ok: false, error }
}
