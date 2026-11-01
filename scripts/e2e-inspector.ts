/**
 * 精调链路的真机端到端（M3 第 3 步的 DoD）。
 *
 * 为什么要起 Electron：这条链路的每一环都活在浏览器里 ——
 *   Alt 按下 → 命中测试 → 描边 overlay → capture 阶段吃掉 click → 组装上下文
 *   → 跨源 postMessage → 父窗口校验 origin + token → 变成 chip
 * 中间任何一环断了，**页面都照常打开、控制台都不报错**，只有"按住 Alt 点一下没反应"。
 * 所以只能真开一个 Chromium，模拟真实的按键与点击。
 *
 * 结构刻意和线上一致：父页面是**平台源**（本地起的一个小 http 服务），
 * iframe 是**网关源**，两者跨源 —— 这样 `event.origin` 校验才是真的在起作用。
 *
 * 用法：`pnpm e2e:inspector`（首次要联网装 React，几十秒）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../packages/server/src/index.js'
import { harvestInspectorMessage } from '../apps/web/src/lib/selection.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const appDir = join(repo, 'apps', 'desktop')

const require = createRequire(import.meta.url)
/** electron 包的默认导出就是可执行文件路径（只有在 Electron 运行时里才是 API） */
const electronPath = require(join(appDir, 'node_modules', 'electron')) as unknown as string

const TOKEN = 'e2e-inspector-token'
const SERVER_TOKEN = 'e2e-token'
const APP_ID_HASH = '#tenon-inspector='

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface ParentMessage {
  origin: string
  data: unknown
}

const home = await mkdtemp(join(tmpdir(), 'tenon-inspector-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: SERVER_TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: {
    readyTimeoutMs: 5 * 60 * 1000,
    log: (line) => console.log(`  [preview] ${line}`),
  },
})

async function rpc<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVER_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

/** 父页面：模拟平台渲染器（只做两件事：装 iframe、收 message） */
function harnessHtml(gatewayUrl: string, token: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Tenon inspector harness</title></head>
  <body style="margin:0;background:#111">
    <script>
      window.__msgs = [];
      window.addEventListener('message', (event) => {
        window.__msgs.push({ origin: event.origin, data: event.data });
      });
      const frame = document.createElement('iframe');
      frame.id = 'app';
      frame.style.cssText = 'width:960px;height:640px;border:0;background:#fff';
      frame.src = ${JSON.stringify(gatewayUrl)} + ${JSON.stringify(APP_ID_HASH)} + ${JSON.stringify(token)};
      document.body.appendChild(frame);
    </script>
  </body>
</html>`
}

/** 网关地址要等预览就绪后才知道；父页面每次请求现拼 */
let gatewayUrl = ''

const harness = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(harnessHtml(gatewayUrl, TOKEN))
})

/** Electron 主进程脚本：跨源拿子 frame、在子 frame 里模拟 Alt+Click、把父窗口收到的消息带回来 */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')

const parentUrl = process.env.TENON_E2E_PARENT_URL
const gatewayOrigin = process.env.TENON_E2E_GATEWAY_ORIGIN

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function childFrame(win) {
  const deadline = Date.now() + 30000
  for (;;) {
    const frames = win.webContents.mainFrame.frames
    const hit = frames.find((frame) => frame.url.startsWith(gatewayOrigin))
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error('iframe 一直没加载出来：' + frames.map((f) => f.url).join(', '))
    await sleep(120)
  }
}

async function ready(frame) {
  const deadline = Date.now() + 30000
  for (;;) {
    const ok = await frame.executeJavaScript('document.querySelector("h1") !== null')
    if (ok === true) return
    if (Date.now() > deadline) throw new Error('iframe 里没渲染出 h1')
    await sleep(120)
  }
}

async function installed(frame) {
  const deadline = Date.now() + 20000
  for (;;) {
    const count = await frame.executeJavaScript(
      'document.querySelectorAll("[data-tenon-inspector]").length',
    )
    if (count > 0) return count
    if (Date.now() > deadline) throw new Error('inspector 一直没装上（overlay 节点数为 0）')
    await sleep(100)
  }
}

async function run() {
  const logs = []
  const win = new BrowserWindow({ show: false, width: 1100, height: 800 })
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first !== null && typeof first === 'object' && 'message' in first) logs.push(String(first.message))
    else logs.push(String(args[2]))
  })
  await win.loadURL(parentUrl)
  const frame = await childFrame(win)
  await ready(frame)

  // 0) 诊断：inspector 到底装上了没有（这三条先确认，再看点击）
  const diag = await frame.executeJavaScript(\`({
    hash: location.hash,
    overlayCount: document.querySelectorAll('[data-tenon-inspector]').length,
    hasH1: document.querySelector('h1') !== null,
  })\`)

  // 0.5) 等 inspector 装好。main.tsx 里是**动态 import**（生产构建要靠它被摇掉），
  // 所以首屏渲染出 h1 之后它还要几十毫秒才落地。真实用户不可能这么快按下 Alt，
  // 但测试会 —— 不等就会得到"点了没反应"，看起来像功能坏了。
  await installed(frame)

  // 1) 正常路径：Alt 按下 → 在 h1 上 Alt+Click
  const clicked = await frame.executeJavaScript(\`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }))
    const target = document.querySelector('h1')
    if (target === null) return 'no-h1'
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true, clientX: 40, clientY: 40 }))
    return 'clicked'
  })()\`)

  // 2) 负样例：token 错的页面也在往父窗口发消息，父窗口必须把它判掉
  await frame.executeJavaScript(\`(() => {
    window.parent.postMessage({ source: 'tenon-inspector', token: 'wrong-token', context: { kind: 'element' } }, '*')
    return true
  })()\`)

  await sleep(400)
  const cursor = await frame.executeJavaScript('document.body.style.cursor')
  const raw = await win.webContents.mainFrame.executeJavaScript('JSON.stringify(window.__msgs)')

  process.stdout.write('TENON_INSPECTOR_RESULT ' + JSON.stringify({
    clicked,
    frameUrl: frame.url,
    diag,
    consoleLogs: logs,
    cursorAfterAlt: cursor,
    messages: JSON.parse(raw),
  }) + '\\n')

  app.exit(0)
}

app.whenReady().then(run).catch((error) => {
  process.stdout.write('TENON_INSPECTOR_ERROR ' + String(error && error.message || error) + '\\n')
  app.exit(1)
})
`
}

async function runElectron(dir: string, parentUrl: string, gatewayOrigin: string): Promise<string> {
  const mainPath = join(dir, 'main.cjs')
  await writeFile(mainPath, electronMain(), 'utf8')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TENON_E2E_PARENT_URL: parentUrl,
    TENON_E2E_GATEWAY_ORIGIN: gatewayOrigin,
  }
  // 与 smoke:desktop 同一个坑：带着它 `electron` 会被当成 node 跑
  delete env['ELECTRON_RUN_AS_NODE']

  /*
   * `--no-sandbox`：Chromium 的沙箱需要 clone/namespace 权限，在被收窄的 shell 沙箱里
   * 会 `sandbox initialization failed: Operation not permitted` → network service 崩溃
   * → 打开本地页面直接 ERR_FAILED。报错文案里完全没有"沙箱"两个字，看着像服务没起。
   *
   * 关了不影响这条链路要验的东西：Alt 命中、overlay 绘制、capture 阶段吃掉 click、
   * 跨源 postMessage 与父窗口校验，全在渲染进程里，与进程隔离无关。
   */
  const child = spawn(electronPath, ['--no-sandbox', mainPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 120_000)
    child.on('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })

  if (stdout.includes('TENON_INSPECTOR_ERROR')) {
    throw new Error(stdout.trim())
  }
  if (code !== 0) {
    throw new Error(`Electron 退出码 ${String(code)}\n${stdout}\n${stderr}`)
  }
  const line = stdout.split('\n').find((item) => item.startsWith('TENON_INSPECTOR_RESULT '))
  if (line === undefined) throw new Error(`没拿到结果行：\n${stdout}\n${stderr}`)
  return line.slice('TENON_INSPECTOR_RESULT '.length)
}

try {
  console.log('1) 建应用 + 起预览')
  const created = await rpc<{ app: { id: string; slug: string } }>('app.create', { name: '精调 E2E' })
  await rpc('preview.start', { appId: created.app.id })
  const ready = await server.preview.waitReady(created.app.id, 5 * 60 * 1000)
  if (ready.state !== 'ready' || ready.url === null) {
    throw new Error(`预览没就绪：${ready.error ?? '未知原因'}`)
  }
  gatewayUrl = ready.url
  const gatewayOrigin = new URL(gatewayUrl).origin
  console.log(`  网关 ${gatewayUrl}`)

  console.log('\n2) 起父页面（另一个源）+ Electron，模拟 Alt+Click')
  await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve))
  const address = harness.address()
  if (address === null || typeof address === 'string') throw new Error('父页面服务没起来')
  const parentUrl = `http://127.0.0.1:${String(address.port)}/`
  console.log(`  父页面 ${parentUrl}（与网关不同源）`)

  const raw = await runElectron(home, parentUrl, gatewayOrigin)
  const result = JSON.parse(raw) as {
    clicked: string
    frameUrl: string
    diag: { hash: string; overlayCount: number; hasH1: boolean }
    consoleLogs: string[]
    cursorAfterAlt: string
    messages: ParentMessage[]
  }

  if (process.argv.includes('--verbose')) {
    console.log(`  诊断 ${JSON.stringify(result.diag)} cursor=${result.cursorAfterAlt}`)
  }

  check('iframe 真的加载了生成的应用', result.frameUrl.startsWith(gatewayOrigin), result.frameUrl)
  check('Alt+Click 在页面里被发出去了', result.clicked === 'clicked', result.clicked)

  const inspectorMessages = result.messages.filter(
    (message) =>
      typeof message.data === 'object' &&
      message.data !== null &&
      (message.data as { source?: unknown }).source === 'tenon-inspector',
  )
  check(
    '父窗口收到了 inspector 的消息',
    inspectorMessages.length >= 2,
    `收到 ${String(result.messages.length)} 条；诊断 ${JSON.stringify(result.diag)} cursor=${result.cursorAfterAlt}`,
  )

  const genuine = inspectorMessages.find(
    (message) => (message.data as { token?: unknown }).token === TOKEN,
  )
  check('真消息带着这次 iframe 的 token', genuine !== undefined)

  const forged = inspectorMessages.find(
    (message) => (message.data as { token?: unknown }).token === 'wrong-token',
  )
  check('负样例（错 token）确实也发到了父窗口 —— 说明下面的校验不是空转', forged !== undefined)

  if (genuine !== undefined) {
    check('消息的 origin 是网关源（跨源是真的）', genuine.origin === gatewayOrigin, genuine.origin)

    // ★ 用平台侧真正的校验函数过一遍：真浏览器发来的真消息，必须被真校验认
    const context = harvestInspectorMessage({
      data: genuine.data,
      eventOrigin: genuine.origin,
      expectedOrigin: gatewayOrigin,
      expectedToken: TOKEN,
    })
    check('平台侧校验通过（origin + source + token 三道）', context !== undefined)
    check('定位到了源文件', context?.loc?.file === 'src/App.tsx', JSON.stringify(context?.loc))
    check('行号/列号是正数', (context?.loc?.line ?? 0) > 0 && (context?.loc?.column ?? 0) > 0)
    check('带上了元素文本', (context?.text ?? '').includes('精调 E2E'), context?.text ?? '(空)')
    check('带上了尺寸（overlay 量过真实布局）', (context?.rect?.width ?? 0) > 0, JSON.stringify(context?.rect))
    check('带了视口信息', context?.viewport !== undefined, JSON.stringify(context?.viewport))

    const rejected = harvestInspectorMessage({
      data: forged?.data,
      eventOrigin: forged?.origin ?? '',
      expectedOrigin: gatewayOrigin,
      expectedToken: TOKEN,
    })
    check('错 token 的消息被校验拒掉', rejected === undefined)
  }
} finally {
  harness.close()
  await server.close()
  await rm(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${String(failures)} 项失败\n`)
process.exit(failures === 0 ? 0 : 1)
