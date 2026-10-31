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
import { PreviewManager, type PreviewManagerOptions } from '@tenon/gateway'
import { scaffoldApp } from '@tenon/generator'
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
  /**
   * 预览的可注入项。测试给一个 `launch`（stub 上游）+ `installDeps: false`
   * 就能把编排逻辑验完，不需要真的装 React。
   */
  preview?: Pick<PreviewManagerOptions, 'launch' | 'installDeps' | 'readyTimeoutMs' | 'log'>
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly app: FastifyInstance
  readonly server: TenonServer
  readonly core: CoreServices
  readonly agent: AgentRuntime
  readonly preview: PreviewManager
  close(): Promise<void>
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(24).toString('hex')

  // 建应用时铺模板：钩子由 server 注入，core 不认识 @tenon/generator（依赖方向见 DESIGN §3.2）
  const core = openCore({
    env,
    ...(options.inMemoryDb === true ? { inMemoryDb: true } : {}),
    scaffold: async (ctx) => {
      await scaffoldApp({
        repoDir: ctx.repoDir,
        appId: ctx.appId,
        appName: ctx.appName,
        appSlug: ctx.appSlug,
        templateId: ctx.templateId,
        env,
      })
    },
  })
  const bus = new SseBus()
  const agent = createAgentRuntime({
    core,
    env,
    publish: (event) => {
      bus.publish(event)
    },
  })
  const preview = new PreviewManager({
    home: core.home,
    env,
    publish: (event) => {
      bus.publish(event)
    },
    ...(options.preview ?? {}),
  })
  const server = buildServer({
    core,
    agent,
    preview,
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
    preview,
    async close() {
      if (closed) return
      closed = true
      await server.app.close()
      // 先停预览：dev server 是我们 spawn 的，进程别留在外面
      await preview.close()
      await agent.close()
      core.close()
    },
  }
}
