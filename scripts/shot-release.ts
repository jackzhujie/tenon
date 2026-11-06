/**
 * 发布对话框的**人眼验收**（v1.2.23 的"同一版代码不重跑"）。
 *
 * 单测证明得了 `reusable` 的三条判据，证明不了用户看不看得懂：
 * "这是 3 分钟前对同一版代码的检查结果"这句话会不会被忽略、逐项的清单在对话框里
 * 排得下排不下、「没通过」是不是一眼能看见。这些只能看。
 *
 * 脚本做的事（全是真的）：
 *   1. 起服务（faux），建一个应用 —— **故意不装依赖**，于是门禁真的会红（typecheck 没跑成）
 *   2. 跑一次 `release.check` 让存档落下来
 *   3. 真 Chromium：点顶栏「发布」→ 对话框打开 → **不重跑，直接显示那份结论**
 *   4. 截图 + 断言：出现"同一版代码"（说明用了缓存）、出现"没通过"、出现三项清单
 *
 * 用法：`pnpm shot:release`（先 build:web）→ /tmp/tenon-release/*.png
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

const TOKEN = 'shot-release'
const outDir = '/tmp/tenon-release'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-release-'))
let server: RunningServer | undefined

try {
  server = await startServer({
    port: 0,
    token: TOKEN,
    env: { TENON_HOME: home, TENON_FAUX: '1' },
    // 不装依赖：门禁会真的红，正好有东西可看
    preview: { installDeps: false },
    webDir: join(repo, 'apps', 'web', 'dist'),
  })

  async function rpc<T>(method: string, input: unknown = {}): Promise<T> {
    const response = await fetch(`${server?.url}/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(input),
    })
    const body = (await response.json()) as { ok: boolean; data?: T; error?: { message?: string } }
    if (!body.ok) throw new Error(`${method} 失败：${body.error?.message ?? '未知'}`)
    return body.data as T
  }

  /* ---------- 1. 建应用 + 跑一次预检（真的会红） ---------- */
  const { app } = await rpc<{ app: { id: string } }>('app.create', {
    name: '一个还没装依赖的应用',
    templateId: 'react-vite',
  })
  console.log(`应用 ${app.id} 已建`)

  const checked = await rpc<{ gate: { ok: boolean; checks: { id: string; status: string }[] } }>(
    'release.check',
    { appId: app.id },
  )
  console.log(
    `预检：ok=${String(checked.gate.ok)}（${checked.gate.checks.map((c) => `${c.id}:${c.status}`).join(' / ')}）`,
  )

  const last = await rpc<{ reusable: boolean; check: { commitSha: string | null } | null }>('release.lastCheck', {
    appId: app.id,
  })
  console.log(`存档：${last.check === null ? '无' : `对 ${last.check.commitSha?.slice(0, 7) ?? '—'}`} / 可复用=${String(last.reusable)}`)
  if (!last.reusable) throw new Error('刚查完同一版代码，应该可复用 —— 否则这张图拍不到"没重跑"')

  /* ---------- 2. 真 Chromium 里打开对话框 ---------- */
  const mainFile = join(home, 'shot-main.cjs')
  await writeFile(mainFile, electronMain(server.url), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  // 沙箱在被收窄的 shell 里初始化失败 → network service 崩 → 打开本地页 ERR_FAILED
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
    }, 120_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const shot = /SHOT (\{.*\})/.exec(stdout)
  if (shot?.[1] === undefined) {
    console.error(stdout.slice(-800))
    throw new Error('没有拿到界面观察结果')
  }
  const observed = JSON.parse(shot[1]) as { text: string; opened: boolean }
  console.log(`\n对话框里读到的文字：\n${observed.text.slice(0, 900)}\n`)

  const failures: string[] = []
  if (!observed.opened) failures.push('顶栏没找到「发布」按钮')
  // 用了缓存就必须说出来，而且要说清"为什么可以信"
  if (!observed.text.includes('同一版代码')) failures.push('没有「同一版代码」这句（用户会以为没检查）')
  if (!observed.text.includes('没通过')) failures.push('没有「没通过」—— 红的结论没显示出来')
  for (const label of ['类型检查', '测试', 'Lint']) {
    if (!observed.text.includes(label)) failures.push(`清单里没有「${label}」`)
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.join('；')}`)
    process.exitCode = 1
  } else {
    console.log(`✓ 界面检查通过（截图在 ${outDir}）`)
  }
} finally {
  await server?.close()
  await rm(home, { recursive: true, force: true })
}

function electronMain(url: string): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(url)}
const out = ${JSON.stringify(outDir)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await sleep(2800)

  const opened = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('发布'))
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  // 打开时只问一次"能不能复用"（一个 RPC），1.5 秒足够；留点余量给渲染
  await sleep(1800)

  const text = await frame.executeJavaScript('(document.body.innerText || "").slice(0, 3000)')
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/1-发布对话框.png', img.toPNG()))
  console.log('SHOT ' + JSON.stringify({ opened: opened === true, text: text }))
  app.quit()
}

app.whenReady().then(run).catch((error) => {
  console.error(error)
  app.quit()
})
`
}
