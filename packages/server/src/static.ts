/**
 * 同源托管渲染器产物（Electron 壳与 Web 模式的页面来源）。
 *
 * 为什么让 server 自己发页面，而不是 `loadFile('apps/web/dist/index.html')`：
 *
 * - **同源**。页面来自 `http://127.0.0.1:<port>/`，RPC 与 SSE 都在同一个 origin，
 *   于是完全不需要 CORS —— 少一条"只在打包后才会踩"的分支。
 * - **Token 只能在这里发**。它是每次启动随机生成的，写不进构建产物。
 *   `file://` 下没有可信的注入点（preload 也能做，但那等于给每个窗口开一个特权通道）；
 *   由 server 在响应 index.html 时把 token 塞进 `<head>`，是唯一不留后门的位置。
 * - **SPA 回落**只写一次。`file://` 形态要自己处理前端路由，这里天然就有。
 *
 * 安全边界：页面与静态资源免 Token，**`/rpc/*`、`/events`、`/api/*` 一律要 Token**。
 * 免 Token 的那部分只是 JS/CSS/HTML，不含任何用户数据；注入的 token 是页面自己调接口用的。
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { TRANSPORT } from '@tenon/protocol'

/** 需要 Token 的前缀：页面之外的每一个入口都在这里 */
const PROTECTED_PREFIXES = [TRANSPORT.rpcPathPrefix, TRANSPORT.eventsPath, '/api/'] as const

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Vite 给 `assets/` 下的文件名带内容哈希 → 可以永久缓存。
 * 其余（尤其 index.html）必须每次回源：它是注入 token 的那份，缓存住就是死 token。
 */
function cacheControl(pathname: string): string {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
}

export interface StaticServingOptions {
  /** `apps/web/dist` 的绝对路径 */
  readonly dir: string
  /** 注入进 index.html 的 Token */
  readonly token: string
}

export interface StaticServing {
  /**
   * 这个路径能不能免 Token。
   * 只放行"页面与它的静态资源"，接口一律返回 false（鉴权钩子会拦住）。
   */
  isPublicPath(path: string): boolean
  /** 返回 `false` 表示这条请求不归静态托管管（调用方应回 404） */
  handle(request: FastifyRequest, reply: FastifyReply): Promise<boolean>
}

/**
 * 页面自己的 CSP。
 *
 * 不设的话 Electron 每次启动都会警告 "no Content-Security-Policy"，而警告只是噪音 ——
 * 真正的问题是：页面里任何一段被注入的 `<script src>` 都能拿到 `window.__TENON__.token`。
 *
 * `script-src` 允许 `'unsafe-inline'`：注入 token 用的就是内联脚本，这是**唯一**的宽松点，
 * 换来的是不必给渲染器开 preload 特权通道。
 * `frame-src` 必须放开回环的任意端口 —— 预览 iframe 走的是 App Gateway 的随机端口。
 * `connect-src 'self'` 够用：RPC 与 SSE 都是同源。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ')

/** 把 token 与 CSP 塞进 `<head>` 的第一行：页面脚本执行前就必须能读到它 */
function injectBridge(html: string, token: string): string {
  const payload = JSON.stringify({ token })
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<script>window.__TENON__=${payload.replace(/</g, '\\u003c')}</script>`
  const match = html.match(/<head[^>]*>/i)
  if (match === null) return head + html
  const at = (match.index ?? 0) + match[0].length
  return html.slice(0, at) + head + html.slice(at)
}

/** `/apps/abc` 这类前端路由要回落；`/assets/x.js` 不许回落（回落成 HTML 只会得到 SyntaxError） */
function looksLikeFile(pathname: string): boolean {
  const ext = extname(pathname)
  return ext !== '' && ext !== '.html'
}

export function createStaticServing(options: StaticServingOptions): StaticServing {
  const root = resolve(options.dir)

  let indexCache: Promise<string> | null = null
  const indexHtml = (): Promise<string> => {
    indexCache ??= readFile(resolve(root, 'index.html'), 'utf8').then((html) =>
      injectBridge(html, options.token),
    )
    return indexCache
  }

  const sendIndex = async (reply: FastifyReply): Promise<boolean> => {
    const html = await indexHtml()
    await reply
      .code(200)
      .header('content-type', MIME['.html'])
      .header('cache-control', 'no-cache')
      .send(html)
    return true
  }

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false
    const pathname = decodeURIComponent((request.url.split('?')[0] ?? '/') || '/')
    if (!isPublic(pathname)) return false

    if (pathname === '/' || pathname === '/index.html') return sendIndex(reply)

    // `../../etc/passwd` 之类：解析后必须还在 dist 里
    const target = resolve(root, `.${pathname}`)
    if (target !== root && !target.startsWith(root + sep)) {
      await reply.code(400).send({ error: 'bad path' })
      return true
    }

    let info: Awaited<ReturnType<typeof stat>> | null = null
    try {
      info = await stat(target)
    } catch {
      info = null
    }

    if (info === null || !info.isFile()) {
      if (looksLikeFile(pathname)) {
        await reply.code(404).send({ error: 'not found' })
        return true
      }
      // 前端路由（`/apps/xxx`）：交给 index.html
      return sendIndex(reply)
    }

    if (pathname.endsWith('index.html')) return sendIndex(reply)

    await reply
      .code(200)
      .header('content-type', MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
      .header('cache-control', cacheControl(pathname))
      .header('content-length', String(info.size))
      .send(request.method === 'HEAD' ? undefined : createReadStream(target))
    return true
  }

  return { isPublicPath: isPublic, handle }
}

function isPublic(path: string): boolean {
  return !PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))
}
