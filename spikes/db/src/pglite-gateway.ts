/**
 * Spike 4 核心件：把 PGlite（WASM 版 PostgreSQL）暴露成标准 PG 线协议端口。
 *
 * 结构：net.Socket ──pg-gateway(fromNodeSocket)──> 单条串行队列 ──> PGlite.execProtocolRaw
 *
 * 关键结论（本文件就是 PRODUCT 里 packages/db-provisioner 的雏形）：
 *  PGlite 是**单会话**引擎，execProtocolRaw 不可重入。多条客户端连接必须共享
 *  一条全局串行队列，否则 protocol 状态会串。TypeORM 的 pool.max 只是"允许多少
 *  个 socket 同时存在"，真正的并发度仍由这条队列决定。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from 'pg-gateway/node'

export type GatewayStats = {
  /** 当前排队 + 执行中的消息数峰值 */
  peakQueueDepth: number
  /** 累计转发的 frontend 消息数 */
  messages: number
  /** PGlite 内部抛错次数（协议层错误由 PGlite 以 ErrorResponse 返回，不计入）*/
  faults: number
  socketsOpened: number
}

export type PgliteGateway = {
  port: number
  host: string
  dataDir: string
  stats: GatewayStats
  db: PGlite
  close(): Promise<void>
}

export type StartOptions = {
  /** PGlite 数据目录，'memory://' 表示纯内存 */
  dataDir?: string
  host?: string
  port?: number
}

export async function startPgliteGateway(opts: StartOptions = {}): Promise<PgliteGateway> {
  const dataDir = opts.dataDir ?? 'memory://'
  const host = opts.host ?? '127.0.0.1'
  const db = new PGlite(dataDir)
  await db.waitReady

  const stats: GatewayStats = { peakQueueDepth: 0, messages: 0, faults: 0, socketsOpened: 0 }

  // ---- 单条串行队列：PGlite 只有一个 backend ----
  let tail: Promise<unknown> = Promise.resolve()
  let depth = 0
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    depth += 1
    if (depth > stats.peakQueueDepth) stats.peakQueueDepth = depth
    const result = tail.then(fn)
    tail = result.then(
      () => {
        depth -= 1
      },
      () => {
        depth -= 1
      },
    )
    return result
  }

  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    stats.socketsOpened += 1
    socket.on('error', () => {
      // 客户端粗暴断开是常态（压测/热重启），不当作错误
    })
    socket.on('close', () => sockets.delete(socket))

    void fromNodeSocket(socket, {
      serverVersion: '18.0',
      auth: { method: 'trust' },
      onMessage: (data) =>
        enqueue(async () => {
          stats.messages += 1
          try {
            return await db.execProtocolRaw(data)
          } catch (err) {
            stats.faults += 1
            throw err
          }
        }),
    }).catch(() => {
      socket.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('gateway: 无法获取监听端口')

  return {
    port: address.port,
    host,
    dataDir,
    stats,
    db,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await tail.catch(() => {})
      await db.close()
    },
  }
}
