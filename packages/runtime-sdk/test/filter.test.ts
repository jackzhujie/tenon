/**
 * Nest 异常过滤器：既要让日志看得懂，也不能把响应弄丢。
 *
 * 最容易犯的错是"只记日志不写响应" —— 全局 `@Catch()` 接管了分发权，
 * 不补响应的话请求会一直挂着，前端只看到转圈。
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TenonLoggerFilter } from '../src/nest/tenon-logger'

interface Sent {
  status?: number
  body?: unknown
}

function hostFor(request: { method?: string; url?: string }): {
  host: ArgumentsHost
  sent: () => Sent
} {
  const sent: Sent = {}
  const reply = {
    status(code: number) {
      sent.status = code
      return {
        send(body: unknown) {
          sent.body = body
        },
      }
    },
  }
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost
  return { host, sent: () => sent }
}

describe('TenonLoggerFilter', () => {
  const filter = new TenonLoggerFilter()
  let errorLog: ReturnType<typeof vi.spyOn>
  let warnLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('4xx 记一行 warn，并把原响应补回去（状态码不变）', () => {
    const { host, sent } = hostFor({ method: 'POST', url: '/api/items' })
    filter.catch(new BadRequestException(['title should not be empty']), host)

    expect(sent().status).toBe(400)
    expect(warnLog).toHaveBeenCalledTimes(1)
    const line = String(warnLog.mock.calls[0]?.[0])
    expect(line).toContain('4xx POST /api/items → 400')
    expect(line).toContain('title should not be empty')
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('未捕获异常记 5xx + 堆栈，但**不把内部细节回给客户端**', () => {
    const boom = new TypeError('Cannot read properties of undefined')
    const { host, sent } = hostFor({ method: 'GET', url: '/api/items' })
    filter.catch(boom, host)

    expect(sent().status).toBe(500)
    expect(sent().body).toEqual({ statusCode: 500, message: 'Internal server error' })

    expect(errorLog).toHaveBeenCalledTimes(1)
    const [line, stack] = errorLog.mock.calls[0] ?? []
    expect(String(line)).toContain('5xx GET /api/items → TypeError: Cannot read properties of undefined')
    expect(String(stack)).toContain('Cannot read properties of undefined')
    expect(warnLog).not.toHaveBeenCalled()
  })

  it('HttpException 的 404 原样转发（不回落成 200 或 500）', () => {
    const { host, sent } = hostFor({ method: 'GET', url: '/api/nope' })
    filter.catch(new NotFoundException(), host)
    expect(sent().status).toBe(404)
    // Nest 的默认响应体是对象，不是字符串
    expect(JSON.stringify(sent().body)).toContain('Not Found')
  })

  it('超长响应体在日志里截断（否则一条校验错误能刷满面板）', () => {
    const { host } = hostFor({ method: 'POST', url: '/api/items' })
    const long = Array.from({ length: 200 }, (_, i) => `字段 ${i} 不合法`)
    filter.catch(new BadRequestException(long), host)

    const line = String(warnLog.mock.calls[0]?.[0])
    expect(line.length).toBeLessThan(400)
    expect(line.endsWith('…')).toBe(true)
  })

  it('日志调用本身炸了也不影响响应（观测通道不能反过来弄挂应用）', () => {
    errorLog.mockImplementation(() => {
      throw new Error('logger 坏了')
    })
    const { host, sent } = hostFor({ method: 'GET', url: '/api/x' })
    expect(() => {
      filter.catch(new Error('真错误'), host)
    }).not.toThrow()
    expect(sent().status).toBe(500)
  })
})
