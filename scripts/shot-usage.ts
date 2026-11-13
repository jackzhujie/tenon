/**
 * 「全部应用」用量汇总的**人眼验收**。
 *
 * 单测能证明合计等于各应用之和（`usage-total.test.ts`），但证明不了用户看不看得懂：
 * 那 288px 宽的小面板里塞三行数字会不会挤爆、长应用名会不会把数字顶出去、
 * 「还没跑过」和「花了 0」是不是真的长得不一样。这些只能看。
 *
 * 脚本做的事（全是真的）：
 *   1. 起服务（faux 模型），建三个应用：跑两轮的、跑一轮的、**一轮都没跑的**
 *   2. 真 Chromium：点顶栏用量按钮 → 截图 → 断言面板里同时出现"全部应用"、
 *      三个应用名、以及"还没跑过"（而不是 `0 tokens`）
 *
 * 用法：`pnpm shot:usage`（先 build:web）→ /tmp/tenon-usage/*.png
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

const TOKEN = 'shot-usage'
const outDir = '/tmp/tenon-usage'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-usage-'))
let server: RunningServer | undefined

/** 名字故意长、短都有：截断在 288px 里是最容易出问题的一格 */
const APPS = {
  expensive: '花得多的那个应用',
  cheap: '便宜',
  fresh: '一个名字特别长的、刚建好还没跑过任何一轮的应用',
}

try {
  server = await startServer({
    port: 0,
    token: TOKEN,
    env: { TENON_HOME: home, TENON_FAUX: '1' },
    preview: { installDeps: false },
    webDir: join(repo, 'apps', 'web', 'dist'),
  })

  /* 断言在中文界面里找字（「全部应用」「还没跑过」）：系统语言是 en-US，得钉住 */
  server.core.settings.set({ 'ui.locale': 'zh' })

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

  async function create(name: string): Promise<string> {
    const { app } = await rpc<{ app: { id: string } }>('app.create', { name })
    return app.id
  }

  /**
   * 跑一轮并等它落定。
   *
   * 判据是"历史真的变长了且最后一条是助手"，不是 sleep：账本要等这一轮提交完才写，
   * 提前截图会拍到上一轮的数字（那样截出来的是错的图，而且看不出来）。
   */
  async function turn(appId: string, text: string): Promise<void> {
    server?.agent.model?.script([{ text }])
    const before = await rpc<{ messages: unknown[] }>('chat.history', { appId, limit: 200 })
    await rpc('chat.submit', { appId, content: '随便说一句，产生一点用量', requestId: `u-${appId}-${Date.now()}` })
    const deadline = Date.now() + 60_000
    for (;;) {
      const history = await rpc<{ messages: { role: string }[] }>('chat.history', { appId, limit: 200 })
      const last = history.messages.at(-1)
      if (history.messages.length > before.messages.length && last?.role === 'assistant') return
      if (Date.now() > deadline) throw new Error('这一轮没有落定')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  const expensive = await create(APPS.expensive)
  const cheap = await create(APPS.cheap)
  const fresh = await create(APPS.fresh)
  console.log(`三个应用：${expensive} / ${cheap} / ${fresh}`)

  await turn(expensive, '第一轮。')
  await turn(expensive, '第二轮。')
  await turn(cheap, '一轮。')

  const total = await rpc<{ totals: { totalTokens: number }; apps: { appId: string; known: boolean; totals: { totalTokens: number } }[] }>(
    'usage.total',
    {},
  )
  console.log(
    `RPC：合计 ${total.totals.totalTokens} tokens / ${total.apps.length} 行 / 未跑过 ${
      total.apps.filter((row) => !row.known).length
    } 个`,
  )

  /* ---------- 真 Chromium 里看一眼 ---------- */
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
  const observed = JSON.parse(shot[1]) as { text: string; hasTrigger: boolean }
  console.log(`\n面板里读到的文字：\n${observed.text.slice(0, 700)}\n`)

  const failures: string[] = []
  if (!observed.hasTrigger) failures.push('顶栏没有用量按钮')
  if (!observed.text.includes('全部应用')) failures.push('面板里没有「全部应用」')
  for (const name of Object.values(APPS)) {
    if (!observed.text.includes(name.slice(0, 10))) failures.push(`面板里没有应用「${name}」`)
  }
  // 关键区分：没跑过的应用要显示"还没跑过"，不能显示成 0
  if (!observed.text.includes('还没跑过')) failures.push('没有"还没跑过"这一格（会被误读成花了 0）')

  if (failures.length > 0) {
    console.error(`✗ ${failures.join('；')}`)
    process.exitCode = 1
  } else {
    console.log('✓ 界面检查通过（截图在 ' + outDir + '）')
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
  const win = new BrowserWindow({ show: false, width: 1200, height: 860 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await sleep(2800)

  const hasTrigger = await frame.executeJavaScript(\`(() => {
    const btn = document.querySelector('[data-tenon-usage-trigger]')
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(1200)

  const text = await frame.executeJavaScript('(document.body.innerText || "").slice(0, 2000)')
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/1-全部应用.png', img.toPNG()))
  console.log('SHOT ' + JSON.stringify({ hasTrigger: hasTrigger === true, text: text }))
  app.quit()
}

app.whenReady().then(run).catch((error) => {
  console.error(error)
  app.quit()
})
`
}
