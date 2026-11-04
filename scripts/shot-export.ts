/**
 * 一次性人眼验收：发布对话框里的「导出静态包」按钮。
 *
 * 为什么要有这个（而不是只跑 RPC 层）：这一轮修的就是"后端有、前端没有"的坑，
 * 所以新加的入口必须自己也在界面上被点过一次。跑完看 /tmp/tenon-export-ui/*.png。
 *
 * 用法：`pnpm build:web && npx tsx scripts/shot-export.ts`
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, type RunningServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'shot-export-token'
const outDir = '/tmp/tenon-export-ui'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-export-'))
const server: RunningServer = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: { installDeps: false },
  webDir: join(repo, 'apps', 'web', 'dist'),
})

async function rpc<T>(method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: { message?: string } }
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.message ?? '?'}`)
  return body.data as T
}

function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(frame, script, label, timeout = 240000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const ok = await frame.executeJavaScript(script).catch(() => false)
    if (ok === true) return true
    if (Date.now() > deadline) throw new Error('等不到：' + label)
    await sleep(500)
  }
}

async function run() {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await waitFor(frame, 'document.querySelector("header") !== null && !document.body.innerText.includes("正在连接")', '界面就绪')

  // 打开发布对话框
  await frame.executeJavaScript('(() => { const b = [...document.querySelectorAll("header button")].find((n) => (n.textContent || "").trim().indexOf("发布") === 0); if (!b) return false; b.click(); return true })()')
  await waitFor(frame, 'document.querySelector("[data-tenon-action=export-static]") !== null', '对话框打开')
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/1-对话框.png', img.toPNG()))

  // 点导出
  const clicked = await frame.executeJavaScript('(() => { const b = document.querySelector("[data-tenon-action=export-static]"); if (!b) return false; b.click(); return true })()')
  await sleep(1200)
  const during = await frame.executeJavaScript('(() => { const b = document.querySelector("[data-tenon-action=export-static]"); return b ? b.textContent.trim() : null })()')
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/2-导出中.png', img.toPNG()))

  // 等结果出来（会真跑一次构建）
  let done = true
  try {
    await waitFor(frame, 'document.querySelector("[data-tenon-export-result]") !== null', '导出结果', 240000)
  } catch {
    done = false
  }
  const block = await frame.executeJavaScript('(() => { const n = document.querySelector("[data-tenon-export-result]"); return n ? n.innerText.trim() : null })()')
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/3-导出完成.png', img.toPNG()))
  await win.close()
  return { clicked, during, done, block }
}

app.whenReady().then(async () => {
  try {
    process.stdout.write('SHOT ' + JSON.stringify(await run()) + '\\n')
  } catch (error) {
    process.stdout.write('SHOT_ERR ' + JSON.stringify(String((error && error.message) || error)) + '\\n')
  } finally {
    app.exit(0)
  }
})
`
}

let ok = false
try {
  const created = await rpc<{ app: { id: string } }>('app.create', { name: '导出界面验收', templateId: 'react-vite' })
  console.log(`应用 ${created.app.id}`)

  const mainFile = join(home, 'shot-main.cjs')
  await writeFile(mainFile, electronMain(), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['--no-sandbox', mainFile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString()
    if (!line.includes('DevTools')) process.stderr.write(`  [electron] ${line}`)
  })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 300_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const err = /SHOT_ERR (.*)/.exec(stdout)
  if (err?.[1] !== undefined) throw new Error(JSON.parse(err[1]) as string)
  const matched = /SHOT (\{.*\})/.exec(stdout)
  if (matched?.[1] === undefined) throw new Error(`没吐出结果：${stdout.slice(-500)}`)
  const result = JSON.parse(matched[1]) as {
    clicked: boolean
    during: string | null
    done: boolean
    block: string | null
  }
  console.log(`按钮点得动：${result.clicked}`)
  console.log(`导出中显示：${result.during}`)
  console.log(`出结果了：${result.done}`)
  console.log(`结果块：${result.block ?? '（空）'}`)
  console.log(`截图在 ${outDir}`)
  ok = result.clicked && result.done
} finally {
  await server.close().catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

process.exit(ok ? 0 : 1)
