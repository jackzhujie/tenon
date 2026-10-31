/**
 * App Gateway：iframe / 浏览器访问生成应用的唯一入口（DESIGN §9.1）。
 *
 *   /            → Vite dev server
 *   /api/*       → NestJS
 *   upgrade 任意路径 → 原样 TCP 透传给 Vite（vite-hmr 的 WebSocket 就走这条）
 *
 * 为什么不用 http-proxy：Vite 的 WS 握手带 Sec-WebSocket-Protocol 与自定义 query，
 * 用 raw socket 透传最不容易踩header 改写/压缩协商的坑。
 */
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

export type Route = { prefix: string; port: number; host?: string }
export type Gateway = {
  port: number
  url: string
  stats: { http: number; upgrade: number; upgradeFailed: number }
  /** 上游重启换了端口时只改指向，iframe 的 URL 不需要变 */
  updateRoute(prefix: string, port: number): void
  close(): Promise<void>
}

export async function startGateway(opts: { routes: Route[]; port?: number }): Promise<Gateway> {
  const host = '127.0.0.1'
  const stats = { http: 0, upgrade: 0, upgradeFailed: 0 }
  const sockets = new Set<Socket>()

  function routeFor(url: string): Route {
    const path = url.split('?')[0] ?? '/'
    let best: Route | undefined
    for (const r of opts.routes) {
      if (path === r.prefix || path.startsWith(r.prefix.endsWith('/') ? r.prefix : `${r.prefix}/`)) {
        if (best === undefined || r.prefix.length > best.prefix.length) best = r
      }
    }
    return best ?? opts.routes[opts.routes.length - 1]!
  }

  const server = createServer((req, res) => {
    stats.http += 1
    const target = routeFor(req.url ?? '/')
    const headers = { ...req.headers, host: `${target.host ?? host}:${target.port}` }
    const upstream = httpRequest(
      { host: target.host ?? host, port: target.port, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('gateway: upstream unreachable')
    })
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket: Socket, head) => {
    stats.upgrade += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const target = routeFor(req.url ?? '/')
    const upstream = connect(target.port, target.host ?? host, () => {
      // 原样重放握手请求行与 header（保留 Sec-WebSocket-Protocol: vite-hmr）
      const raw = req.rawHeaders
      let handshake = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`
      for (let i = 0; i < raw.length; i += 2) handshake += `${raw[i]}: ${raw[i + 1]}\r\n`
      upstream.write(`${handshake}\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => {
      stats.upgradeFailed += 1
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('gateway: 端口异常')

  return {
    port: address.port,
    url: `http://${host}:${address.port}`,
    stats,
    updateRoute(prefix, port) {
      const route = opts.routes.find((r) => r.prefix === prefix)
      if (route === undefined) throw new Error(`gateway: 没有 ${prefix} 路由`)
      route.port = port
    },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
