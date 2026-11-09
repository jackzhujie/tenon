/**
 * 「加登录」的人眼验收：登录页长什么样、登录后那条账号栏在不在、成员浮层能不能开。
 *
 * 为什么必须看：`e2e:auth` 验的是接口（401/403/409/cookie），它**不执行页面里的 JS** ——
 * AuthGate 里一个写错的 import、一个 `undefined.map`，接口照样全绿，用户看到的是白屏。
 * 而白屏恰恰是"给应用加登录"最容易出的事故。
 *
 * 用法：`pnpm shot:auth`（截图落在 /tmp/tenon-auth/*.png）
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'shot-auth-token'
const outDir = '/tmp/tenon-auth'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-auth-'))
const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: { readyTimeoutMs: 10 * 60 * 1000, apiReadyTimeoutMs: 5 * 60 * 1000 },
})

async function rpc<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { ok: boolean; data?: T; error?: unknown }
  if (!payload.ok) throw new Error(`${method}: ${JSON.stringify(payload.error)}`)
  return payload.data as T
}

console.log('1) 建应用 → 加登录 → 起预览')
const created = await rpc<{ app: { id: string } }>('app.create', { name: '花名册' })
const appId = created.app.id
await rpc('app.addAuth', { id: appId, installDeps: true })
await rpc('preview.start', { appId })
const ready = await server.preview.waitReady(appId, 10 * 60 * 1000)
if (ready.state !== 'ready') throw new Error(`预览没就绪：${ready.error ?? '未知'}`)
const url = ready.url as string
console.log(`   ${url}`)

/* ---------- Electron 侧：加载页面、填表、截图 ---------- */

const main = `const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const url = ${JSON.stringify(url)}
const out = ${JSON.stringify(outDir)}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logs = []

async function shot(win, name) {
  const img = await win.capturePage()
  fs.writeFileSync(out + '/' + name + '.png', img.toPNG())
}

async function waitFor(win, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await win.webContents.mainFrame.executeJavaScript(expression)) return true
    await sleep(300)
  }
  return false
}

async function run() {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800 })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) logs.push(String(message).slice(0, 300))
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logs.push('RENDERER GONE: ' + JSON.stringify(details))
  })

  await win.loadURL(url)
  /* Vite 首次编译 + AuthGate 打一次 /api/auth/status */
  const loginReady = await waitFor(win, "Boolean(document.querySelector('form.auth-card'))", 60000)
  await sleep(600)
  await shot(win, '1-登录页')

  const filled = await win.webContents.mainFrame.executeJavaScript(\`(() => {
    const inputs = [...document.querySelectorAll('form.auth-card input')]
    if (inputs.length < 3) return 'inputs=' + inputs.length
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(inputs[0], 'boss@example.com')
    set(inputs[1], 'correct-horse-9')
    set(inputs[2], 'correct-horse-9')
    document.querySelector('form.auth-card').requestSubmit()
    return 'ok'
  })()\`)

  const loggedIn = await waitFor(win, "Boolean(document.querySelector('.auth-bar'))", 30000)
  await sleep(800)
  await shot(win, '2-登录后')

  let panel = false
  if (loggedIn) {
    await win.webContents.mainFrame.executeJavaScript(\`(() => {
      const button = [...document.querySelectorAll('.auth-bar button')].find((n) => n.textContent.trim() === '成员')
      if (button) button.click()
      return Boolean(button)
    })()\`)
    panel = await waitFor(win, "Boolean(document.querySelector('.auth-panel'))", 10000)
    if (panel) await sleep(700)
    if (panel) await shot(win, '3-成员浮层')
  }

  console.log('AUTHSHOT ' + JSON.stringify({ loginReady, filled, loggedIn, panel, logs }))
  win.close()
  app.exit(0)
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (error) {
    process.stdout.write('AUTHSHOT ' + JSON.stringify({ error: String((error && error.message) || error), logs }) + '\\n')
    app.exit(1)
  }
})
`

const mainFile = join(home, 'shot-auth.cjs')
await writeFile(mainFile, main, 'utf8')

const code = await new Promise<number>((resolve) => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // 从 tsx 里 spawn Electron 时必须删掉：这个变量会让 Electron 退化成 Node，渲染器起不来
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['--no-sandbox', mainFile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  child.stderr.on('data', () => undefined)
  const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
  child.on('exit', (exitCode) => {
    clearTimeout(timer)
    // 子进程里我们只认带前缀的那一行（Electron 自己也会往 stdout 写东西）
    const lines = out.split('\n')
    let line = '(没拿到结果)'
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index] ?? ''
      if (candidate.startsWith('AUTHSHOT ')) {
        line = candidate.slice('AUTHSHOT '.length)
        break
      }
    }
    console.log(line)
    resolve(exitCode ?? 1)
  })
})

await server.close().catch(() => undefined)
await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => undefined)

console.log(`\n截图在 ${outDir}；electron 退出码 ${code}`)
process.exit(code)
