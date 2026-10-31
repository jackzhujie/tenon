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

/** 传输层约定：RPC 走 `POST /rpc/<method>`，body 即入参；事件走 `GET /events?appId&since` */
export const TRANSPORT = {
  rpcPathPrefix: '/rpc/',
  eventsPath: '/events',
  healthPath: '/api/health',
  /** 渲染器与本机 server 之间唯一的凭证头 */
  tokenHeader: 'authorization',
} as const
