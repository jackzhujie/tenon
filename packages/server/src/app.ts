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
import { createHandlers, type HandlerMap, type ServerDeps } from './handlers.js'
import { SseBus } from './sse.js'

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

  app.addHook('onRequest', requireBearer(options.token))

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

  app.get('/api/health', async () => {
    const data = await handlers.health({} as never)
    return rpcOk(data)
  })

  // ---------------------------------------------------------------- RPC

  app.post<{ Params: { method: string } }>('/rpc/:method', async (request, reply) => {
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

  app.get<{ Querystring: { appId?: string; since?: string } }>('/events', (request, reply) => {
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
