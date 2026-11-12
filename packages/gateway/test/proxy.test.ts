/**
 * 网关的测试全部对着 **stub 上游** 做：这里要验的是「转发是否原样」，
 * 不是 Vite 能不能跑。所以一条都不需要装 React，跑完不到一秒。
 *
 * 最容易坏的是 upgrade 那条：Vite 的 HMR 握手带 `Sec-WebSocket-Protocol: vite-hmr`，
 * 代理库通常会把它改写或丢掉，表现是 iframe 里页面能开、但改动不热更新。
 */
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startGateway, LOG_PATH, type Gateway } from '../src/proxy.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  // LIFO：后建的先拆。反过来会卡在"关上游时还有一条 101 长连接"上（真实发生过）
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

/** 只回答一个固定字符串的 HTTP 上游 */
async function stubHttp(body: string): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
  })
  const port = await listen(server)
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { port, seen }
}

/** 收到 upgrade 就回 101 + 一行标记，并记下握手 header 里的 HMR 协议名 */
async function stubUpgrade(): Promise<{ port: number; protocols: string[] }> {
  const protocols: string[] = []
  const server = createServer()
  // upgrade 之后的 socket 是 Duplex（不是 net.Socket）
  const live = new Set<import('node:stream').Duplex>()
  server.on('upgrade', (req, socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
    const raw = req.rawHeaders
    for (let i = 0; i < raw.length; i += 2) {
      if ((raw[i] ?? '').toLowerCase() === 'sec-websocket-protocol') protocols.push(raw[i + 1] ?? '')
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
        'Sec-WebSocket-Protocol: vite-hmr',
        '',
        '',
      ].join('\r\n'),
    )
    socket.write('hello-from-upstream\n')
  })
  const port = await listen(server)
  cleanups.push(async () => {
    // 101 之后换成裸 socket，server.close() 不管这些连接，得自己掐
    for (const socket of live) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { port, protocols }
}

function gatewayOf(routes: { prefix: string; port: number }[]): Promise<Gateway> {
  return startGateway({ routes })
}

/** 手工发一次 WS 握手，收满数据后断开 */
function upgradeHandshake(
  port: number,
  path: string,
  extra: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
      ]
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`握手超时，收到：${buffer}`))
    }, 5000)
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('hello-from-upstream') || buffer.includes('502')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(buffer)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe('App Gateway', () => {
  it('HTTP 原样转发到上游', async () => {
    const upstream = await stubHttp('来自上游的正文')
    const gateway = await gatewayOf([{ prefix: '/', port: upstream.port }])
    cleanups.push(() => gateway.close())

    const response = await fetch(`${gateway.url}/some/path?x=1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('来自上游的正文')
    expect(upstream.seen).toEqual(['GET /some/path?x=1'])
    expect(gateway.stats.http).toBe(1)
  })

  it('最长前缀优先：/api 不会被兜底的 / 抢走', async () => {
    const front = await stubHttp('前端')
    const api = await stubHttp('后端')
    const gateway = await gatewayOf([
      { prefix: '/', port: front.port },
      { prefix: '/api', port: api.port },
    ])
    cleanups.push(() => gateway.close())

    expect(await (await fetch(`${gateway.url}/`)).text()).toBe('前端')
    expect(await (await fetch(`${gateway.url}/api/users`)).text()).toBe('后端')
    expect(front.seen).toEqual(['GET /'])
    expect(api.seen).toEqual(['GET /api/users'])
  })

  it('上游没起来时返回 502，而不是把 iframe 挂在 pending 上', async () => {
    // 拿一个刚关掉的端口：不监听，连上去必然失败
    const dead = await stubHttp('x')
    const deadServer = createServer()
    const deadPort = await listen(deadServer)
    await new Promise<void>((resolve) => deadServer.close(() => resolve()))

    const gateway = await gatewayOf([{ prefix: '/', port: deadPort }])
    cleanups.push(() => gateway.close())

    const response = await fetch(`${gateway.url}/`)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('upstream did not respond')
    expect(gateway.stats.upstreamErrors).toBe(1)
    expect(dead.port).not.toBe(deadPort)
  })

  it('HMR 握手原样透传：Sec-WebSocket-Protocol 必须活着到上游', async () => {
    const upstream = await stubUpgrade()
    const gateway = await gatewayOf([{ prefix: '/', port: upstream.port }])
    cleanups.push(() => gateway.close())

    const raw = await upgradeHandshake(gateway.port, '/', {
      'Sec-WebSocket-Protocol': 'vite-hmr',
    })
    expect(raw).toContain('101 Switching Protocols')
    expect(raw).toContain('hello-from-upstream')
    expect(upstream.protocols).toEqual(['vite-hmr'])
    expect(gateway.stats.upgrade).toBe(1)
    expect(gateway.stats.upgradeFailed).toBe(0)
  })

  it('上游换了端口只改指向，网关自己不动（iframe 地址不变）', async () => {
    const first = await stubHttp('第一代')
    const second = await stubHttp('第二代')
    const gateway = await gatewayOf([{ prefix: '/', port: first.port }])
    cleanups.push(() => gateway.close())

    const url = gateway.url
    expect(await (await fetch(url)).text()).toBe('第一代')

    gateway.updateRoute('/', second.port)
    expect(gateway.url).toBe(url)
    expect(await (await fetch(url)).text()).toBe('第二代')
  })

  it('没有路由就直接报错（兜底路由是必须的）', async () => {
    await expect(startGateway({ routes: [] })).rejects.toThrow(/at least one route is required/)
  })

  /*
   * 日志上报端点。三个断言各对应一个容易做错的地方：
   * 转发给上游（会 404，用户只看到"日志没上来"）、解析不出体（静默丢日志）、
   * 吞掉超大请求体（内存被一个坏 SDK 打满）。
   */
  it('日志上报被网关自己吃掉：204、不转发上游、体交给回调', async () => {
    const upstream = await stubHttp('前端')
    const received: unknown[] = []
    const gateway = await startGateway({
      routes: [{ prefix: '/', port: upstream.port }],
      onClientLog: (payload) => received.push(payload),
    })
    cleanups.push(() => gateway.close())

    const response = await fetch(`${gateway.url}${LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'boom', source: 'web' }),
    })
    expect(response.status).toBe(204)
    expect(received).toEqual([{ message: 'boom', source: 'web' }])
    // ★ 关键：上游一次都没被打到。打到 Vite 上就是 404，日志从此消失
    expect(upstream.seen).toEqual([])
  })

  it('同一条路径的 GET 不当事：那是页面请求，照常转发', async () => {
    const upstream = await stubHttp('前端')
    const received: unknown[] = []
    const gateway = await startGateway({
      routes: [{ prefix: '/', port: upstream.port }],
      onClientLog: (payload) => received.push(payload),
    })
    cleanups.push(() => gateway.close())

    expect(await (await fetch(`${gateway.url}${LOG_PATH}`)).text()).toBe('前端')
    expect(received).toEqual([])
  })

  it('体不是 JSON 时静默丢弃，但仍然回 204（上报通道不能反过来把应用弄挂）', async () => {
    const upstream = await stubHttp('前端')
    const received: unknown[] = []
    const gateway = await startGateway({
      routes: [{ prefix: '/', port: upstream.port }],
      onClientLog: (payload) => received.push(payload),
    })
    cleanups.push(() => gateway.close())

    const response = await fetch(`${gateway.url}${LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{不是 JSON',
    })
    expect(response.status).toBe(204)
    expect(received).toEqual([])
  })

  it('超大体积直接 413，不把内存交出去', async () => {
    const upstream = await stubHttp('前端')
    const gateway = await startGateway({
      routes: [{ prefix: '/', port: upstream.port }],
      onClientLog: () => undefined,
    })
    cleanups.push(() => gateway.close())

    const response = await fetch(`${gateway.url}${LOG_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(20_000),
    }).catch(() => null)
    // 服务端可能在读完之前就断开连接，两种结果都算合格
    if (response !== null) expect(response.status).toBe(413)
    expect(upstream.seen).toEqual([])
  })
})
