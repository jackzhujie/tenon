/**
 * 组件链路的验收（M5 第 3 步 b）：**网关 + 真 WS + 真 chord**，不掺假。
 *
 * 用一个 stub 上游当"应用页面"（20 行够用），这样就跳过了装 React、起 Vite 那几十秒，
 * 而真正要验的三件事一件都不少：
 *
 * 1. HTML 里被插了组件脚本，脚本能从同源取到（`/__tenon/component.js`）；
 * 2. WS 升级**没有**被转给 Vite，而是被 bridge 接住、握了手；
 * 3. 握完手之后，浏览器那半边能像真页面一样 `ctx.get` → 调 `ask` → 读到状态。
 *
 * 第三点是关键：它证明"注入的 web facet 走的那条路"是通的 —— web facet 里的代码
 * 与这里测试客户端用的是**同一套 chord 调用**，只是它多了 DOM。
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createHost, webSocketLink, type Host } from '@earendil-works/chord'
import { COMPONENT_SCRIPT_PATH, COMPONENT_WS_PATH, startGateway, type Gateway } from '@tenon/gateway'
import { appPaths, resolveHome } from '@tenon/core'
import type { AgentRuntime } from '@tenon/agent'
import { writeAssembly } from '@tenon/component-host'
import { ComponentRuntime, type Principal } from '../src/components.js'
import { createComponentBridge } from '../src/components-link.js'
import { Assistant } from '../../../plugins/bundled/tenon.official.ai-assistant/contract.js'

const APP_ID = 'app-link'
const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'bundled')

let dir: string
let upstream: Server | undefined
let gateway: Gateway | undefined
let runtime: ComponentRuntime | undefined
let host: Host<Principal> | undefined
let socket: WebSocket | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-clink-'))
})

afterEach(async () => {
  await host?.close()
  host = undefined
  socket?.terminate()
  socket = undefined
  await gateway?.close()
  gateway = undefined
  await runtime?.close()
  runtime = undefined
  await new Promise<void>((resolve) => (upstream === undefined ? resolve() : upstream.close(() => resolve())))
  upstream = undefined
  await rm(dir, { recursive: true, force: true })
})

/** 没有模型的应用也要能装组件 —— 这里刻意用"没配模型"的 runtime 验那条路 */
function runtimeWithoutModel(home = resolveHome({ TENON_HOME: dir })): ComponentRuntime {
  return new ComponentRuntime({
    home,
    agent: { pool: undefined, model: undefined } as unknown as AgentRuntime,
    roots: [{ kind: 'bundled', dir: PLUGINS }],
    tenonVersion: '0.0.0',
  })
}

async function assemble(): Promise<void> {
  const repoDir = appPaths(resolveHome({ TENON_HOME: dir }), APP_ID).repoDir
  await mkdir(repoDir, { recursive: true })
  await writeAssembly(repoDir, {
    version: 1,
    components: [
      {
        id: 'tenon.official.ai-assistant',
        version: '^1.0.0',
        license: 'free',
        enabled: true,
        mount: [{ slot: 'app.shell.overlay', order: 100 }],
      },
    ],
  })
}

async function bootGateway(): Promise<void> {
  upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><div id="app">应用页面</div></body></html>')
  })
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', () => resolve()))
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('stub 上游没起来')

  runtime = runtimeWithoutModel()
  const bridge = createComponentBridge({ appId: APP_ID, runtime })
  gateway = await startGateway({ routes: [{ prefix: '/', port: address.port }], components: bridge })
}

describe('组件链路（网关 → WS → chord host）', () => {
  it('页面 HTML 里被插了组件脚本，脚本同源可取且是打了包的那份', async () => {
    await assemble()
    await bootGateway()
    const html = await (await fetch(`${gateway?.url}/`)).text()
    expect(html).toContain('type="module"')
    expect(html).toContain(`${COMPONENT_SCRIPT_PATH}?appId=${APP_ID}`)
    // 应用自己的内容不能被吃掉
    expect(html).toContain('应用页面')

    const response = await fetch(`${gateway?.url}${COMPONENT_SCRIPT_PATH}?appId=${APP_ID}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    const code = await response.text()
    // 包里必须带着契约类型名与挂载点标记 —— 否则"注入成功但什么都不会发生"
    expect(code).toContain('tenon.official.ai-assistant')
    expect(code.length).toBeGreaterThan(10_000)
  })

  it('没有装配声明时：不插脚本、脚本 404、升级请求被拒', async () => {
    await bootGateway()
    const html = await (await fetch(`${gateway?.url}/`)).text()
    expect(html).not.toContain(COMPONENT_SCRIPT_PATH)

    const response = await fetch(`${gateway?.url}${COMPONENT_SCRIPT_PATH}?appId=${APP_ID}`)
    expect(response.status).toBe(404)

    const closed = await new Promise<boolean>((resolve) => {
      const probe = new WebSocket(`${gateway?.url.replace('http', 'ws')}${COMPONENT_WS_PATH}`)
      probe.on('open', () => {
        probe.terminate()
        resolve(false)
      })
      probe.on('error', () => resolve(true))
    })
    expect(closed).toBe(true)
  })

  /*
   * ⚠️ **跳过，且必须留在这里**：chord 的 `WebSocketLink` 接 `ws` 这条组合还没通 ——
   * 握手成功、`ctx.get` 也能拿到引用，但随后报
   * `invalid/protocol: link to peer: ack 2 outside 0..2`，调用不再返回。
   * memoryLink（Spike 5 用的那条）完全正常，所以问题在"真实 WebSocket 上的窗口/序号"，
   * 不是我们的接线。下一步先做一个小 spike 把这条链路跑通（STATUS §4.21 记了这件事），
   * 通了这个用例就取消 skip —— 它是 3b 唯一能证明"浏览器那半边真的能说话"的东西。
   */
  it('升级被接住：浏览器那半边能 get → ask → 读到服务端状态', async () => {
    await assemble()
    await bootGateway()

    socket = new WebSocket(`${gateway?.url.replace('http', 'ws')}${COMPONENT_WS_PATH}`)
    /*
     * ★ **不能等 'open' 再建 host**。链路要在 socket 刚建出来时就挂上去：
     * 等 open 的这几十毫秒里服务端可能已经发了初始帧，没人在听 = 帧丢了，
     * 之后的序号/窗口全部错位（表现就是 `ack 2 outside 0..2`，然后调用永远不返回）。
     * 浏览器那半边（web.ts）也是这么写的：new WebSocket 之后立刻 webSocketLink。
     */
    host = createHost<Principal>({
      name: 'ui',
      self: { appId: APP_ID },
      principalKey: (principal) => principal.appId,
      kind: 'client',
      readyTimeout: 5_000,
      upstream: { link: webSocketLink(socket), principal: { appId: APP_ID } },
    })

    const messages = await host.root(async (ctx) => {
      const ref = await ctx.get(Assistant, { appId: APP_ID })
      await ref.ask({ text: '在吗' }, ctx)
      return ref.messages.value as { role: string; text: string }[]
    })

    expect(messages[0]).toEqual({ role: 'user', text: '在吗' })
    /*
     * 这个应用没配模型 —— 所以回答是一条 system 消息。**这正是要验的**：
     * 组件照常装上、链路照常通，用户点发送才知道该去配模型；
     * 而不是"组件装不上"（那会让人去查插件，方向完全错）。
     */
    expect(messages[1]?.role).toBe('system')
    expect(messages[1]?.text).toContain('模型')
  })
})
