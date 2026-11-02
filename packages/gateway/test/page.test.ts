/**
 * 页面通道的测试。
 *
 * 分两层：
 * 1. **纯桥**（不起 HTTP）：命令排队、超时、刷新重投、导航票据、关停。这些是
 *    "页面正在重载"那类竞态的所在地，用假客户端比真浏览器更容易把时序捏准。
 * 2. **经网关**：四条路径由网关自己吃掉、HTML 被注入且 `content-length` 重算、
 *    没有 page 时**行为完全不变**（回归保护）。
 *
 * 一条都不需要浏览器 —— 真浏览器那条在 `scripts/e2e-e2e-agent.ts` 里。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PageBridge, PageError, injectPageScript, PAGE_SCRIPT, type PageCommand } from '../src/page.js'
import { startGateway, type Gateway } from '../src/proxy.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

async function post(url: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 只回答一段 HTML 的上游（模拟 Vite 的 index.html） */
async function stubHtml(html: string, type = 'text/html; charset=utf-8'): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, { 'content-type': type, 'content-length': String(body.length) })
    res.end(body)
  })
  const port = await listen(server)
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { port, seen }
}

async function start(port: number, page?: PageBridge): Promise<Gateway> {
  const gateway = await startGateway({
    routes: [{ prefix: '/', port }],
    ...(page === undefined ? {} : { page }),
  })
  cleanups.push(async () => {
    page?.close()
    await gateway.close()
  })
  return gateway
}

// ------------------------------------------------------------------ 纯桥

describe('PageBridge', () => {
  it('没有页面时明确报 missing，而不是干等', async () => {
    const bridge = new PageBridge()
    cleanups.push(async () => bridge.close())
    await expect(bridge.run('read', {}, { waitMs: 0 })).rejects.toMatchObject({ reason: 'missing' })
    await expect(bridge.run('read', {}, { waitMs: 0 })).rejects.toBeInstanceOf(PageError)
  })

  it('hello 之后命令能下发，reply 能兑现（值原样带回）', async () => {
    const bridge = new PageBridge()
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 's1', path: '/', title: '首页' })

    const running = bridge.run('read', { selector: '#app' })
    const command = await bridge.poll('s1')
    expect(command).not.toBeNull()
    expect((command as PageCommand).name).toBe('read')
    bridge.reply({ id: (command as PageCommand).id, ok: true, value: { text: '你好' }, errors: ['boom'] })

    await expect(running).resolves.toMatchObject({ ok: true, value: { text: '你好' }, errors: ['boom'] })
  })

  it('拿旧 sessionId 来轮询会被要求重置（否则页面空转打满 CPU）', async () => {
    const bridge = new PageBridge()
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 'new' })
    await expect(bridge.poll('old')).resolves.toBe('reset')
  })

  it('命令超时后清掉挂账，不会在下一轮被误投递', async () => {
    // pollMs 也要压小：否则下面那次 poll 会老老实实挂满默认的 20 秒（测试白等）
    const bridge = new PageBridge({ commandTimeoutMs: 60, pollMs: 100 })
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 's1' })

    await expect(bridge.run('click', { selector: '#x' })).rejects.toMatchObject({ reason: 'timeout' })
    // 挂账清掉：后面再没东西可投
    const command = await bridge.poll('s1')
    expect(command).toBeNull()
  })

  it('页面刷新时，已领走但没回话的 assert 会重新排队', async () => {
    const bridge = new PageBridge({ pollMs: 2000 })
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 's1' })

    const running = bridge.run('assert', { text: '完成' })
    const first = (await bridge.poll('s1')) as PageCommand
    expect(first.name).toBe('assert')

    // 页面在回话之前就重载了：同一个 sessionId 重新报到
    bridge.hello({ sessionId: 's1', path: '/', title: '首页' })
    const replayed = (await bridge.poll('s1')) as PageCommand
    expect(replayed.id).toBe(first.id)
    expect(replayed.args).toMatchObject({ text: '完成' })

    bridge.reply({ id: replayed.id, ok: true, value: { pass: true } })
    await expect(running).resolves.toMatchObject({ ok: true })
  })

  it('click 不重投：重放一次点击可能点出两个东西', async () => {
    const bridge = new PageBridge({ pollMs: 2000 })
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 's1' })

    const running = bridge.run('click', { selector: '#buy' })
    const first = (await bridge.poll('s1')) as PageCommand
    bridge.hello({ sessionId: 's1' })
    // 重新报到之后，队列里不该出现同一条 click
    const next = await bridge.poll('s1')
    expect(next === null || (next as PageCommand).id !== first.id).toBe(true)
    bridge.reply({ id: first.id, ok: true, value: { clicked: 'button' } })
    await expect(running).resolves.toMatchObject({ ok: true })
  })

  it('navigate 等到新页面带票据报到了才算成', async () => {
    const bridge = new PageBridge()
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 's1', path: '/', title: '首页' })

    const jumping = bridge.navigate('/items')
    const command = (await bridge.poll('s1')) as PageCommand
    expect(command.name).toBe('navigate')
    const ticket = String((command.args as { ticket?: string }).ticket)
    expect(ticket.length).toBeGreaterThan(0)
    bridge.reply({ id: command.id, ok: true })

    bridge.hello({ sessionId: 's1', path: '/items', title: '清单', ticket })
    await expect(jumping).resolves.toMatchObject({ path: '/items', title: '清单' })
  })

  it('浏览器断开长轮询后，命令不会被投给那个已死的等待者', async () => {
    const bridge = new PageBridge({ pollMs: 5000 })
    cleanups.push(async () => bridge.close())
    bridge.hello({ sessionId: 's1' })

    // 页面挂着的轮询；紧接着整页导航把这条连接掐了
    const abort = new AbortController()
    const hanging = bridge.poll('s1', abort.signal)
    abort.abort()
    await expect(hanging).resolves.toBeNull()

    /*
     * 断开之后新发的命令必须留给"下一个"轮询。
     * 不处理断开的话它会被投给上面那条死连接：没人执行、没人回话，只能等超时
     * —— 真机重载时 100% 复现（`pnpm e2e:e2e` 抓到的就是这个）。
     */
    const running = bridge.run('read', {})
    const command = (await bridge.poll('s1')) as PageCommand
    expect(command.name).toBe('read')
    bridge.reply({ id: command.id, ok: true, value: { text: '还在' } })
    await expect(running).resolves.toMatchObject({ value: { text: '还在' } })
  })

  it('close 让挂着的命令立刻失败，不再等超时', async () => {
    const bridge = new PageBridge({ commandTimeoutMs: 30_000 })
    bridge.hello({ sessionId: 's1' })
    const running = bridge.run('read', {})
    await bridge.poll('s1')
    const started = Date.now()
    bridge.close()
    await expect(running).rejects.toMatchObject({ reason: 'closed' })
    expect(Date.now() - started).toBeLessThan(500)
  })
})

// ------------------------------------------------------------------ 经网关

describe('网关的页面路径与注入', () => {
  it('四条路径都由网关吃掉，一条都不转发给上游', async () => {
    const upstream = await stubHtml('<html><body><div id="app"></div></body></html>')
    const bridge = new PageBridge({ pollMs: 100 })
    const gateway = await start(upstream.port, bridge)

    const script = await fetch(`${gateway.url}/__tenon/page.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toBe(PAGE_SCRIPT)

    const hello = await post(`${gateway.url}/__tenon/page/hello`, { path: '/', title: '首页' })
    const { sessionId } = (await hello.json()) as { sessionId: string }
    expect(sessionId.length).toBeGreaterThan(0)

    const poll = await post(`${gateway.url}/__tenon/page/poll`, { sessionId })
    expect(await poll.json()).toEqual({ idle: true })

    const reply = await post(`${gateway.url}/__tenon/page/reply`, { sessionId, id: 'nope', ok: true })
    expect(reply.status).toBe(204)

    // 上游一次都没被这些路径打到（转发给 Vite 只会 404，而 404 会伪装成"页面没连上"）
    expect(upstream.seen).toEqual([])
  })

  it('HTML 被注入一行脚本，content-length 跟着重算', async () => {
    const html = '<html><head><title>演示</title></head><body><div id="app">你好</div></body></html>'
    const upstream = await stubHtml(html)
    const bridge = new PageBridge()
    const gateway = await start(upstream.port, bridge)

    const response = await fetch(gateway.url)
    const body = await response.text()
    expect(body).toContain('data-tenon-page')
    expect(body).toContain('/__tenon/page.js')
    // 插在 </body> 之前：head 里执行时 document.title 还是空的
    expect(body.indexOf('data-tenon-page')).toBeLessThan(body.indexOf('</body>'))
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(body, 'utf8'))
  })

  it('非 HTML 响应原样透传（别去动 JSON / JS 的体）', async () => {
    const payload = '{"ok":true}'
    const upstream = await stubHtml(payload, 'application/json; charset=utf-8')
    const bridge = new PageBridge()
    const gateway = await start(upstream.port, bridge)

    const response = await fetch(gateway.url)
    expect(await response.text()).toBe(payload)
  })

  it('没有 page 选项时完全不注入（老行为不变）', async () => {
    const html = '<html><body><div id="app"></div></body></html>'
    const upstream = await stubHtml(html)
    const gateway = await start(upstream.port)

    const response = await fetch(gateway.url)
    expect(await response.text()).toBe(html)
  })

  it('一条命令经 HTTP 全链路跑通（页面 = 假客户端）', async () => {
    const upstream = await stubHtml('<html><body></body></html>')
    const bridge = new PageBridge({ pollMs: 3000 })
    const gateway = await start(upstream.port, bridge)

    const { sessionId } = (await (
      await post(`${gateway.url}/__tenon/page/hello`, { path: '/', title: '首页' })
    ).json()) as { sessionId: string }

    const running = bridge.run('assert', { text: '完成' })
    const command = (await (await post(`${gateway.url}/__tenon/page/poll`, { sessionId })).json()) as PageCommand
    expect(command.name).toBe('assert')

    await post(`${gateway.url}/__tenon/page/reply`, {
      sessionId,
      id: command.id,
      ok: true,
      value: { pass: true, seen: { contains: true } },
      errors: [],
    })
    await expect(running).resolves.toMatchObject({ ok: true, value: { pass: true } })
  })
})

describe('injectPageScript', () => {
  it('插在 </body> 之前；重复调用不会插两遍', () => {
    const once = injectPageScript('<html><body>x</body></html>')
    expect(once.match(/data-tenon-page/g)).toHaveLength(1)
    expect(injectPageScript(once)).toBe(once)
  })

  it('没有 body / html 就追加到末尾，不抛错', () => {
    expect(injectPageScript('<div>片段</div>')).toContain('data-tenon-page')
  })
})
