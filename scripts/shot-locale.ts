/**
 * 界面语言的**人眼验收**：切得动、记得住、英文界面里不夹中文。
 *
 * 为什么必须看：这三件事单测一个字都答不了 ——
 * 1. "首屏就定了语言"靠的是 `main.tsx` 先 await `settings.get` 再 render，
 *    异步顺序错了只有真跑起来才看得见（会先闪一屏中文）。
 * 2. "切换记得住"要跨**窗口重载**才能验：内存里改了不算数，要落进 `settings` 再读回来。
 * 3. "不夹中文"是**全页面普查**，不是逐条核对 —— 我们不知道哪一处漏了，
 *    只能把渲染出来的文本全扫一遍找 CJK。
 *
 * 做法：先在服务端把语言写成中文 → 开窗截一张 → 点顶栏按钮 → 再截一张
 * → 重载窗口 → 第三张（应当仍是英文）。每一步都把页面上所有可见文本扫一遍 CJK，
 * 最后从服务端把 `ui.locale` 读回来核对"是不是真存住了"。
 *
 * 用法：`pnpm shot:locale`（先 `pnpm build:web`；截图落在 /tmp/tenon-locale/*.png）
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'shot-locale-token'
const outDir = '/tmp/tenon-locale'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-locale-'))
const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  webDir: join(repo, 'apps', 'web', 'dist'),
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

/*
 * 应用名用**纯 ASCII**：这一趟要扫"页面上有没有中文"，而用户起的名字本来就可以是中文。
 * 用一个中文应用名，扫出来的每一条都会是它自己造成的假阳性。
 */
console.log('1) 建应用')
await rpc('app.create', { name: 'Invoice Approvals' })

console.log('2) 服务端把语言设成中文')
await rpc('settings.set', { values: { 'ui.locale': 'zh' } })

function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
app.disableHardwareAcceleration()
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/' + name + '.png', img.toPNG()))
}

/*
 * 页面上所有可见文本里的 CJK。只看可见节点的 textContent —— 隐藏的面板、
 * 还没渲染的分支都不算用户看到的东西。属性里的文案（title / placeholder /
 * aria-label）同样摆在脸上，一并扫。
 *
 * 两类**故意**的中文要跳过（注意：这段注释在模板字符串里，不能出现反引号）：
 * - [data-brand]：品牌字（榫 = Tenon 的榫卯隐喻），不是文案
 * - [data-locale-toggle]：语言按钮上写的是"切过去会看到什么"，中文界面上就该是「中」
 */
const SCAN = \`(() => {
  const cjk = /[\\\\u4e00-\\\\u9fff]/
  const SKIP = '[data-brand], [data-locale-toggle]'
  const hits = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const text = (node.textContent || '').trim()
    if (!text || !cjk.test(text)) continue
    const el = node.parentElement
    if (!el) continue
    if (el.closest(SKIP)) continue
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
    hits.push(text.slice(0, 60))
  }
  for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    if (el.closest(SKIP)) continue
    for (const name of ['title', 'placeholder', 'aria-label']) {
      const value = el.getAttribute(name)
      if (value && cjk.test(value)) hits.push(name + ': ' + value.slice(0, 60))
    }
  }
  return [...new Set(hits)].slice(0, 40)
})()\`

async function body(win) {
  return win.webContents.mainFrame.executeJavaScript('document.body.innerText.slice(0, 400)')
}

/** 顶栏那个语言按钮：写的是"切过去会看到什么" */
async function clickToggle(win) {
  return win.webContents.mainFrame.executeJavaScript(\`(() => {
    for (const b of document.querySelectorAll('button')) {
      const text = (b.textContent || '').trim()
      if (text === 'EN' || text === '中') { b.click(); return text }
    }
    return null
  })()\`)
}

async function run() {
  const report = []
  const win = new BrowserWindow({ show: false, width: 1180, height: 860 })
  const frame = win.webContents.mainFrame

  await win.loadURL(url)
  await sleep(2200)
  await shot(win, '1-中文')
  report.push({ step: 'zh', text: await body(win), cjk: await frame.executeJavaScript(SCAN) })

  const clicked = await clickToggle(win)
  await sleep(700)
  await shot(win, '2-切到英文')
  report.push({ step: 'clicked:' + clicked, text: await body(win), cjk: await frame.executeJavaScript(SCAN) })

  // 跨重载：内存里改了不算数，要服务端存住了才算
  await win.webContents.reload()
  await sleep(2400)
  await shot(win, '3-重载后')
  report.push({ step: 'reload', text: await body(win), cjk: await frame.executeJavaScript(SCAN) })

  require('node:fs').writeFileSync(out + '/report.json', JSON.stringify(report, null, 2))
  win.destroy()
  app.quit()
}

app.whenReady().then(run).catch((err) => {
  require('node:fs').writeFileSync(out + '/error.txt', String((err && err.stack) || err))
  app.quit()
})
`
}

const mainPath = join(outDir, 'main.cjs')
await writeFile(mainPath, electronMain(), 'utf8')

console.log('3) 开窗验收')
/*
 * `--no-sandbox` / `--disable-gpu`：截图脚本要能在**没有图形会话的机器**上跑
 * （CI、SSH、被外部沙箱包着跑的 agent）。不带这两个参数时 Electron 子进程会报
 * `sandbox initialization failed: Operation not permitted` 然后整窗不渲染。
 * 这是本地验收工具，不进产品包，关掉渲染进程沙箱的代价可以接受。
 */
const child = spawn(electronPath, ['--no-sandbox', '--disable-gpu', mainPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
const after = (await rpc<{ values: Record<string, string | null> }>('settings.get', {})).values['ui.locale']
await server.close()

/* 服务端读回来的值才是"记住了"的证据 —— 页面看着对但没落盘，下一个窗口就前功尽弃 */
console.log(`4) 服务端记下的语言：${String(after)}`)

const failures: string[] = []
let report: Array<{ step: string; text: string; cjk: string[] }> = []
try {
  report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) as typeof report
} catch {
  failures.push('没有拿到 report.json（窗口没跑到最后）')
}

for (const entry of report) {
  // 中文那一步反过来断言：**必须有中文**，否则说明中文表根本没被用上（两套词一样是另一种 bug）
  if (entry.step === 'zh') {
    if (entry.cjk.length === 0) failures.push('中文界面里一句中文都没有 —— 中文表没生效')
    continue
  }
  if (entry.cjk.length > 0) failures.push(`${entry.step} 里还有中文：${entry.cjk.slice(0, 6).join(' | ')}`)
}
if (after !== 'en') failures.push(`重载后服务端记的仍是 ${String(after)}，不是 en`)

await rm(home, { recursive: true, force: true })

if (code !== 0 || failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`截图在 ${outDir}`)
  process.exit(1)
}
console.log(`✓ 切得动、记得住、英文界面没有中文（截图 ${outDir}）`)
