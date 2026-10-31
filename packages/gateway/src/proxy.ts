/**
 * App Gateway（DESIGN §9.1）：iframe 访问生成应用的唯一入口。
 *
 *   /            → Vite dev server
 *   /api/*       → NestJS（M2）
 *   upgrade 任意  → 原样 TCP 透传给上游（vite-hmr 的 WebSocket 走这条）
 *
 * 为什么不用 http-proxy：Vite 的 WS 握手带 `Sec-WebSocket-Protocol: vite-hmr`，
 * 代理库会按自己的理解重写 header / 协商压缩，踩过一次就很难查。原样重放 `rawHeaders`
 * 是最笨也最稳的做法（SPIKES §3：改动 → HMR update 经网关 134ms）。
 *
 * 这里只有转发，没有业务：谁跑在上游（Vite / Nest / 静态服务）它不关心，
 * 所以测试可以用一个 20 行的 stub 上游把它验完，不需要装 React。
 */
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { Server, Socket } from 'node:net'

export interface Route {
  /** 路径前缀，`/` 表示兜底 */
  prefix: string
  port: number
  host?: string
}

export interface GatewayStats {
  http: number
  upgrade: number
  upgradeFailed: number
  upstreamErrors: number
}

export interface Gateway {
  readonly port: number
  readonly url: string
  readonly stats: GatewayStats
  /** 上游重启换了端口时只改指向，iframe 的地址不用变 */
  updateRoute(prefix: string, port: number): void
  close(): Promise<void>
}

export interface GatewayOptions {
  /** 兜底路由（`/`）必须给：至少一条 */
  routes: Route[]
  port?: number
  host?: string
}

const LOOPBACK = '127.0.0.1'

function matches(path: string, prefix: string): boolean {
  if (prefix === '/') return true
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const routes = options.routes
  if (routes.length === 0) throw new Error('gateway: 至少要有一条路由')
  const host = options.host ?? LOOPBACK
  const stats: GatewayStats = { http: 0, upgrade: 0, upgradeFailed: 0, upstreamErrors: 0 }
  const sockets = new Set<Socket>()

  // 最长前缀优先：`/api/x` 命中 `/api` 而不是兜底的 `/`
  function routeFor(url: string): Route {
    const path = (url.split('?')[0] ?? '/') || '/'
    let best: Route | undefined
    for (const route of routes) {
      if (!matches(path, route.prefix)) continue
      if (best === undefined || route.prefix.length > best.prefix.length) best = route
    }
    return best ?? routes[routes.length - 1]!
  }

  const server: Server = createServer((req, res) => {
    stats.http += 1
    const target = routeFor(req.url ?? '/')
    const upstream = httpRequest(
      {
        host: target.host ?? host,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${target.host ?? host}:${target.port}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      stats.upstreamErrors += 1
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('网关：上游没响应（dev server 可能还在启动或已经退出）')
    })
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    stats.upgrade += 1
    sockets.add(socket)

    const target = routeFor(req.url ?? '/')
    const upstream = connect(target.port, target.host ?? host, () => {
      const raw = req.rawHeaders
      let handshake = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`
      for (let i = 0; i < raw.length; i += 2) handshake += `${raw[i]}: ${raw[i + 1]}\r\n`
      upstream.write(`${handshake}\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })

    /**
     * ★ 两条连接是**配对**的：任何一侧断开，另一侧必须跟着断。
     *
     * 漏掉这两句不会报错，只会漏水：Vite 每次整页刷新都重连一次 HMR，
     * 上游 socket 一个都不回收，几百次之后 dev server 就撞在 FD 上限上开始莫名其妙地拒绝连接。
     * 这个坑只有在测试里真的去关一遍 stub 上游才会暴露（`server.close()` 永远等不到回调）。
     */
    socket.on('close', () => {
      sockets.delete(socket)
      upstream.destroy()
    })
    upstream.on('close', () => socket.destroy())

    upstream.on('error', () => {
      stats.upgradeFailed += 1
      socket.destroy()
    })
    // 客户端断开是常态，别让它冒泡成 uncaught；顺手把上游也收掉
    socket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('gateway: 拿不到监听端口')
  }

  let closed = false
  return {
    port: address.port,
    url: `http://${host}:${address.port}`,
    stats,
    updateRoute(prefix, port) {
      const route = routes.find((r) => r.prefix === prefix)
      if (route === undefined) throw new Error(`gateway: 没有前缀为 ${prefix} 的路由`)
      route.port = port
    },
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
