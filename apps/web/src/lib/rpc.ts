/**
 * RPC 客户端。前端**只**通过这里访问 server（DESIGN §8.4：组件不直接 fetch）。
 *
 * 契约来自 `@tenon/protocol` 的方法表：`rpc('chat.submit', {...})` 的入参与返回值
 * 都是编译期推导的，服务端改了 schema 这里立刻红。
 */
import type { RpcInput, RpcMethod, RpcOutput } from '@tenon/protocol'
import { TRANSPORT } from '@tenon/protocol/browser'
import { authHeaders, endpointUrl, resolveEndpoint, type TenonEndpoint } from './transport.js'

/** 失败信封里的 `error`，原样保留 `code` 让调用方能分支处理（例如 409 冲突） */
export class TenonRpcError extends Error {
  readonly code: string
  readonly details: unknown
  readonly status: number

  constructor(code: string, message: string, status: number, details: unknown) {
    super(message)
    this.name = 'TenonRpcError'
    this.code = code
    this.status = status
    this.details = details
  }
}

interface FailureEnvelope {
  ok: false
  error: { code?: unknown; message?: unknown; details?: unknown }
}

function isFailure(value: unknown): value is FailureEnvelope {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

export interface RpcOptions {
  /** 覆盖端点（测试用）。默认每次调用现算，便于 Electron 后注入 */
  endpoint?: TenonEndpoint
  signal?: AbortSignal
}

export async function rpc<M extends RpcMethod>(
  method: M,
  input?: RpcInput<M>,
  options: RpcOptions = {},
): Promise<RpcOutput<M>> {
  const endpoint = options.endpoint ?? resolveEndpoint()
  const url = endpointUrl(endpoint, `${TRANSPORT.rpcPathPrefix}${method}`)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(endpoint) },
      body: JSON.stringify(input ?? {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (err) {
    // 网络层失败（server 没起、被防火墙拦）。给一句人能看懂的话，别把 TypeError 抛到界面上
    throw new TenonRpcError(
      'NETWORK',
      `连不上 Tenon 服务（${url.host}）${err instanceof Error ? `：${err.message}` : ''}`,
      0,
      undefined,
    )
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new TenonRpcError(
      'BAD_RESPONSE',
      `服务返回了非 JSON 响应（HTTP ${response.status}）`,
      response.status,
      text.slice(0, 400),
    )
  }

  if (isFailure(payload)) {
    const code = typeof payload.error.code === 'string' ? payload.error.code : 'INTERNAL'
    const message = typeof payload.error.message === 'string' ? payload.error.message : '请求失败'
    throw new TenonRpcError(code, message, response.status, payload.error.details)
  }

  if (!response.ok) {
    throw new TenonRpcError('HTTP_ERROR', `请求失败（HTTP ${response.status}）`, response.status, payload)
  }

  return (payload as { data: RpcOutput<M> }).data
}
