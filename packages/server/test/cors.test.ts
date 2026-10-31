/**
 * CORS：开发形态下页面在 5173、server 在随机端口，是两个 origin。
 *
 * 这组测试盯的是**两条不同的响应路径**：
 * 1. 普通 RPC —— 走 Fastify 的正常回复，头由 onRequest hook 设
 * 2. SSE —— 走 `reply.hijack()`，Fastify 的回复流程被跳过，头必须手工写进 `raw.writeHead`
 *
 * 第 2 条漏了的话，症状是「RPC 都好，只有对话不流」——因为它不是 500，是浏览器
 * 直接把 EventSource 挂掉，控制台只有一行 CORS 报错。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { boot, TEST_TOKEN } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-cors-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('CORS', () => {
  it('回环 origin 的预检不需要 Token，且回显来源', async () => {
    running = await boot(dir)
    const response = await fetch(`${running.url}/rpc/chat.submit`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('非回环 origin 拿不到放行头（恶意页面不能借用户浏览器打本地端口）', async () => {
    running = await boot(dir)
    const response = await fetch(`${running.url}/rpc/health`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('普通 RPC 响应带放行头', async () => {
    running = await boot(dir)
    const response = await fetch(`${running.url}/rpc/health`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  /**
   * ★ hijack 路径。Fastify 不会把我们 hook 里设的 header 应用到 raw socket 上，
   * 所以 SSE 路由里必须自己写一遍。这条用例就是那道闸门。
   */
  it('SSE（hijack 路径）也带放行头', async () => {
    running = await boot(dir)
    const controller = new AbortController()
    const response = await fetch(`${running.url}/events?token=${TEST_TOKEN}`, {
      headers: { origin: 'http://127.0.0.1:5173' },
      signal: controller.signal,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')

    controller.abort()
  })
})
