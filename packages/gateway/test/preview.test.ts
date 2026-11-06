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
    /*
     * 首屏现在带一行注入脚本（M4 第 4 步：页面通道要在页面里跑起来）。
     * 所以断言"体以原文开头 + 带注入标记"，而不是"体完全等于原文" ——
     * 原文一个字都没改，只是后面多了一行。
     */
    const html = await response.text()
    expect(html.startsWith('<h1>你好</h1>')).toBe(true)
    expect(html).toContain('data-tenon-page')

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
    // HTML 会被注入页面通道的脚本，所以看前缀；`/api` 的回包不该被碰（上一行就是证据）
    expect((await (await fetch(url)).text()).startsWith('<h1>前端</h1>')).toBe(true)

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

  /*
   * ---------------------------------------------------------------- 日志
   *
   * 三个来源各一条：子进程输出、页面主动上报、平台自己的判断。
   * 它们最后都落在同一个缓冲里（`manager.logs`）并推同一种事件（`app.log`），
   * 界面上才可能是一个面板而不是三个。
   */

  it('子进程输出进日志：级别按内容判，ANSI 已剥掉，并推 app.log', async () => {
    const dir = await makeApp()
    const base = stubUpstream('ok')
    const noisy: Launcher = async (spec) => {
      // 模拟 Vite 的真实输出：一堆正常信息 + 一条带颜色的报错
      spec.onLine?.('VITE v7.3.7 ready in 312 ms', 'stdout')
      spec.onLine?.('\u001B[31mError: 找不到模块 ./pages/Home\u001B[39m', 'stderr')
      return base(spec)
    }
    const { manager, events } = managerFor(dir, noisy)

    await manager.start(APP_ID)
    await manager.waitReady(APP_ID)

    const entries = manager.logs(APP_ID, { sources: ['vite'] })
    const messages = entries.map((entry) => entry.message)
    expect(messages).toContain('VITE v7.3.7 ready in 312 ms')
    expect(messages).toContain('Error: 找不到模块 ./pages/Home')
    // ANSI 不能被原样塞进界面
    expect(messages.some((message) => message.includes('\u001B'))).toBe(false)
    expect(entries.find((entry) => entry.message.startsWith('Error:'))?.level).toBe('error')
    expect(entries.find((entry) => entry.message.startsWith('VITE'))?.level).toBe('info')

    const logEvents = events.filter((event) => event.type === 'app.log')
    expect(logEvents.length).toBeGreaterThanOrEqual(2)
    expect(logEvents[0]).toMatchObject({ appId: APP_ID })
  })

  it('页面上报的异常经网关进日志，停掉预览之后还看得到', async () => {
    const dir = await makeApp()
    const { manager } = managerFor(dir, stubUpstream('ok'))

    await manager.start(APP_ID)
    const ready = await manager.waitReady(APP_ID)

    const response = await fetch(`${ready.url as string}/__tenon/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        level: 'error',
        message: 'TypeError: items.map is not a function',
        detail: 'at App.tsx:12:9',
      }),
    })
    expect(response.status).toBe(204)

    const webLogs = manager.logs(APP_ID, { sources: ['web'] })
    expect(webLogs.at(-1)).toMatchObject({
      source: 'web',
      level: 'error',
      message: 'TypeError: items.map is not a function',
      detail: 'at App.tsx:12:9',
    })

    await manager.stop(APP_ID)
    // ★ 缓冲跟着应用走、不跟着预览跑：回看报错正是面板的主要用途
    expect(manager.logs(APP_ID).length).toBeGreaterThan(0)
    expect(manager.logs(APP_ID, { sources: ['web'] })).not.toEqual([])
  })

  it('平台自己的判断也进日志：起不来时有一条带原因的 error', async () => {
    const dir = await makeApp()
    const failing: Launcher = async () => {
      throw new Error('vite 起不来：端口被占')
    }
    const { manager } = managerFor(dir, failing)

    await manager.start(APP_ID)
    await manager.waitReady(APP_ID, 5000)

    const errors = manager.logs(APP_ID, { minLevel: 'error' })
    expect(errors.some((entry) => entry.message.includes('端口被占'))).toBe(true)
    // 清空只影响界面，不该把缓冲搞坏
    expect(manager.clearLogs(APP_ID)).toBeGreaterThan(0)
    expect(manager.logs(APP_ID)).toEqual([])
  })
})

describe('依赖安装的取消（v1.2.24）', () => {
  /**
   * 这条是删应用时"目录删不掉"的根因所在：`app.create` 建完就**不等地**开始装依赖，
   * 那个 pnpm 进程拿 `repo/` 当 CWD。删应用如果不等它结束，Windows 上 rmdir 就是 EBUSY，
   * POSIX 上则会留下半装的 node_modules。所以删之前必须掐掉 —— 而且要**等到**它真的结束。
   */
  it('★ cancelDeps 会掐掉正在跑的安装，并且等到它真的结束', async () => {
    const dir = await makeApp()
    let seen: AbortSignal | undefined
    let settled = false

    const manager = new PreviewManager({
      home: resolveHome({ TENON_HOME: dir }),
      // 这条用例不该起 dev server
      launch: (() => Promise.reject(new Error('不该起预览'))) as unknown as Launcher,
      installDeps: true,
      readyTimeoutMs: 5000,
      apiReadyTimeoutMs: 5000,
      database: fakeDatabase(),
      // 假的安装器：只有收到 abort 才结束 —— 模拟"pnpm 正在跑"
      depsInstaller: (options) =>
        new Promise((resolve) => {
          seen = options.signal
          options.signal?.addEventListener('abort', () => {
            settled = true
            resolve({ installed: false, command: 'stub install (已取消)', durationMs: 1 })
          })
        }),
      publish: () => undefined,
    })
    cleanups.push(() => manager.close())

    const installing = manager.ensureDeps(APP_ID)
    // 等它真的进到 installer（ensureDeps 里还有几步 await）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toBeDefined()

    const cancelled = await manager.cancelDeps(APP_ID)
    expect(cancelled).toBe(true)
    // ★ 关键：cancelDeps 返回时安装已经结束了，不是"发了信号就走"
    expect(settled).toBe(true)
    await installing
  })

  it('没有正在装的 → 返回 false（删一个没在装依赖的应用是常态）', async () => {
    const dir = await makeApp()
    const manager = new PreviewManager({
      home: resolveHome({ TENON_HOME: dir }),
      launch: (() => Promise.reject(new Error('不该起预览'))) as unknown as Launcher,
      installDeps: false,
      database: fakeDatabase(),
      publish: () => undefined,
    })
    cleanups.push(() => manager.close())
    expect(await manager.cancelDeps(APP_ID)).toBe(false)
  })
})
