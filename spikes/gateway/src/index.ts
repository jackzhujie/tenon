/**
 * Spike 2 验收：Vite HMR 的 WebSocket 经自建网关依然可用。
 *
 * 关键判断：iframe 里的页面全程只认识网关端口（location.origin 不变），
 * 改文件 → Vite 推送 update → 前端收到。这是"预览体验的命门"。
 */
import { createServer as createHttpServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createServer as createViteServer } from 'vite'
import WebSocket from 'ws'
import { startGateway } from './gateway.js'

const APP_ROOT = join(new URL('..', import.meta.url).pathname, 'app')

type Fact = { name: string; ok: boolean; detail: string }
const facts: Fact[] = []
function fact(name: string, ok: boolean, detail: string): void {
  facts.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

/** 预留一个空闲端口（先占后放，避免 vite/gateway 抢同一端口）*/
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createHttpServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'))
      const port = addr.port
      s.close(() => resolve(port))
    })
  })
}

async function startVite(port: number, gatewayPort: number) {
  const server = await createViteServer({
    root: APP_ROOT,
    configFile: false,
    logLevel: 'warn',
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      // 页面经网关访问，HMR 客户端必须往网关端口回连
      hmr: { host: '127.0.0.1', clientPort: gatewayPort, protocol: 'ws' },
    },
  })
  await server.listen()
  return server
}

/** 假装是生成应用后端的 NestJS */
async function startMockApi(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'nest-stand-in', ts: Date.now() }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('api port')
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

type HmrMessage = { type?: string; updates?: Array<{ path?: string; acceptedPath?: string }>; path?: string }

async function main(): Promise<void> {
  const gwPort = await reservePort()
  const vitePort = await reservePort()
  const api = await startMockApi()
  const gateway = await startGateway({
    port: gwPort,
    routes: [
      { prefix: '/api', port: api.port },
      { prefix: '/', port: vitePort },
    ],
  })
  // 注意：vite 必须在网关端口确定后再起，因为 hmr.clientPort 写死在配置里
  let vite = await startVite(vitePort, gwPort)
  fact('App Gateway 就绪', true, `网关 :${gateway.port} → vite :${vitePort} / api :${api.port}`)

  // ---------- 1. HTTP 代理 ----------
  const htmlRes = await fetch(`${gateway.url}/`)
  const html = await htmlRes.text()
  const hasEntry = html.includes('/main.js')
  fact(
    'HTTP 代理（iframe 拿到 HTML）',
    htmlRes.ok && hasEntry,
    `GET / → ${htmlRes.status}，含入口脚本=${hasEntry}，长度 ${html.length}B`,
  )

  const healthRes = await fetch(`${gateway.url}/api/health`)
  const health = (await healthRes.json()) as { service?: string }
  fact(
    '/api 路由到后端（不是 vite）',
    healthRes.ok && health.service === 'nest-stand-in',
    `GET /api/health → ${healthRes.status} ${JSON.stringify(health)}`,
  )

  // ---------- 2. HMR WebSocket 握手 ----------
  const messages: HmrMessage[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/`, ['vite-hmr'])
  // 必须在 open 之前挂 message：vite 的 connected 帧可能在 open 回调之前就到了
  ws.on('message', (data: Buffer) => {
    try {
      messages.push(JSON.parse(data.toString()) as HmrMessage)
    } catch {
      messages.push({ type: 'unparsed' })
    }
  })
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000)
    ws.on('open', () => {
      clearTimeout(timer)
      resolve(true)
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  fact('WS 握手经网关上钩', opened, `Sec-WebSocket-Protocol: vite-hmr；协议=${ws.protocol || '(none)'}`)

  // vite 会先发 {"type":"connected"}
  const connectedOk = await waitFor(() => messages.some((m) => m.type === 'connected'), 3000)
  fact('收到 vite connected 帧', connectedOk, `首批帧：${messages.map((m) => m.type).join(',') || '(空)'}`)

  // ---------- 3. 改文件 → 收到 update ----------
  const file = join(APP_ROOT, 'lib', 'counter.js')
  const original = await readFile(file, 'utf8')
  const t0 = performance.now()
  await writeFile(file, original.replace('export const counter = 1', 'export const counter = 2'), 'utf8')
  const updateOk = await waitFor(() => messages.some((m) => m.type === 'update'), 10_000)
  const latency = performance.now() - t0
  const updateMsg = messages.find((m) => m.type === 'update')
  await writeFile(file, original, 'utf8') // 还原，避免污染仓库
  fact(
    '改文件 → HMR update 送达',
    updateOk,
    `耗时 ${latency.toFixed(0)}ms；payload=${JSON.stringify(updateMsg).slice(0, 160)}`,
  )

  // ---------- 4. 上游重启换端口，iframe URL 不变 ----------
  await vite.close()
  const vitePort2 = await reservePort()
  vite = await startVite(vitePort2, gwPort)
  gateway.updateRoute('/', vitePort2)
  const afterRestart = await fetch(`${gateway.url}/`)
  const body2 = await afterRestart.text()
  fact(
    '上游重启换端口，网关 URL 不变',
    afterRestart.ok && body2.includes('/main.js'),
    `vite :${vitePort} → :${vitePort2}，网关仍为 ${gateway.url}，GET / → ${afterRestart.status}`,
  )

  // 重启后 HMR 是否还能重连（新 vite 实例的 ws）
  const ws2 = new WebSocket(`ws://127.0.0.1:${gwPort}/`, ['vite-hmr'])
  const reopened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000)
    ws2.on('open', () => {
      clearTimeout(timer)
      resolve(true)
    })
    ws2.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  fact('重启后 HMR 可在同一网关端口重连', reopened, `second ws open=${reopened}`)
  ws2.close()
  ws.close()

  await vite.close()
  await gateway.close()
  await api.close()

  console.log(`\n网关统计：${JSON.stringify(gateway.stats)}`)
  const failed = facts.filter((f) => !f.ok)
  console.log(`合计 ${facts.length} 项，通过 ${facts.length - failed.length}，失败 ${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise<void>((r) => setTimeout(r, 20))
  }
  return pred()
}

void connect
main().catch((err) => {
  console.error('spike-gateway 失败：', err)
  process.exitCode = 1
})
