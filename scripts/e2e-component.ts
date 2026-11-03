/**
 * 组件的真机端到端（M5 第 8 步 / DoD ①③）。
 *
 * 前面几步把每一层都单独验过了：契约、宿主装载、网关注入、WS 链路、装/卸/开关。
 * 但它们**没有一次是在真浏览器里连起来跑的** —— 于是有四件事至今只是"应该能行"：
 *
 * 1. 装好的组件真的会出现在页面上（注入时机对：页面在跑的时候插脚本）；
 * 2. 点得开、能聊一句（DOM → chord → server facet → 注入的模型能力 → 回到 DOM）；
 * 3. **热重载之后对话还在**（DoD ③：状态在服务端对象上，页面 HMR 不该抹掉它）；
 * 4. 组件脚本不会重复挂（HMR 会重跑模块，重复挂就是两个球）。
 *
 * 所以这里起 Electron + 真 Chromium，走完整条路。用法：`pnpm e2e:component`（首次联网装 React）。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appPaths, resolveHome } from '../packages/core/src/index.js'
import { startServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'e2e-component-token'
const COMPONENT = 'tenon.official.ai-assistant'
const BALL = `[data-tenon-component="${COMPONENT}"]`

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

const home = await mkdtemp(join(tmpdir(), 'tenon-component-e2e-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: { readyTimeoutMs: 5 * 60 * 1000, log: (line) => console.log(`  [preview] ${line}`) },
})

async function rpc<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

/** Electron 主进程：在真 Chromium 里跑完四个断言，把结果打到 stdout */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = process.env.TENON_E2E_URL
const ball = ${JSON.stringify(BALL)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(frame, script, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const ok = await frame.executeJavaScript(script).catch(() => false)
    if (ok === true) return true
    if (Date.now() > deadline) throw new Error('等不到：' + label)
    await sleep(120)
  }
}

const logs = []

async function run() {
  const out = {}
  const win = new BrowserWindow({ show: false, width: 1100, height: 820 })
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first !== null && typeof first === 'object' && 'message' in first) logs.push(String(first.message))
    else logs.push(String(args[2]))
  })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)

  // ① 应用自己先渲染出来（否则后面的"球在"没有意义）
  await waitFor(frame, 'document.querySelector("h1") !== null', '应用首屏')
  out.hasApp = true

  // ② 球出现了 —— 注入时机对（页面已经在跑的时候插的脚本）
  await waitFor(frame, 'document.querySelector("' + ball + '") !== null', '组件脚本注入')
  out.ballCount = await frame.executeJavaScript('document.querySelectorAll("' + ball + '").length')

  // ③ 点开面板 → 输入 → 发送
  await frame.executeJavaScript('document.querySelector("' + ball + '").click()')
  await waitFor(frame, 'document.querySelectorAll("textarea").length > 0', '面板打开')
  await frame.executeJavaScript(
    '(() => { const t = document.querySelector("textarea"); t.value = "介绍一下你自己"; t.dispatchEvent(new Event("input", { bubbles: true })); return true })()',
  )
  await frame.executeJavaScript(
    '(() => { const buttons = [...document.querySelectorAll("button")]; const send = buttons.find((b) => b.textContent === "发送"); send.click(); return true })()',
  )
  await waitFor(frame, 'document.querySelectorAll("[data-tenon-message]").length >= 2', '两条气泡', 60000)
  const messages = await frame.executeJavaScript(
    '[...document.querySelectorAll("[data-tenon-message]")].map((n) => ({ role: n.getAttribute("data-tenon-message"), text: n.textContent }))',
  )
  out.messages = messages
  out.beforeReload = messages.length

  // ④ 热重载：改一行应用代码，等 HMR 把新文案推到页面上
  out.hmr = await (async () => {
    const changed = await frame.executeJavaScript('document.querySelector("h1").textContent')
    return { changed }
  })()
  win.__marker = true
  await win.webContents.executeJavaScript('window.__before = document.querySelectorAll("[data-tenon-message]").length')

  // 主进程会在这之后收到"改文案"的信号，再由外面 reload 页面
  process.stdout.write('READY_FOR_EDIT\\n')
  await new Promise((resolve) => process.stdin.once('data', resolve))

  await waitFor(frame, 'document.body.innerText.includes("热重载之后")', 'HMR 生效', 60000)
  out.hmrApplied = true

  // ⑤ 球还在、而且只有一个（HMR 会重跑模块，重复挂就会有两个球）
  out.ballAfterHmr = await frame.executeJavaScript('document.querySelectorAll("' + ball + '").length')

  // ⑥ 刷新整页之后对话还在（状态在服务端对象上，不在 DOM 里）
  await win.webContents.reload()
  await waitFor(frame, 'document.querySelector("' + ball + '") !== null', '刷新后组件重新注入')
  await frame.executeJavaScript('document.querySelector("' + ball + '").click()')
  await waitFor(frame, 'document.querySelectorAll("[data-tenon-message]").length >= 2', '刷新后对话还在', 30000)
  out.afterReload = await frame.executeJavaScript('document.querySelectorAll("[data-tenon-message]").length')
  out.logs = logs.slice(-5)
  await win.close()
  return out
}

app.whenReady().then(async () => {
  try {
    const result = await run()
    process.stdout.write('E2E_RESULT ' + JSON.stringify(result) + '\\n')
  } catch (error) {
    process.stdout.write('E2E_ERROR ' + JSON.stringify(String(error && error.message ? error.message : error)) + '\\n')
  } finally {
    app.exit(0)
  }
})
`
}

try {
  console.log('1) 建应用 + 装组件（写装配声明）')
  const created = await rpc<{ app: { id: string } }>('app.create', { name: '组件 E2E' })
  const appId = created.app.id
  const repoDir = appPaths(resolveHome({ TENON_HOME: home }), appId).repoDir
  await writeFile(
    join(repoDir, 'app.components.json'),
    `${JSON.stringify(
      {
        version: 1,
        components: [
          {
            id: COMPONENT,
            version: '^1.0.0',
            license: 'free',
            enabled: true,
            mount: [{ slot: 'app.shell.overlay', order: 100 }],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log('2) 起预览（首次要联网装 React，几十秒）')
  await rpc('preview.start', { appId })
  const ready = await server.preview.waitReady(appId, 5 * 60 * 1000)
  if (ready.state !== 'ready' || ready.url === null) throw new Error(`预览没就绪：${ready.error ?? '未知原因'}`)
  console.log(`  网关 ${ready.url}\n`)

  // 诊断：注入与脚本端点（出问题时这两条最能说明"是谁没干活"）
  const html = await (await fetch(ready.url)).text()
  const scriptRes = await fetch(`${ready.url}/__tenon/component.js?appId=${appId}`)
  const scriptBody = await scriptRes.text()
  console.log(
    `  注入脚本标签：${html.includes('/__tenon/component.js') ? '有' : '没有'}；端点 ${scriptRes.status} ${scriptRes.headers.get('content-type')}；头 40 字：${JSON.stringify(scriptBody.slice(0, 40))}`,
  )

  console.log('3) Electron + 真 Chromium：点球 → 聊天 → 热重载 → 刷新')
  const mainFile = join(home, 'electron-main.cjs')
  await writeFile(mainFile, electronMain(), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env, TENON_E2E_URL: ready.url }
  // 与 smoke:desktop / e2e:inspector 同一个坑：带着它 electron 会被当成 node 跑
  delete env['ELECTRON_RUN_AS_NODE']
  /*
   * `--no-sandbox`：Chromium 沙箱在被收窄的 shell 沙箱里会初始化失败，接着 network service
   * 崩溃，打开本地页面直接 ERR_FAILED —— 报错里完全没有"沙箱"两个字，看着像服务没起。
   * 这条链路要验的东西全在渲染进程里，与进程隔离无关。
   */
  const child = spawn(electronPath, ['--no-sandbox', mainFile], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stdout += text
    if (text.includes('READY_FOR_EDIT')) {
      // 改一行文案，让 Vite HMR 推一次更新
      const page = join(repoDir, 'src', 'App.tsx')
      void readFile(page, 'utf8').then(async (source) => {
        const next = source.replace(/<h1([^>]*)>([^<]*)<\/h1>/, '<h1$1>热重载之后$2</h1>')
        await writeFile(page, next === source ? `${source}\n// hot reload marker\n` : next, 'utf8')
        child.stdin.write('go\n')
      })
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (!text.includes('DevTools') && !text.includes('Warning')) process.stderr.write(`  [electron] ${text}`)
  })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 180_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const line = stdout.split('\n').find((item) => item.startsWith('E2E_RESULT '))
  if (line === undefined) {
    const error = stdout.split('\n').find((item) => item.startsWith('E2E_ERROR '))
    throw new Error(`Electron 没跑完：${error ?? stdout.slice(-800)}`)
  }
  const result = JSON.parse(line.slice('E2E_RESULT '.length)) as {
    ballCount: number
    messages: { role: string; text: string }[]
    ballAfterHmr: number
    afterReload: number
    logs: string[]
  }

  check('应用首屏渲染出来了', result.ballCount !== undefined)
  check('组件脚本被注入，且页面上只有一个球', result.ballCount === 1, `球数 = ${result.ballCount}`)
  check(
    '问一句能得到回答（两条气泡，回答非空）',
    result.messages.length >= 2 && result.messages[1]?.text.trim() !== '',
    JSON.stringify(result.messages),
  )
  check('热重载之后球还在、且没有重复挂', result.ballAfterHmr === 1, `球数 = ${result.ballAfterHmr}`)
  check('刷新整页之后对话还在（DoD ③：状态在服务端）', result.afterReload >= 2, `气泡数 = ${result.afterReload}`)
} catch (error) {
  failures += 1
  console.log(`\n✗ 失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.close()
  await rm(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
