/**
 * 预览链路的服务端集成测试：**建应用 → 模板已铺好 → 起预览 → iframe 能打开 → 停**。
 *
 * 这是 DoD「生成一个纯前端应用，iframe 里热更新生效」里除了"真的装依赖"之外的全部环节。
 * 依赖安装与真实 Vite 由 `scripts/e2e-preview.ts` 覆盖（那条要联网、要几十秒，不该进 CI）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { App, PreviewStatus, SseEvent, TemplateInfo } from '@tenon/protocol'
import type { RunningServer } from '../src/index.js'
import { boot, openSse, rpc } from './support.js'

let dir: string
let running: RunningServer | undefined
let upstreams: Server[] = []

/** 挂在上游端口上的 stub dev server（不需要 node_modules） */
const stubLaunch = async (spec: { vitePort: number }): Promise<{
  pid: undefined
  output: () => string
  onExit: () => void
  stop: () => Promise<void>
}> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>stub</title><h1>这是 stub 版首屏</h1>')
  })
  await new Promise<void>((resolve) => server.listen(spec.vitePort, '127.0.0.1', () => resolve()))
  upstreams.push(server)
  return {
    pid: undefined,
    output: () => 'stub upstream',
    onExit: () => undefined,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-preview-rpc-'))
  upstreams = []
})

afterEach(async () => {
  await running?.close()
  running = undefined
  for (const server of upstreams) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await rm(dir, { recursive: true, force: true })
})

async function createApp(name: string): Promise<App> {
  const server = running as RunningServer
  const { app } = await rpc<{ app: App }>(server, 'app.create', { name })
  return app
}

describe('模板与预览', () => {
  it('template.list 能列出模板与它们的变量', async () => {
    running = await boot(dir)
    const { templates } = await rpc<{ templates: TemplateInfo[] }>(running, 'template.list')
    const ids = templates.map((template) => template.id)
    expect(ids).toContain('react-vite')
    const react = templates.find((template) => template.id === 'react-vite')
    expect(react?.entry).toBe('index.html')
    expect(react?.variables).toEqual(expect.arrayContaining(['appName', 'appSlug']))
  })

  it('app.create 默认就把 react-vite 铺好，并且是同一个 commit', async () => {
    running = await boot(dir)
    const app = await createApp('待办清单')

    expect(app.templateId).toBe('react-vite')

    const pkg = await rpc<{ content: string }>(running, 'files.read', {
      appId: app.id,
      path: 'package.json',
    })
    const parsed = JSON.parse(pkg.content) as { name: string; dependencies: Record<string, string> }
    expect(parsed.name).toBe(app.slug)
    expect(parsed.dependencies['react']).toBeDefined()
    expect(pkg.content).not.toContain('{{')

    const { nodes } = await rpc<{ nodes: Array<{ path: string }> }>(running, 'files.tree', {
      appId: app.id,
      depth: 3,
    })
    const paths = nodes.map((node) => node.path)
    expect(paths).toContain('index.html')
    expect(paths).toContain('vite.config.ts')

    // 建应用只应产生一个 commit：模板和 .gitignore 在同一次提交里
    const { commits } = await rpc<{ commits: Array<{ message: string }> }>(running, 'git.log', {
      appId: app.id,
    })
    expect(commits).toHaveLength(1)
  })

  it('未知模板会被拒绝，且不会留下半个应用', async () => {
    running = await boot(dir)
    await expect(
      rpc(running, 'app.create', { name: '幽灵', templateId: 'ghost' }),
    ).rejects.toThrow(/ghost/)
    const { apps } = await rpc<{ apps: App[] }>(running, 'app.list')
    expect(apps).toHaveLength(0)
  })

  it('起预览 → preview.ready 事件带 url → 网关能打开首屏 → 停掉', async () => {
    running = await boot(dir, { preview: { launch: stubLaunch, installDeps: false } })
    const app = await createApp('预览验证')

    const sse = openSse(running, app.id)
    await sse.connected

    const { preview: started } = await rpc<{ preview: PreviewStatus }>(running, 'preview.start', {
      appId: app.id,
    })
    expect(started.state).toBe('starting')

    const ready = await running.preview.waitReady(app.id, 10_000)
    expect(ready.state).toBe('ready')
    const url = ready.url
    expect(url).not.toBeNull()

    const html = await (await fetch(url as string)).text()
    expect(html).toContain('这是 stub 版首屏')

    // 事件也要走同一条 SSE：UI 靠它切 iframe，不靠轮询
    await sse.waitFor((events: SseEvent[]) =>
      events.some((event) => event.type === 'preview.ready' && event.appId === app.id),
    )
    const readyEvent = sse.events.find((event) => event.type === 'preview.ready')
    expect(readyEvent).toMatchObject({ url })

    const status = await rpc<{ preview: PreviewStatus }>(running, 'preview.status', {
      appId: app.id,
    })
    expect(status.preview.state).toBe('ready')

    const stopped = await rpc<{ preview: PreviewStatus }>(running, 'preview.stop', {
      appId: app.id,
    })
    expect(stopped.preview.state).toBe('stopped')
    await expect(fetch(url as string, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()

    sse.close()
  })

  it('删应用会把预览一起停掉（不留孤儿 dev server）', async () => {
    running = await boot(dir, { preview: { launch: stubLaunch, installDeps: false } })
    const app = await createApp('删我')

    await rpc(running, 'preview.start', { appId: app.id })
    const ready = await running.preview.waitReady(app.id, 10_000)
    expect(ready.state).toBe('ready')
    const url = ready.url as string

    await rpc(running, 'app.delete', { id: app.id })
    expect(running.preview.status(app.id).state).toBe('stopped')
    await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })
})
