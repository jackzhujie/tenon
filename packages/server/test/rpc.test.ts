import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src/index.js'

let dir: string
let running: RunningServer | undefined

async function boot(env: NodeJS.ProcessEnv = {}): Promise<RunningServer> {
  return startServer({
    port: 0,
    token: 'test-token',
    env: { TENON_HOME: dir, ...env },
  })
}

async function rpc<T>(
  server: RunningServer,
  method: string,
  input: unknown = {},
  token = 'test-token',
): Promise<{ status: number; body: { ok: boolean; data?: T; error?: { code: string; message: string } } }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  })
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-server-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('鉴权', () => {
  it('没有 Token 一律 401，且返回统一错误封装', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const denied = await rpc(running, 'app.list', {}, '')
    expect(denied.status).toBe(401)
    expect(denied.body.ok).toBe(false)
    expect(denied.body.error?.code).toBe('UNAUTHORIZED')
  })

  it('健康检查不需要 Token（supervisor / 探针要用）', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const response = await fetch(`${running.url}/api/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; data: { ok: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data.ok).toBe(true)
  })

  it('Token 不对同样是 401（不是 403，避免泄露"Token 存在"）', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const denied = await rpc(running, 'app.list', {}, 'wrong-token')
    expect(denied.status).toBe(401)
  })
})

describe('health', () => {
  it('没有模型时 model 为 null，但服务照常起来', async () => {
    running = await boot()
    const { status, body } = await rpc<{ model: unknown; tenonHome: string }>(running, 'health')
    expect(status).toBe(200)
    expect(body.data?.model).toBeNull()
    expect(body.data?.tenonHome).toBe(dir)
  })

  it('faux 模式下 model.mode 是 faux', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const { body } = await rpc<{ model: { mode: string; modelId: string } }>(running, 'health')
    expect(body.data?.model.mode).toBe('faux')
    expect(body.data?.model.modelId).toBe('faux-mini')
  })

  it('未知方法返回 METHOD_NOT_FOUND 而不是 500', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const { status, body } = await rpc(running, 'nope.nope')
    expect(status).toBe(404)
    expect(body.error?.code).toBe('METHOD_NOT_FOUND')
  })

  it('入参不合法返回 VALIDATION_FAILED', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const { status, body } = await rpc(running, 'app.get', { id: '' })
    expect(status).toBe(400)
    expect(body.error?.code).toBe('VALIDATION_FAILED')
  })
})

describe('应用注册表 RPC', () => {
  it('创建 → 列表 → 详情 → 删除', async () => {
    running = await boot({ TENON_FAUX: '1' })

    const created = await rpc<{ app: { id: string; slug: string } }>(running, 'app.create', {
      name: 'Todo 应用',
    })
    expect(created.status).toBe(200)
    const appId = created.body.data!.app.id

    const listed = await rpc<{ apps: Array<{ id: string }> }>(running, 'app.list')
    expect(listed.body.data?.apps.map((app) => app.id)).toContain(appId)

    const detail = await rpc<{ app: { name: string }; lastCommit: { sha: string } | null }>(
      running,
      'app.get',
      { id: appId },
    )
    expect(detail.body.data?.app.name).toBe('Todo 应用')
    // 建应用时就有一个初始化 commit
    expect(detail.body.data?.lastCommit?.sha).toBeTruthy()

    const deleted = await rpc(running, 'app.delete', { id: appId })
    expect(deleted.status).toBe(200)
    const after = await rpc<{ apps: unknown[] }>(running, 'app.list')
    expect(after.body.data?.apps).toHaveLength(0)
  })
})

describe('设置与提供商（BYOK）', () => {
  it('写入的 API Key 只以 hasApiKey 出现，绝不回显明文', async () => {
    running = await boot({ TENON_FAUX: '1' })
    const created = await rpc<{ profile: { id: string; hasApiKey: boolean } }>(
      running,
      'provider.upsert',
      {
        label: 'DeepSeek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-chat',
        apiKey: 'sk-super-secret-value',
      },
    )
    expect(created.body.data?.profile.hasApiKey).toBe(true)

    const listed = await rpc(running, 'provider.list')
    const serialized = JSON.stringify(listed.body)
    expect(serialized).not.toContain('sk-super-secret-value')
    expect(serialized).toContain('"hasApiKey":true')
  })

  it('settings 往返一致', async () => {
    running = await boot({ TENON_FAUX: '1' })
    await rpc(running, 'settings.set', { values: { 'ui.theme': 'dark' } })
    const read = await rpc<{ values: Record<string, unknown> }>(running, 'settings.get')
    expect(read.body.data?.values['ui.theme']).toBe('dark')
  })
})
