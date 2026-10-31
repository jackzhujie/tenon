/**
 * 预览编排的测试。
 *
 * 全程用注入的 `launch`（一个二十行的 stub 上游）—— 这里要验的是**状态机**：
 * 谁先起、就绪怎么判定、失败怎么报、停了以后线有没有收干净。
 * 真实 Vite + 真 `pnpm install` 的那条路由 `scripts/e2e-preview.ts` 覆盖（手工跑，不进 CI）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHome } from '@tenon/core'
import type { SseEvent } from '@tenon/protocol'
import { PreviewManager } from '../src/preview.js'
import type { Launched, Launcher, LaunchSpec } from '../src/vite.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  // LIFO：manager（后建）先关，再删目录
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const APP_ID = 'app_preview_test'

/** 建一个"看起来像应用"的目录：有 repo/、有 package.json */
async function makeApp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-preview-'))
  const repo = join(dir, 'apps', APP_ID, 'repo')
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'package.json'), '{"name":"demo"}', 'utf8')
  await writeFile(join(repo, 'index.html'), '<h1>demo</h1>', 'utf8')
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function managerFor(
  dir: string,
  launch: Launcher,
  extra: { installDeps?: boolean; readyTimeoutMs?: number } = {},
): { manager: PreviewManager; events: SseEvent[] } {
  const events: SseEvent[] = []
  const manager = new PreviewManager({
    home: resolveHome({ TENON_HOME: dir }),
    launch,
    // stub 上游不需要 node_modules
    installDeps: extra.installDeps ?? false,
    readyTimeoutMs: extra.readyTimeoutMs ?? 5000,
    publish: (event) => {
      events.push({ ...event, seq: events.length + 1 } as SseEvent)
    },
  })
  cleanups.push(() => manager.close())
  return { manager, events }
}

/** 在上游端口上起一个静态响应，模拟 dev server */
function stubUpstream(body: string, options: { delayMs?: number } = {}): Launcher {
  return async (spec: LaunchSpec): Promise<Launched> => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    })
    await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 0))
    await new Promise<void>((resolve) => server.listen(spec.vitePort, '127.0.0.1', () => resolve()))
    return {
      pid: undefined,
      output: () => 'stub',
      onExit: () => undefined,
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }
}

describe('PreviewManager', () => {
  it('没起过预览时状态是 stopped', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('x'))
    const status = manager.status(APP_ID)
    expect(status.state).toBe('stopped')
    expect(status.url).toBeNull()
    expect(status.readiness).toEqual({ deps: 'pending', server: 'pending', preview: 'pending' })
  })

  it('start 立刻返回 starting，就绪后 url 指向网关而不是 dev server', async () => {
    const dir = await makeApp()
    const { manager, events } = managerFor(dir, stubUpstream('<h1>你好</h1>'))

    const started = await manager.start(APP_ID)
    expect(started.state).toBe('starting')

    const ready = await manager.waitReady(APP_ID)
    expect(ready.state).toBe('ready')
    expect(ready.readiness).toEqual({ deps: 'ready', server: 'ready', preview: 'ready' })
    expect(ready.url).not.toBeNull()
    expect(ready.gatewayPort).not.toBe(ready.upstreamPort)
    /*
     * ★ 端口必须**一一对上**：`gatewayPort` 会被写进 dev server 的 `TENON_GATEWAY_PORT`，
     * 模板拿它做 `server.hmr.clientPort`。这里若只是「有个端口、url 也能打开」，
     * 随机端口照样通过 —— 但浏览器里的 HMR 会去连那个没人监听的端口，永远不工作，
     * 而且页面上看不出任何异常（页面是走 url 打开的）。
     */
    expect(new URL(ready.url as string).port).toBe(String(ready.gatewayPort))

    const response = await fetch(ready.url as string)
    expect(await response.text()).toBe('<h1>你好</h1>')

    const types = events.map((event) => event.type)
    expect(types).toContain('preview.status')
    expect(types).toContain('preview.ready')
    const published = events.find((event) => event.type === 'preview.ready')
    expect(published).toMatchObject({ appId: APP_ID, url: ready.url })
  })

  it('重复 start 不加新进程，端口也不变（前端轮询不会把服务越轮越多）', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('ok'))

    await manager.start(APP_ID)
    const first = await manager.waitReady(APP_ID)
    const again = await manager.start(APP_ID)
    expect(again.gatewayPort).toBe(first.gatewayPort)
    expect(again.state).toBe('ready')
  })

  it('restart=true 才会换端口重起', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('ok'))

    await manager.start(APP_ID)
    const first = await manager.waitReady(APP_ID)
    await manager.start(APP_ID, { restart: true })
    const second = await manager.waitReady(APP_ID)

    expect(second.state).toBe('ready')
    expect(second.gatewayPort).not.toBe(first.gatewayPort)
    // 旧端口必须已经放开，否则每重启一次漏一个端口
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(first.upstreamPort as number, '127.0.0.1', () => resolve())
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  it('停掉之后网关不再可达，状态回到 stopped', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('ok'))

    await manager.start(APP_ID)
    const ready = await manager.waitReady(APP_ID)
    const url = ready.url as string

    const stopped = await manager.stop(APP_ID)
    expect(stopped.state).toBe('stopped')
    expect(stopped.url).toBeNull()
    await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })

  it('dev server 起不来：state=failed 且带上原因，不是空等', async () => {
    const dir = await makeApp()
    const failing: Launcher = async () => {
      throw new Error('vite 起不来：端口被占')
    }
    const { manager } = managerFor(dir, failing)

    await manager.start(APP_ID)
    const status = await manager.waitReady(APP_ID, 5000)

    expect(status.state).toBe('failed')
    expect(status.error).toContain('端口被占')
    expect(status.readiness.preview).toBe('failed')
  })

  it('dev server 迟迟不就绪：超时后判失败（不会永远挂在 starting）', async () => {
    const dir = await makeApp()
    // 只 sleep 不监听：网关一直 502
    const neverReady: Launcher = async (spec) => ({
      pid: undefined,
      output: () => '',
      onExit: () => undefined,
      stop: async () => undefined,
    })
    const { manager } = managerFor(dir, neverReady, { readyTimeoutMs: 600 })

    await manager.start(APP_ID)
    const status = await manager.waitReady(APP_ID, 5000)
    expect(status.state).toBe('failed')
    expect(status.error).toContain('没有就绪')
  })

  it('应用目录不存在时 start 直接报 APP_HOME_MISSING（不是静默失败）', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('ok'))
    await expect(manager.start('app_not_there')).rejects.toMatchObject({
      code: 'APP_HOME_MISSING',
    })
  })
})
