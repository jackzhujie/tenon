/**
 * 鉴权：Bearer Token，只绑 127.0.0.1 还要 Token 的原因 ——
 * 本机上任何进程（包括恶意页面通过 localhost 发起的请求）都能访问本地端口，
 * 而 Tenon 能读写用户磁盘。Token 是「本机也不许别人随便用」这条边界的唯一实现。
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { TRANSPORT, rpcFail } from '@tenon/protocol'

/** 健康检查不需要 Token：外部 supervisor / 探针要用，且它不泄露任何用户数据 */
const PUBLIC_PATHS = new Set<string>([TRANSPORT.healthPath])

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

export function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers[TRANSPORT.tokenHeader]
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  // SSE 走 EventSource 时无法自定义请求头，允许 query 传（仍然是 127.0.0.1 内的短连接）
  const query = request.query as Record<string, unknown> | undefined
  const fromQuery = query?.['token']
  return typeof fromQuery === 'string' && fromQuery !== '' ? fromQuery : undefined
}

export function requireBearer(token: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0] ?? request.url
    if (PUBLIC_PATHS.has(path)) return
    const provided = extractToken(request)
    if (provided === undefined || !safeEqual(provided, token)) {
      await reply
        .code(401)
        .header('content-type', 'application/json; charset=utf-8')
        .send(rpcFail({ code: 'UNAUTHORIZED', message: '缺少或错误的访问令牌' }))
    }
  }
}
