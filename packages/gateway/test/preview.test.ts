/**
 * 预览编排的测试。
 *
 * 全程用注入的 launcher（二十行的 stub 上游）与假数据库 —— 这里要验的是**状态机**：
 * 谁先起、就绪怎么判定、`/api` 有没有真的分流到后端、失败怎么报、停了以后线有没有收干净。
 * 真实 Vite + 真 `pnpm install` + 真 PGlite + 真 Nest 的那条路由
 * `scripts/e2e-preview.ts` 与 `scripts/e2e-fullstack.ts` 覆盖（手工跑，不进 CI）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHome } from '@tenon/core'
import type { DatabaseProvider } from '@tenon/db-provisioner'
import type { SseEvent } from '@tenon/protocol'
import type { ApiLauncher, ApiLaunchSpec } from '../src/api.js'
import { PreviewManager, type PreviewDatabase } from '../src/preview.js'
import type { Launched, Launcher, LaunchSpec } from '../src/vite.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  // LIFO：manager（后建）先关，再删目录
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const APP_ID = 'app_preview_test'

/** 建一个"看起来像应用"的目录：有 repo/、有 package.json */
async function makeApp(options: { fullstack?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-preview-'))
  const repo = join(dir, 'apps', APP_ID, 'repo')
  await mkdir(repo, { recursive: true })
  const pkg =
    options.fullstack === true ? { name: 'demo', tenon: { api: 'api/main.ts' } } : { name: 'demo' }
  await writeFile(join(repo, 'package.json'), JSON.stringify(pkg), 'utf8')
  await writeFile(join(repo, 'index.html'), '<h1>demo</h1>', 'utf8')
  if (options.fullstack === true) {
    await mkdir(join(repo, 'api'), { recursive: true })
    await writeFile(join(repo, 'api', 'main.ts'), '// stub\n', 'utf8')
  }
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 假数据库：只记调用次数，顺便把连接串与 poolMax 变成可断言的常量 */
function fakeDatabase(): PreviewDatabase & { stats: { acquired: number; released: number } } {
  const provider: DatabaseProvider = {
    mode: 'pglite',
    start: async () => undefined,
    stop: async () => undefined,
    connectionString: () => 'postgres://stub@127.0.0.1:5433/postgres',
    poolMax: () => 1,
    status: () => ({
      mode: 'pglite',
      state: 'ready',
      connectionString: 'postgres://stub@127.0.0.1:5433/postgres',
      port: 5433,
      poolMax: 1,
      dataDir: null,
      error: null,
    }),
    dump: async () => {
      throw new Error('stub 不支持快照')
    },
    restore: async () => undefined,
  }
  // ★ 计数值必须挂在**同一个对象**上：`Object.assign(db, {acquired: 0})` 是拷贝值，
  // 之后闭包里 +1 也不会反映出来，断言永远读到 0（这次就踩了）
  const stats = { acquired: 0, released: 0 }
  const database: PreviewDatabase = {
    async acquire() {
      stats.acquired += 1
      return provider
    },
    async release() {
      stats.released += 1
    },
    async closeAll() {
      return undefined
    },
  }
  return Object.assign(database, { stats })
}

function managerFor(
  dir: string,
  launch: Launcher,
  extra: {
    installDeps?: boolean
    readyTimeoutMs?: number
    apiReadyTimeoutMs?: number
    launchApi?: ApiLauncher
    database?: PreviewDatabase
  } = {},
): { manager: PreviewManager; events: SseEvent[] } {
  const events: SseEvent[] = []
  const manager = new PreviewManager({
    home: resolveHome({ TENON_HOME: dir }),
    launch,
    // stub 上游不需要 node_modules
    installDeps: extra.installDeps ?? false,
    readyTimeoutMs: extra.readyTimeoutMs ?? 5000,
    apiReadyTimeoutMs: extra.apiReadyTimeoutMs ?? 5000,
    database: extra.database ?? fakeDatabase(),
    ...(extra.launchApi === undefined ? {} : { launchApi: extra.launchApi }),
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

/** 假后端：只认 /api/health 与 /api/echo，其它一律 404 */
function stubApi(options: { health?: 'ok' | 'fail' } = {}): ApiLauncher & { specs: ApiLaunchSpec[] } {
  const specs: ApiLaunchSpec[] = []
  const launcher: ApiLauncher = async (spec) => {
    specs.push(spec)
    const server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/api/health') {
        if (options.health === 'fail') {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"ok":false,"error":"迁移失败"}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true,"db":{"poolMax":1}}')
        return
      }
      if (url === '/api/echo') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('来自后端')
        return
      }
      res.writeHead(404)
      res.end('nope')
    })
    await new Promise<void>((resolve) => server.listen(spec.apiPort, '127.0.0.1', () => resolve()))
    return {
      pid: undefined,
      output: () => 'stub api',
      onExit: () => undefined,
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }
  return Object.assign(launcher, { specs })
}

describe('PreviewManager', () => {
  it('没起过预览时状态是 stopped', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('x'))
    const status = manager.status(APP_ID)
    expect(status.state).toBe('stopped')
    expect(status.url).toBeNull()
    expect(status.apiPort).toBeNull()
    expect(status.readiness).toEqual({
      deps: 'pending',
      db: 'pending',
      server: 'pending',
      preview: 'pending',
    })
  })

  it('start 立刻返回 starting，就绪后 url 指向网关而不是 dev server', async () => {
    const dir = await makeApp()
    const { manager, events } = managerFor(dir, stubUpstream('<h1>你好</h1>'))

    const started = await manager.start(APP_ID)
    expect(started.state).toBe('starting')

    const ready = await manager.waitReady(APP_ID)
    expect(ready.state).toBe('ready')
    // 纯前端应用：没有后端就没有 apiPort
    expect(ready.apiPort).toBeNull()
    expect(ready.readiness).toEqual({
      deps: 'ready',
      db: 'ready',
      server: 'ready',
      preview: 'ready',
    })
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

  it('全栈应用：/api 分给后端，其余给前端，连接串与 poolMax 真的传给了后端', async () => {
    const dir = await makeApp({ fullstack: true })
    const api = stubApi()
    const database = fakeDatabase()
    const { manager } = managerFor(dir, stubUpstream('<h1>前端</h1>'), { launchApi: api, database })

    await manager.start(APP_ID)
    const ready = await manager.waitReady(APP_ID)

    expect(ready.state).toBe('ready')
    expect(ready.apiPort).not.toBeNull()
    expect(ready.apiPort).not.toBe(ready.upstreamPort)
    expect(ready.readiness.server).toBe('ready')
    expect(database.stats.acquired).toBe(1)

    const url = ready.url as string
    // 同一源上的两条前缀：这是「单源、无 CORS」的全部意义
    expect(await (await fetch(`${url}/api/echo`)).text()).toBe('来自后端')
    expect(await (await fetch(url)).text()).toBe('<h1>前端</h1>')

    // ★ 铁律 2 的落点：应用只拿到一个连接串 + 一个容量参数
    const spec = api.specs[0] as ApiLaunchSpec
    expect(spec.databaseUrl).toBe('postgres://stub@127.0.0.1:5433/postgres')
    expect(spec.poolMax).toBe(1)
    expect(spec.entry.source).toBe('api/main.ts')
    // 模板声明了编译产物 → 走「tsc watch + node 跑产物」，不是直接跑 .ts
    expect(spec.entry.output).toBeNull()
  })

  it('后端 health 不通：failed，且 readiness.server 标红（不是笼统的 preview failed）', async () => {
    const dir = await makeApp({ fullstack: true })
    const { manager } = managerFor(dir, stubUpstream('<h1>前端</h1>'), {
      launchApi: stubApi({ health: 'fail' }),
      apiReadyTimeoutMs: 700,
    })

    await manager.start(APP_ID)
    const status = await manager.waitReady(APP_ID, 8000)

    expect(status.state).toBe('failed')
    expect(status.readiness.server).toBe('failed')
    expect(status.readiness.preview).not.toBe('failed')
    expect(status.error).toContain('后端')
    expect(status.error).toContain('stub api')
  })

  it('数据库起不来：failed 且 readiness.db 标红', async () => {
    const dir = await makeApp({ fullstack: true })
    const database: PreviewDatabase = {
      async acquire() {
        throw new Error('PGlite 数据目录被占用')
      },
      async release() {
        return undefined
      },
      async closeAll() {
        return undefined
      },
    }
    const { manager } = managerFor(dir, stubUpstream('x'), { launchApi: stubApi(), database })

    await manager.start(APP_ID)
    const status = await manager.waitReady(APP_ID)

    expect(status.state).toBe('failed')
    expect(status.readiness.db).toBe('failed')
    expect(status.error).toContain('数据库')
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

  it('restart=true 才会换端口重起，并归还数据库', async () => {
    const dir = await makeApp({ fullstack: true })
    const database = fakeDatabase()
    const { manager } = managerFor(dir, stubUpstream('ok'), { launchApi: stubApi(), database })

    await manager.start(APP_ID)
    const first = await manager.waitReady(APP_ID)
    await manager.start(APP_ID, { restart: true })
    const second = await manager.waitReady(APP_ID)

    expect(second.state).toBe('ready')
    expect(second.gatewayPort).not.toBe(first.gatewayPort)
    // 停一次放一次：库的生命周期跟着预览走（provider 本身复用，端口不变）
    expect(database.stats.released).toBe(1)
    expect(database.stats.acquired).toBe(2)
    // 旧端口必须已经放开，否则每重启一次漏一个端口
    for (const port of [first.upstreamPort, first.apiPort]) {
      const probe = createServer()
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port as number, '127.0.0.1', () => resolve())
      })
      await new Promise<void>((resolve) => probe.close(() => resolve()))
    }
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
    const neverReady: Launcher = async () => ({
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
