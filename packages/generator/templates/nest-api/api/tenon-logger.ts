/**
 * Nest 侧的统一异常出口：把 4xx/5xx 变成**面板上看得懂的一行日志**。
 *
 * 为什么需要它：默认情况下 Nest 只会把未捕获异常打到自己的 logger 里，
 * 格式五花八门（有时只有 `ERROR [ExceptionsHandler] xxx`，有时什么都不打）。
 * 网关虽然能捕获子进程的每一行输出，但"看不懂的行"和"看得懂的日志"是两回事。
 *
 * 输出去哪：`Logger` → `process.stderr` → 网关 `spawnLogged` 的 `onLine` → 日志面板的
 * `api` 来源。所以这个文件**不需要**任何 HTTP 上报通道，也不需要认识 Tenon 的任何东西。
 * 堆栈里缩进的 `at ...` 行会被网关并进同一条日志的 detail（面板里点开才看）。
 *
 * ★ 全局 `@Catch()` 过滤器接管**所有**异常的分发权：只记日志不写响应 = 请求永远挂着。
 *   所以最后必须 `reply.status(status).send(body)` 把等价于 Nest 默认行为的响应补回去。
 */
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'

interface RequestLike {
  method?: string
  url?: string
}

/** express 与 fastify 的 reply 在这一对方法上签名一致 */
interface ReplyLike {
  status(code: number): { send(body: unknown): void }
}

function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus()
  return HttpStatus.INTERNAL_SERVER_ERROR
}

function bodyOf(exception: unknown, status: number): unknown {
  if (exception instanceof HttpException) return exception.getResponse()
  // 兜底 500 不回显内部错误（可能含 SQL / 路径），详情只在日志里
  return { statusCode: status, message: 'Internal server error' }
}

function summarize(body: unknown, max = 200): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  if (text === undefined) return '（无响应体）'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

@Catch()
export class TenonLoggerFilter implements ExceptionFilter {
  private readonly logger = new Logger('tenon')

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<RequestLike>()
    const reply = http.getResponse<ReplyLike>()
    const method = request.method ?? '?'
    const url = request.url ?? '?'
    const status = statusOf(exception)
    const body = bodyOf(exception, status)

    try {
      if (status >= 500) {
        const error = exception instanceof Error ? exception : null
        const name = error === null ? typeof exception : error.name
        const message = error === null ? String(exception) : error.message
        this.logger.error(`5xx ${method} ${url} → ${name}: ${message}`, error?.stack)
      } else {
        // 4xx 是用户输入的问题，不是故障：一行就够，别把整页堆栈刷到面板里
        this.logger.warn(`4xx ${method} ${url} → ${status} ${summarize(body)}`)
      }
    } catch {
      // 记日志本身失败不能影响响应
    }

    reply.status(status).send(body)
  }
}
