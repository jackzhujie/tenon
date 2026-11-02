/**
 * Spike 6（M5 第 3 步 b 的卡点）：chord 的 `WebSocketLink` 接到真实 `ws` 上。
 *
 * 背景：`memoryLinkPair`（Spike 5 用的那条）一切正常，但换成真 WebSocket 之后，
 * 握手成功、`ctx.get` 能拿到引用，随后报
 * `invalid/protocol: link to peer: ack 2 outside 0..2`，调用再也不返回。
 *
 * 这个 spike 只做一件事：在一台机器上把两端都跑起来，逐项试**可能是原因**的开关，
 * 每一项都打印实测结果，不猜。
 *
 * 试的四项（各自独立，可以用环境变量单独开）：
 * - `LINK_COMPRESS=1`：服务端发压缩帧（默认 false）
 * - `LINK_BINARY=arraybuffer`：收发二进制前把 socket 的 binaryType 定死
 * - `LINK_ACCEPT_PACKED=0`：两端都不接受打包帧
 * - `LINK_ORDER=client-first`：先建客户端 host，再让服务端 accept（时序）
 */
import { Type } from 'typebox'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createHost, webSocketLink, type Host } from '@earendil-works/chord'
import { OWNER, Probe, type Principal } from './contract.js'

const principalKey = (p: Principal): string => (p.kind === 'owner' ? 'owner' : `guest:${p.id}`)

function linkOptions(): { compress?: boolean; acceptPacked?: boolean } {
  const options: { compress?: boolean; acceptPacked?: boolean } = {}
  if (process.env['LINK_COMPRESS'] === '1') options.compress = true
  if (process.env['LINK_ACCEPT_PACKED'] === '0') options.acceptPacked = false
  return options
}

async function main(): Promise<void> {
  console.log('选项：', JSON.stringify(linkOptions()), 'order=', process.env['LINK_ORDER'] ?? 'server-first')

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port

  const server: Host<Principal> = createHost<Principal>({
    name: 'probe',
    self: OWNER,
    principalKey,
    dev: true,
    onError: (error) => console.log('SERVER HOST ERR:', error instanceof Error ? error.message : error),
  })
  server.serve(
    Probe,
    (_input, _principal, self) => {
      const hits = self.state('hits', Type.Number(), 0)
      return {
        variant: 'default',
        hits,
        hit: async (ctx) => {
          hits.change(ctx, (n) => n + 1)
        },
        stamp: async () => ({ value: 'v1' }),
      }
    },
    { linger: 60_000 },
  )

  let clientHost: Host<Principal> | null = null

  /**
   * `LINK_VIA_GATEWAY=1`：把这条 WS 放进网关后面 —— 生产里就是这条路
   * （页面在网关的源上，upgrade 由网关的 `server.on('upgrade')` 转给 bridge）。
   *
   * 直连能通、过网关不通的话，问题就在"网关把 socket 转手"的那一步，
   * 最可疑的是握手同一包里带过来的 `head`（重复投递 = 对方看到重复帧 = ack 越界）。
   */
  let portForClient = port
  let headLength = -1
  if (process.env['LINK_VIA_GATEWAY'] === '1') {
    const { createServer } = await import('node:http')
    const { startGateway } = await import('@tenon/gateway')
    const stub = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>stub</body></html>')
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()))
    const stubPort = (stub.address() as AddressInfo).port
    const gateway = await startGateway({
      routes: [{ prefix: '/', port: stubPort }],
      components: {
        scriptUrl: '/x.js',
        script: async () => null,
        upgrade: async (req, socket, head) => {
          headLength = head.length
          return await new Promise<boolean>((resolve) => {
            wss.handleUpgrade(req, socket, head, (ws) => {
              server.accept(webSocketLink(ws, linkOptions()), { principal: OWNER })
              resolve(true)
            })
          })
        },
        close: async () => {
          await new Promise<void>((resolve) => stub.close(() => resolve()))
        },
      },
    })
    portForClient = gateway.port
    console.log('经网关：', gateway.url, 'stub=', stubPort)
  } else {
    wss.on('connection', (socket) => {
      const accept = (): void => {
        server.accept(webSocketLink(socket, linkOptions()), { principal: OWNER })
      }
      if (process.env['LINK_ORDER'] === 'client-first') {
        // 让客户端先握手（等它发出第一帧再 accept）
        setTimeout(accept, 50)
        return
      }
      accept()
    })
  }

  const path = process.env['LINK_VIA_GATEWAY'] === '1' ? '/__tenon/component' : '/'
  const socket = new WebSocket(`ws://127.0.0.1:${portForClient}${path}`)
  const binaryType = process.env['LINK_BINARY']
  if (binaryType !== undefined) socket.binaryType = binaryType as typeof socket.binaryType

  clientHost = createHost<Principal>({
    name: 'ui',
    self: OWNER,
    principalKey,
    kind: 'client',
    readyTimeout: 5_000,
    upstream: { link: webSocketLink(socket, linkOptions()), principal: OWNER },
    onError: (error) => console.log('CLIENT HOST ERR:', error instanceof Error ? error.message : error),
  })

  const started = Date.now()
  try {
    const hits = await Promise.race([
      clientHost.root(async (ctx) => {
        const probe = await ctx.get(Probe, { id: 'x' })
        if (probe.variant !== 'default') return -1
        await probe.hit(ctx)
        await probe.hit(ctx)
        return probe.hits.value
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 5_000)),
    ])
    console.log(`结果：hits=${String(hits)}（${Date.now() - started}ms） head=${headLength}`)
  } catch (error) {
    console.log('调用抛错：', error instanceof Error ? error.message : error)
  }

  await clientHost.close()
  await server.close()
  wss.close()
}

void main()
