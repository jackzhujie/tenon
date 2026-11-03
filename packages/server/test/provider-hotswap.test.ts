/**
 * 设置页的后端契约：**保存之后模型真的换了**（M5.5）。
 *
 * 之前模型只在 `createAgentRuntime` 那一刻解析一次 —— 用户在设置里填完 key，
 * 得重启服务才生效。这类"填完没反应"的挫败感最容易让人以为产品坏了。
 *
 * 这里用真 HTTP 起一个假的 OpenAI 端点（只为 `provider.test` 用），
 * 验四件事：
 *   1. 没配时 health.model 是 null，配完立刻变成 openai-compatible（不重启）
 *   2. 第一个 provider 自动选中（用户不需要再点"启用"）
 *   3. provider.test 把提供商的原话交回来（401 就是 401，不改写成"连接失败"）
 *   4. 删掉当前 provider → 立刻回到 null，而不是下次启动才炸
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, rpc } from './support.js'
import type { RunningServer } from '../src/index.js'

interface ModelState {
  model: { mode: string; providerId: string; modelId: string } | null
  error: string | null
  changed: boolean
}

let dir: string | undefined
let running: RunningServer | undefined
let fake: Server | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  if (fake !== undefined) {
    await new Promise<void>((resolve) => fake?.close(() => resolve()))
    fake = undefined
  }
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** 一个只会说"ok"的 OpenAI 兼容端点：够 `provider.test` 用 */
async function startFakeProvider(): Promise<{ url: string; setReject(value: boolean): void }> {
  const state = { rejects: false }
  fake = createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').includes('/chat/completions')) {
      if (state.rejects) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'x',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', () => resolve()))
  const port = (fake.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    setReject(value: boolean) {
      state.rejects = value
    },
  }
}

describe('模型热切换（设置页后端）', () => {
  it('配完立刻生效：health 从 null 变成 openai-compatible，不需要重启', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-hotswap-'))
    // 不带 faux：模拟"用户还没配任何模型"的真实初始状态
    running = await boot(dir, { env: { TENON_FAUX: '' } })

    const before = await rpc<{ model: unknown }>(running, 'health')
    expect(before.model).toBeNull()

    const provider = await startFakeProvider()
    const saved = await rpc<{ profile: { id: string }; applied: ModelState }>(running, 'provider.upsert', {
      label: '测试端点',
      kind: 'openai-compatible',
      baseUrl: provider.url,
      modelId: 'test-model',
      apiKey: 'sk-test',
    })

    // 第一个 provider 自动选中，并且当场换上了
    expect(saved.applied).toMatchObject({ error: null, changed: true })
    expect(saved.applied.model).toMatchObject({ mode: 'openai-compatible', modelId: 'test-model' })

    const after = await rpc<{ model: { mode: string; modelId: string } | null }>(running, 'health')
    expect(after.model).toMatchObject({ mode: 'openai-compatible', modelId: 'test-model' })

    /*
     * 顺带钉住"自动选中"：不写这个设置的话，模型会被 `planModel` 的兜底捡起来用，
     * 而界面上的「当前」标记永远是空的 —— 能用、但看起来没配好，比不能用还让人困惑。
     */
    const settings = await rpc<{ values: Record<string, unknown> }>(running, 'settings.get')
    expect(settings.values['agent.activeProviderId']).toBe(saved.profile.id)
  })

  it('provider.test 把提供商的原话交回来（401 不会被改写成"连接失败"）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-hotswap-test-'))
    running = await boot(dir, { env: { TENON_FAUX: '' } })
    const provider = await startFakeProvider()

    const saved = await rpc<{ profile: { id: string } }>(running, 'provider.upsert', {
      label: '测试端点',
      kind: 'openai-compatible',
      baseUrl: provider.url,
      modelId: 'test-model',
      apiKey: 'sk-test',
    })

    const good = await rpc<{ ok: boolean; message: string; latencyMs: number }>(running, 'provider.test', {
      id: saved.profile.id,
    })
    expect(good.ok).toBe(true)
    expect(good.latencyMs).toBeGreaterThanOrEqual(0)

    // 让假端点开始拒绝：错误原文里必须有 "Invalid API key"
    provider.setReject(true)
    const bad = await rpc<{ ok: boolean; message: string }>(running, 'provider.test', {
      id: saved.profile.id,
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('401')
    expect(bad.message).toContain('Invalid API key')
  })

  it('删掉当前 provider：立刻回到没有模型，而不是等下次启动才炸', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-hotswap-del-'))
    running = await boot(dir, { env: { TENON_FAUX: '' } })
    const provider = await startFakeProvider()

    const saved = await rpc<{ profile: { id: string }; applied: ModelState }>(running, 'provider.upsert', {
      label: '测试端点',
      kind: 'openai-compatible',
      baseUrl: provider.url,
      modelId: 'test-model',
      apiKey: 'sk-test',
    })
    expect(saved.applied.model).not.toBeNull()

    const removed = await rpc<{ applied: ModelState }>(running, 'provider.delete', {
      id: saved.profile.id,
    })
    expect(removed.applied.model).toBeNull()
    expect(removed.applied.error).not.toBeNull()

    const health = await rpc<{ model: unknown }>(running, 'health')
    expect(health.model).toBeNull()
  })

  it('设置没变时不做无谓的重建（changed=false）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-hotswap-same-'))
    running = await boot(dir, { env: { TENON_FAUX: '' } })
    const provider = await startFakeProvider()

    const first = await rpc<{ profile: { id: string }; applied: ModelState }>(running, 'provider.upsert', {
      label: '测试端点',
      kind: 'openai-compatible',
      baseUrl: provider.url,
      modelId: 'test-model',
      apiKey: 'sk-test',
    })
    expect(first.applied.changed).toBe(true)

    // 再存一次同样的配置：不该拆掉正在用的会话
    const again = await rpc<{ applied: ModelState }>(running, 'provider.upsert', {
      id: first.profile.id,
      label: '测试端点',
      kind: 'openai-compatible',
      baseUrl: provider.url,
      modelId: 'test-model',
      apiKey: null,
    })
    expect(again.applied.changed).toBe(false)
  })
})
