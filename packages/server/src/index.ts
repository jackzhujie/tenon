/**
 * 启动编排：core → 总线 → agent → HTTP。
 *
 * 顺序不能换：agent 的事件必须能立刻进总线，而总线要先存在。
 * **Electron 只负责 spawn 这个入口并读 `TENON_READY` 那行**，业务一律在这里面。
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { openCore, type CoreServices } from '@tenon/core'
import { createAgentRuntime, type AgentRuntime } from '@tenon/agent'
import { buildServer, type TenonServer } from './app.js'
import { SseBus } from './sse.js'

export { buildServer, dispatch, type BuildServerOptions, type TenonServer } from './app.js'
export { SseBus } from './sse.js'
export { createHandlers, type HandlerMap, type ServerDeps } from './handlers.js'
export { requireBearer, extractToken } from './auth.js'

export interface StartServerOptions {
  env?: NodeJS.ProcessEnv
  host?: string
  /** 0 = 让系统分配（默认）。桌面版必须用 0，避免和别的实例打架 */
  port?: number
  token?: string
  version?: string
  logger?: boolean
  /** 测试用：库进内存，不碰真实 HOME */
  inMemoryDb?: boolean
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly app: FastifyInstance
  readonly server: TenonServer
  readonly core: CoreServices
  readonly agent: AgentRuntime
  close(): Promise<void>
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(24).toString('hex')

  const core = openCore({ env, ...(options.inMemoryDb === true ? { inMemoryDb: true } : {}) })
  const bus = new SseBus()
  const agent = createAgentRuntime({
    core,
    env,
    publish: (event) => {
      bus.publish(event)
    },
  })
  const server = buildServer({
    core,
    agent,
    bus,
    token,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  await server.app.listen({ host, port: options.port ?? 0 })
  const address = server.app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0)

  let closed = false
  return {
    url: `http://${host}:${port}`,
    port,
    token,
    app: server.app,
    server,
    core,
    agent,
    async close() {
      if (closed) return
      closed = true
      await server.app.close()
      await agent.close()
      core.close()
    },
  }
}
