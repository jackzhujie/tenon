/**
 * CORS：只为**回环 origin** 放行。
 *
 * 为什么需要它：开发形态下页面在 `http://127.0.0.1:5173`、server 在另一个随机端口 ——
 * 是两个 origin。不补救的话 `fetch` 和 `EventSource` 都会被浏览器拦掉。
 *
 * 为什么不干脆放开：Token 才是安全边界（见 `auth.ts`）。但「任意网页都能拿到响应」
 * 会让 Token 变成摆设的一半 —— 恶意页面虽然拿不到 Token，却能把用户的浏览器当成
 * 扫描器去打本地端口。限定回环 origin 把这条路堵住，且不影响任何正常用法：
 * Electron（`file://` 或自定义协议）、同源托管、本机 dev server 三种形态都在白名单逻辑内
 * （前两种根本不发 Origin，天然不触发 CORS）。
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { TRANSPORT } from '@tenon/protocol'

const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i

/** 返回应回显的 Origin（无 Origin 或非回环则返回 undefined，表示不加 CORS 头） */
export function allowOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined
  return LOOPBACK_ORIGIN.test(origin) ? origin : undefined
}

export const CORS_HEADERS = {
  // 头名跟着 `TRANSPORT` 走：前端改了凭证头而这里没改，症状是预检通过、真请求 401
  headers: `${TRANSPORT.tokenHeader}, content-type`,
  methods: 'GET, POST, OPTIONS',
  maxAge: '600',
} as const

/** 把 CORS 头写进一个普通的 header 记录（SSE 走 `reply.hijack()`，用得上） */
export function corsHeaderRecord(origin: string | undefined): Record<string, string> {
  const allowed = allowOrigin(origin)
  if (allowed === undefined) return {}
  return {
    'access-control-allow-origin': allowed,
    vary: 'origin',
    'access-control-allow-headers': CORS_HEADERS.headers,
    'access-control-allow-methods': CORS_HEADERS.methods,
    'access-control-max-age': CORS_HEADERS.maxAge,
  }
}

/**
 * 预检必须在**鉴权之前**答掉：浏览器发 OPTIONS 时不带 Authorization，
 * 让鉴权 hook 先看到它 → 401 → 预检失败 → 真正的请求根本发不出去。
 * 所以这个 hook 注册在 `requireBearer` 之前，并且对 OPTIONS 直接终止。
 */
export async function handleCors(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const allowed = allowOrigin(request.headers.origin)
  if (allowed !== undefined) {
    reply.header('access-control-allow-origin', allowed)
    reply.header('vary', 'origin')
    reply.header('access-control-allow-headers', CORS_HEADERS.headers)
    reply.header('access-control-allow-methods', CORS_HEADERS.methods)
    reply.header('access-control-max-age', CORS_HEADERS.maxAge)
  }
  if (request.method === 'OPTIONS') {
    await reply.code(204).send()
  }
}
