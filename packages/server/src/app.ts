/**
 * Fastify 装配。这里只做「把 core/agent 挂到 HTTP 上」，不含业务判断 ——
 * 所有业务都在 core / agent 里，换传输层（Electron IPC、测试直调）时不用改这里。
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { CoreServices } from '@tenon/core'
import type { AgentRuntime } from '@tenon/agent'
import type { PreviewManager } from '@tenon/gateway'
import {
  TRANSPORT,
  TenonError,
  isRpcMethod,
  isTenonError,
  rpcFail,
  rpcMethods,
  rpcOk,
  sseFrame,
  type RpcMethod,
  type SseEvent,
} from '@tenon/protocol'
import { requireBearer } from './auth.js'
import { corsHeaderRecord, handleCors } from './cors.js'
import { createHandlers, type HandlerMap, type ServerDeps } from './handlers.js'
import { SseBus } from './sse.js'
import { createStaticServing, type StaticServing } from './static.js'

const HEARTBEAT_MS = 15_000

export interface BuildServerOptions {
  core: CoreServices
  agent: AgentRuntime
  /** 预览编排。由调用方创建：它也要往同一条总线发事件 */
  preview: PreviewManager
  /** 总线必须由调用方创建：agent 也要往同一条总线发事件 */
  bus: SseBus
  token: string
  version?: string
  logger?: boolean
  /**
   * 渲染器产物目录（`apps/web/dist`）。给了就由 server 同源发页面，
   * 并把 Token 注入 index.html —— Electron 壳与 Web 模式都走这条路。
   * 不给就是纯 API 服务（测试、将来纯前后端分离部署）。
   */
  web?: { dir: string }
}

export interface TenonServer {
  readonly app: FastifyInstance
  readonly bus: SseBus
  readonly deps: ServerDeps
  readonly handlers: HandlerMap
}

export function buildServer(options: BuildServerOptions): TenonServer {
  const bus = options.bus
  const deps: ServerDeps = {
    core: options.core,
    agent: options.agent,
    preview: options.preview,
    bus,
    version: options.version ?? '0.0.0',
  }
  const handlers = createHandlers(deps)

  const app = Fastify({
    logger: options.logger === true ? { level: 'info' } : false,
    // 预览/Gateway 之外只服务 JSON，限制一下体积没坏处
    bodyLimit: 8 * 1024 * 1024,
  })

  // ★ CORS 必须在鉴权之前：预检请求不带 Authorization，先鉴权会把预检打成 401
  app.addHook('onRequest', handleCors)
  // 页面与静态资源免 Token（它们本身就是公开的 JS/CSS）；接口一律要 Token
  const web = options.web === undefined ? null : createStaticServing({
    dir: options.web.dir,
    token: options.token,
  })
  app.addHook(
    'onRequest',
    requireBearer(options.token, {
      isPublic: (path) => web !== null && web.isPublicPath(path),
    }),
  )

  app.setErrorHandler((error, request, reply) => {
    if (isTenonError(error)) {
      void reply.code(error.httpStatus).send(rpcFail(error.toPayload()))
      return
    }
    if (error instanceof ZodError) {
      void reply.code(400).send(
        rpcFail({
          code: 'VALIDATION_FAILED',
          message: '参数不合法',
          details: { issues: error.issues },
        }),
      )
    } else {
      request.log.error(error)
      void reply.code(500).send(
        rpcFail({
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  })

  // ---------------------------------------------------------------- 健康检查

  app.get(TRANSPORT.healthPath, async () => {
    const data = await handlers.health({} as never)
    return rpcOk(data)
  })

  // ---------------------------------------------------------------- RPC

  app.post<{ Params: { method: string } }>(`${TRANSPORT.rpcPathPrefix}:method`, async (request, reply) => {
    const method = request.params.method
    if (!isRpcMethod(method)) {
      return reply.code(404).send(
        rpcFail({
          code: 'METHOD_NOT_FOUND',
          message: `未知方法：${method}`,
          details: { available: Object.keys(rpcMethods) },
        }),
      )
    }

    const schema = rpcMethods[method].input
    // 空 body 视为 `{}`：health / list 这类无参方法不该要求调用方造一个空对象
    const parsed = schema.parse(request.body ?? {})
    const handler = handlers[method] as (input: unknown) => Promise<unknown>
    const result = await handler(parsed)
    // 输出也过一遍 zod：契约漂移在服务端就暴露，而不是让前端收到意外形状
    const validated = rpcMethods[method].output.parse(result)
    return reply.send(rpcOk(validated))
  })

  // ---------------------------------------------------------------- SSE

  app.get<{ Querystring: { appId?: string; since?: string } }>(TRANSPORT.eventsPath, (request, reply) => {
    const appId = request.query.appId
    const sinceRaw = request.query.since
    const since = sinceRaw === undefined || sinceRaw === '' ? undefined : Number(sinceRaw)
    if (since !== undefined && Number.isNaN(since)) {
      throw new TenonError('VALIDATION_FAILED', 'since 必须是数字')
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 反代（M6 的自托管）常常缓冲 SSE，显式关掉
      'x-accel-buffering': 'no',
      // hijack 会跳过 Fastify 的响应流程，之前在 hook 里设的 header 全部失效 ——
      // 这里必须自己再写一遍，否则跨端口的 EventSource 直接被浏览器拦掉
      ...corsHeaderRecord(request.headers.origin),
    })
    raw.write(': connected\n\n')

    const shouldSend = (event: SseEvent): boolean => {
      if (event.type === 'stream.reset') return true
      if (appId === undefined) return true
      return event.appId === undefined || event.appId === appId
    }

    const { replay, unsubscribe } = bus.subscribe(since, (event) => {
      if (!shouldSend(event)) return
      raw.write(sseFrame(event, event.seq))
    })
    for (const event of replay) {
      if (shouldSend(event)) raw.write(sseFrame(event, event.seq))
    }

    const heartbeat = setInterval(() => {
      raw.write(': ping\n\n')
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    raw.on('close', cleanup)
    raw.on('error', cleanup)

    // 不再走 fastify 的 reply 生命周期，交给 raw socket
    return reply
  })

  // ---------------------------------------------------------------- 静态页面

  /*
   * 通配路由只接"没人认领"的 GET：`/rpc/:method` 是 POST、`/events` 是精确路由，
   * find-my-way 的优先级是 静态 > 参数 > 通配，所以这里不会把接口抢走。
   * 返回 false 的（受保护前缀、非 GET）落到下面的 404 处理器。
   */
  if (web !== null) {
    app.get('/*', async (request, reply) => {
      if (await web.handle(request, reply)) return reply
      // 走到这里说明是「受保护前缀但方法不对」之类，不是页面请求，别假装成 SPA
      return reply.code(404).type('text/plain; charset=utf-8').send('Not Found')
    })
  }

  // ---------------------------------------------------------------- 兜底

  app.get('/rpc', async (_request, reply) => {
    return reply.code(404).send(
      rpcFail({ code: 'METHOD_NOT_FOUND', message: 'RPC 请用 POST /rpc/<method>' }),
    )
  })

  return { app, bus, deps, handlers }
}

/**
 * 分发入口（测试直接调它，不必起 HTTP）。
 * 与 HTTP 路径共用同一套 zod 校验，避免"测试绿、线上红"。
 */
export async function dispatch(
  handlers: HandlerMap,
  method: RpcMethod,
  input: unknown,
): Promise<unknown> {
  const parsed = rpcMethods[method].input.parse(input)
  const handler = handlers[method] as (value: unknown) => Promise<unknown>
  const result = await handler(parsed)
  return rpcMethods[method].output.parse(result)
}
