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
/** 容器（root）：用来数"挂了几个" */
const BALL = `[data-tenon-component="${COMPONENT}"]`
/**
 * 球本身。
 *
 * 不能直接点 `BALL`：那个属性在容器上，点容器不会打开面板 —— 而按容器找元素
 * 再 `.click()` 恰好能"跑通"（随后去找隐藏的 textarea 与按钮，点击对可见性不敏感），
 * 于是这条断言长期是假阳性。组件现在显式标了 `data-tenon-open`。
 */
const OPEN = '[data-tenon-open]'

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

/*
 * 语言钉成中文，与另外几个 e2e 一致。
 *
 * 这条链路里的断言大多按文案找元素（"发送"按钮）。语言若跟着本机环境漂，
 * 同一份测试在不同机器上会绿/红两种结果 —— 而红的理由与组件无关。
 * 语言**能不能变**由最后两条断言单独验（它们主动发一条切换消息）。
 *
 * 走 `settings.set` 而不是直接 `setLocale()`：`startServer` 在没有设置时
 * **显式写回英文**（避免上一个服务实例的语言漏进来），进程里先设会被它覆盖 ——
 * 我第一版就是这么错的，症状是"找不到『发送』按钮"。
 */

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

// 见上面那段注释：语言必须在服务起来之后、走真实设置接口设
await rpc('settings.set', { values: { 'ui.locale': 'zh' } })

/** Electron 主进程：在真 Chromium 里跑完全部断言，把结果打到 stdout */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = process.env.TENON_E2E_URL
const ball = ${JSON.stringify(BALL)}
const open = ${JSON.stringify(OPEN)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function componentErrors(frame) {
  return await frame
    .executeJavaScript('JSON.stringify([...new Set(window.__tenonComponentErrors || [])].slice(0, 5))')
    .catch(() => '"<读不到>"')
}

async function waitFor(frame, script, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const ok = await frame.executeJavaScript(script).catch(() => false)
    if (ok === true) return true
    if (Date.now() > deadline) {
      throw new Error('等不到：' + label + ' | 页面里的组件错误：' + (await componentErrors(frame)))
    }
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
  await waitFor(frame, 'document.querySelector(' + JSON.stringify(ball) + ') !== null', '组件脚本注入')
  out.ballCount = await frame.executeJavaScript('document.querySelectorAll(' + JSON.stringify(ball) + ').length')

  // ③ 点开面板 → 输入 → 发送
  await frame.executeJavaScript('document.querySelector(' + JSON.stringify(open) + ').click()')
  // 真的可见（offsetParent 为 null 说明它或祖先还是 display:none）
  await waitFor(
    frame,
    '(() => { const t = document.querySelector("textarea"); return t !== null && t.offsetParent !== null })()',
    '面板打开',
  )
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
  out.ballAfterHmr = await frame.executeJavaScript('document.querySelectorAll(' + JSON.stringify(ball) + ').length')

  // ⑥ 刷新整页之后对话还在（状态在服务端对象上，不在 DOM 里）
  /*
   * ★ 必须等新文档真的加载完。reload() 是异步的，而 waitFor(球) 会在旧文档上
   * 立刻通过（旧文档的球还在、DOM 也还在）—— 于是后面的"刷新后对话还在""切语言"
   * 全都在**正要卸载的旧文档**里跑：断言是绿的，但什么都没验到，而且
   * postMessage 在这时会被丢弃（消息投给一个即将消失的 window）。
   * 判据只能用导航事件，不能用 readyState（旧文档也是 complete）。
   */
  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  await win.webContents.reload()
  await loaded
  await waitFor(frame, 'document.querySelector(' + JSON.stringify(ball) + ') !== null', '刷新后组件重新注入')
  await frame.executeJavaScript('document.querySelector(' + JSON.stringify(open) + ').click()')
  await waitFor(frame, 'document.querySelectorAll("[data-tenon-message]").length >= 2', '刷新后对话还在', 30000)
  out.afterReload = await frame.executeJavaScript('document.querySelectorAll("[data-tenon-message]").length')

  /*
   * ⑦ 语言。两件事分开验：
   * - 刷新后重新注入的那份 HTML 带的是**服务端语言**（zh），首屏就该是中文；
   * - 收到父页面的切换消息后，球与输入框立刻改口（不重载 iframe）。
   *
   * 这里自己给自己发一条 message：真界面上是 Tenon 的预览面板在发（跨源，
   * 走的是同一条监听），组件这一侧分不出差别。
   */
  out.titleOnLoad = await frame.executeJavaScript(
    'document.querySelector(' + JSON.stringify(open) + ').getAttribute("title")',
  )
  await frame.executeJavaScript('window.postMessage({ type: "tenon:locale", locale: "en" }, "*")')
  await sleep(120)
  out.localeAfterSwitch = await frame.executeJavaScript('window.__tenonLocale')
  out.titleAfterSwitch = await frame.executeJavaScript(
    'document.querySelector(' + JSON.stringify(open) + ').getAttribute("title")',
  )
  out.placeholderAfterSwitch = await frame.executeJavaScript(
    'document.querySelector("textarea")?.getAttribute("placeholder")',
  )
  out.placeholderAfterSwitch = await frame.executeJavaScript(
    'document.querySelector("textarea")?.getAttribute("placeholder")',
  )

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
  // 语言走同一段注入脚本，出问题时这条最能说明"是注入错了还是组件没读"
  console.log(`  注入的语言：${/__tenonLocale="(\w+)"/.exec(html)?.[1] ?? '(没有)'}`)
  const catcher = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  console.log(
    `  catcher ${catcher.length} 字；有 message 监听：${catcher.includes("addEventListener('message'")}；片段：${JSON.stringify(catcher.slice(0, 140))}`,
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
    titleOnLoad: string | null
    localeAfterSwitch: string | null
    titleAfterSwitch: string | null
    placeholderAfterSwitch: string | null
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
  check(
    '注入时就带上了语言（首屏中文，不用再发一次请求）',
    result.titleOnLoad === '打开 AI 小助手',
    `title = ${JSON.stringify(result.titleOnLoad)}`,
  )
  check(
    '切语言后组件改口（postMessage，不重载 iframe）',
    result.titleAfterSwitch === 'Open the AI assistant' &&
      result.placeholderAfterSwitch === 'Ask something…',
    `title = ${JSON.stringify(result.titleAfterSwitch)} / 全局 = ${JSON.stringify(result.localeAfterSwitch)} / placeholder = ${JSON.stringify(result.placeholderAfterSwitch)}`,
  )
} catch (error) {
  failures += 1
  console.log(`\n✗ 失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.close()
  await rm(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
