/**
 * 诊断对话框的**人眼验收**：打开、看得见原文、三个出口都在。
 *
 * 为什么必须看：这份东西的全部意义是"发给别人之前，我自己先看一眼"。
 * 单测能钉住脱敏规则，但钉不住"用户打开对话框时看到的到底是不是那段文本" ——
 * 而恰恰是那个"是不是"，决定了这个功能是诚实还是不诚实：
 * 界面上要是只显示一段摘要，人点发送时看到的和真正发出去的就不是同一份东西。
 *
 * 用法：`pnpm shot:diagnostics`（先 `pnpm build:web`；截图落在 /tmp/tenon-diagnostics/）
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

const TOKEN = 'shot-diagnostics-token'
const outDir = '/tmp/tenon-diagnostics'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-diag-'))
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

console.log('1) 建应用')
const created = await rpc<{ app: { id: string } }>('app.create', { name: 'Diagnostics Demo' })
const appId = created.app.id

// 先看服务端产出的原文 —— 界面里显示的应该与它一字不差
console.log('2) 直接取一份报告（人眼核对内容）')
const direct = await rpc<{ text: string; redactions: number; format: string }>('diagnostics.report', {
  appId,
})
console.log('---- 报告原文 ----')
console.log(direct.text)
console.log('---- 结束（脱敏 ' + direct.redactions + ' 处）----')

function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
app.disableHardwareAcceleration()
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const appId = ${JSON.stringify(appId)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/' + name + '.png', img.toPNG()))
}

async function click(win, selector) {
  return win.webContents.mainFrame.executeJavaScript(
    '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); ' +
    'if (!el) return false; el.click(); return true })()',
  )
}

/** 对话框里那段原文 + 三个按钮的文字：用来核对"人看到的"与"服务端给的"是同一份 */
async function readDialog(win) {
  return win.webContents.mainFrame.executeJavaScript(\`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    const pre = dialog.querySelector('pre')
    const buttons = [...dialog.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
    return { text: pre ? pre.textContent : null, buttons }
  })()\`)
}

async function run() {
  const win = new BrowserWindow({ show: false, width: 1180, height: 860 })
  await win.loadURL(url)
  await sleep(2200)

  // 进应用：顶栏下拉 → 第一个应用
  await click(win, '[data-tenon-app-menu-trigger]')
  await sleep(400)
  await click(win, '[data-tenon-app="' + appId + '"]')
  await sleep(1800)
  await shot(win, '1-应用页')

  // 日志面板默认收起，诊断按钮在展开后的工具栏里
  const opened = await click(win, '[data-log-toggle]')
  await sleep(400)
  const found = await click(win, '[data-diagnostics]')
  await sleep(1600)
  await shot(win, '2-诊断对话框')

  const dialog = await readDialog(win)
  require('node:fs').writeFileSync(
    out + '/report.json',
    JSON.stringify({ opened, found, dialog }, null, 2),
  )
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
const child = spawn(electronPath, ['--no-sandbox', '--disable-gpu', mainPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
await server.close()
await rm(home, { recursive: true, force: true })

const failures: string[] = []
interface DialogRead {
  text: string | null
  buttons: string[]
}
let report: { opened: boolean; found: boolean; dialog: DialogRead | null } | undefined
try {
  report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) as typeof report
} catch {
  failures.push('没有拿到 report.json（窗口没跑到最后）')
}

if (report !== undefined) {
  if (!report.opened) failures.push('日志面板没展开 —— data-log-toggle 找不到或被禁用')
  if (!report.found) failures.push('诊断按钮没找到 —— data-diagnostics 不在 DOM 里')
  if (report.dialog === null) {
    failures.push('点了诊断但没有出现 [role=dialog]')
  } else {
    const shown = report.dialog.text ?? ''
    /*
     * 关键断言：界面显示的必须与服务端给的那份一字不差（不是摘要、不是重排过的）。
     * `time:` 那一行要抹掉 —— 对话框里是**当场重新生成**的一份，与脚本早两秒拿到的
     * 那份时间戳不同；除此之外每个字符都该一样。
     */
    const withoutTime = (value: string): string => value.replace(/^time:\s+.*$/m, 'time: <ignored>')
    if (withoutTime(shown) !== withoutTime(direct.text)) {
      failures.push(`对话框里的文本与服务端给的原文不一致（界面 ${shown.length} 字符，服务端 ${direct.text.length} 字符）`)
    }
    if (!shown.includes('Tenon diagnostics')) failures.push('对话框里没有报告标题行')
    if (report.dialog.buttons.length < 3) {
      failures.push(`按钮不足三个：${report.dialog.buttons.join(' / ') || '（无）'}`)
    }
  }
}

if (code !== 0 || failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`截图在 ${outDir}`)
  process.exit(1)
}
console.log(`✓ 对话框打得开、原文一字不差、三个出口都在（截图 ${outDir}）`)
