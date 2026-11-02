/**
 * e2e 子 Agent 的真机端到端（M4 第 4 步 / DoD ①）。
 *
 * 这条脚本回答一个问题：**子 Agent 能不能只看页面（不看源码）就发现一个真实的 bug，
 * 并且在修好之后自己复验通过？**
 *
 * 为什么必须真开浏览器：这个 bug 在源码里"看起来没问题" ——
 * `setCount(value => value + 2)` 语法完全正确、类型也没错，只有**点一下**才会发现
 * 数字跳到了 2。断言必须落在真 DOM 上，`pnpm test` 里的假驱动只能验接线。
 *
 * 关于 faux 的诚实说明：本地假模型不会推理，所以"发现"这一步是剧本安排的
 * （`[read, click, assert '计数 1']`）。**判据是真 DOM 给的**：
 * 断言失败时括号里的"实测"来自页面，修复之后同一条断言才通过 ——
 * 这是 faux 能给出的最强证据。接真模型后，这条脚本换成一句"验一下加一按钮"即可。
 *
 * 用法：`pnpm e2e:e2e`（首次要联网装 React，几十秒）
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentContext, type PageDriver } from '../packages/agent/src/index.js'

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..', 'apps', 'desktop')
const require = createRequire(import.meta.url)
/** electron 包的默认导出就是可执行文件路径（只有在 Electron 运行时里才是 API） */
const electronPath = require(join(appDir, 'node_modules', 'electron')) as unknown as string

const TOKEN = 'e2e-agent-token'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 带 bug 的页面：语法没问题、类型也没问题，只有点一下才知道数字跳了 2
const BUGGY_APP = `import { useState } from 'react'

// 具名导出：模板的 main.tsx 是 \`import { App } from './App'\`
export function App() {
  const [count, setCount] = useState(0)
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>计数器</h1>
      <p>计数 {count}</p>
      <button onClick={() => setCount((value) => value + 2)}>加一</button>
    </main>
  )
}
`

const FIXED_APP = BUGGY_APP.replace('value + 2', 'value + 1')

interface ToolResultModel {
  toolName?: string
  content?: { type: string; text?: string }[]
}

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-agent-'))
console.log(`TENON_HOME = ${home}\n`)

const { startServer } = await import('../packages/server/src/index.js')
const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: {
    readyTimeoutMs: 8 * 60 * 1000,
    log: (line) => console.log(`  [preview] ${line}`),
  },
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

/** 子会话里的工具结果 —— "断言失败"的第一手证据在这里，不在 SSE 里（子会话不推事件） */
async function childToolTexts(appId: string): Promise<string[]> {
  const session = await server.agent.pool?.acquire(appId)
  if (session === undefined) return []
  const records = await session.root.commit(
    async (tx) => (await tx.scanConversations({}, 30)).items,
    agentContext,
  )
  const texts: string[] = []
  for (const record of records) {
    if (record.owner === undefined || record.owner === null) continue
    const conversation = await session.harness.conversation(record.id, agentContext)
    if (conversation === undefined) continue
    const view = await conversation.viewState(agentContext)
    try {
      const entries = view.value.entries as unknown as Array<{ kind: string; model?: ToolResultModel[] }>
      for (const entry of entries) {
        if (entry.kind !== 'pi.tool-result') continue
        for (const model of entry.model ?? []) {
          texts.push((model.content ?? []).map((part) => part.text ?? '').join(''))
        }
      }
    } finally {
      await view.dispose?.()
    }
  }
  return texts
}

async function runTurn(appId: string, requestId: string): Promise<void> {
  await rpc('chat.submit', { appId, content: '按剧本执行', requestId })
  // 事件流不带子会话的细节，这里按"应用回到 idle"判这一轮落定
  const deadline = Date.now() + 120_000
  for (;;) {
    const page = await rpc<{ apps: Array<{ id: string; status: string }> }>('app.list', {})
    const status = page.apps.find((app) => app.id === appId)?.status
    if (status === 'idle') return
    if (Date.now() > deadline) throw new Error(`这一轮没有落定（status=${String(status)}）`)
    await sleep(200)
  }
}

/** Electron 主进程：就打开那个页面，什么都不做 —— 通道是页面里的脚本自己连的 */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = process.env.TENON_E2E_URL
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await win.loadURL(url)
    process.stdout.write('PAGE-LOADED\\n')
  } catch (error) {
    process.stdout.write('PAGE-ERROR ' + String((error && error.stack) || error) + '\\n')
    app.exit(1)
  }
}).catch((error) => {
  process.stdout.write('PAGE-ERROR ' + String((error && error.stack) || error) + '\\n')
  app.exit(1)
})
`
}

let electron: ReturnType<typeof spawn> | undefined

async function launchBrowser(url: string): Promise<void> {
  const mainPath = join(home, 'main.cjs')
  await writeFile(mainPath, electronMain(), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env, TENON_E2E_URL: url }
  // 与 smoke:desktop 同一个坑：带着它 electron 会被当成 node 跑
  delete env['ELECTRON_RUN_AS_NODE']
  electron = spawn(electronPath, ['--no-sandbox', mainPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  electron.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line !== '') console.log(`  [electron] ${line}`)
  })
  electron.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    // Electron 在 macOS 上会刷一堆 IMK / 输入法噪音，只留真正像错误的
    if (line !== '' && /error|fail/i.test(line) && !line.includes('IMK')) console.log(`  [electron] ${line}`)
  })
}

/** 等页面通道连上（页面脚本 hello 之后 bridge 才知道有页面） */
async function waitForPage(appId: string, timeoutMs = 40_000): Promise<PageDriver> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const driver = server.preview.pages(appId)
    if (driver !== undefined && driver.info !== null) return driver
    if (Date.now() > deadline) throw new Error('页面通道一直没连上（注入脚本没跑起来？）')
    await sleep(200)
  }
}

async function cleanup(): Promise<void> {
  electron?.kill('SIGKILL')
  await server.close().catch(() => undefined)
  await rm(home, { recursive: true, force: true })
}

console.log('1) 建应用，写入一个"只有点一下才看得出来"的 bug，起预览')
const created = await rpc<{ app: { id: string } }>('app.create', { name: '计数器' })
const appId = created.app.id
const repoFile = join(home, 'apps', appId, 'repo', 'src', 'App.tsx')
await writeFile(repoFile, BUGGY_APP, 'utf8')

await rpc('preview.start', { appId })
const ready = await server.preview.waitReady(appId, 8 * 60 * 1000)
if (ready.state !== 'ready' || ready.url === null) {
  console.error(`预览没起来：${String(ready.error)}`)
  await cleanup()
  process.exit(1)
}
console.log(`   预览就绪 ${ready.url}`)

console.log('2) 开一个真浏览器，让它连上页面通道')
await launchBrowser(ready.url)
const driver = await waitForPage(appId)
check('页面通道连上了（注入脚本真的跑在页面里）', driver.info !== null, JSON.stringify(driver.info))

// 先确认页面是"好"的：整页渲染失败也能让断言失败，那样后面全是假阳性
const healthy = await driver.run('read', {})
const healthyText = String((healthy.value as { text?: string } | undefined)?.text ?? '')
check('页面渲染正常（不是一张白页）', healthyText.includes('计数器') && healthyText.includes('计数 0'), healthyText)
if (!healthyText.includes('计数器')) {
  console.error('页面从一开始就是坏的，后面的断言没有意义')
  await cleanup()
  process.exit(1)
}

console.log('3) 第一轮：e2e 子 Agent 读页面 → 点「加一」→ 断言"计数 1"')
server.agent.model?.script([
  // 主角色：派活
  { tool: 'subagent', args: { role: 'e2e', task: '点一下「加一」，确认计数变成 1' } },
  // 主角色：拿到"点了变 2"的结论之后改代码（这一步是"修复"）
  { tool: 'write', args: { path: 'src/App.tsx', content: FIXED_APP } },
  { text: '加一改成 +1 了，再验一次。' },
  // e2e：只看页面，不看源码
  { as: 'e2e', tool: 'preview_read', args: {} },
  { as: 'e2e', tool: 'preview_click', args: { selector: 'button' } },
  { as: 'e2e', tool: 'preview_assert', args: { text: '计数 1', timeoutMs: 1500 } },
  { as: 'e2e', text: '点一下之后显示「计数 2」，不是「计数 1」—— 加一加了两下。' },
])
await runTurn(appId, 'e2e-1')

const firstTexts = await childToolTexts(appId)
const failed = firstTexts.find((text) => text.includes('✗ 断言未通过'))
check('子 Agent 从真 DOM 拿到了失败证据（不是猜的）', failed !== undefined, firstTexts.join('\n---\n').slice(0, 400))
check('失败信息里带着页面上的实测值', failed !== undefined && failed.includes('实测'), failed ?? '')
check('页面文字确实读到了（preview_read 生效）', firstTexts.some((text) => text.includes('计数器')))
check('点击真的点在按钮上（preview_click 生效）', firstTexts.some((text) => text.includes('已点击')))

/*
 * 4) 等新代码真的到页面。
 *
 * ★ 不能等"计数自己回到 0"：React Fast Refresh 会**保留 state**，改完代码计数还是 2。
 *   要一个干净起点只能整页重载 —— 这也正是 `preview_open` 存在的意义。
 */
await sleep(1200)
let reloaded = false
for (let index = 0; index < 20; index += 1) {
  const info = await driver.navigate('/')
  const read = await driver.run('read', {})
  const text = String((read.value as { text?: string } | undefined)?.text ?? '')
  if (text.includes('计数 0')) {
    reloaded = true
    console.log(`   重载后 ${info.path}：${text.replace(/\n/g, ' ')}`)
    break
  }
  await sleep(300)
}
check('整页重载之后是新代码（计数回到 0）', reloaded)
check('磁盘上的代码真的改了', (await readFile(repoFile, 'utf8')).includes('value + 1'))

console.log('5) 第二轮：同一条断言，这次应该通过')
server.agent.model?.script([
  { tool: 'subagent', args: { role: 'e2e', task: '再验一次加一' } },
  { text: '这次通过了。' },
  { as: 'e2e', tool: 'preview_open', args: { path: '/' } },
  { as: 'e2e', tool: 'preview_click', args: { selector: 'button' } },
  { as: 'e2e', tool: 'preview_assert', args: { text: '计数 1', timeoutMs: 3000 } },
  { as: 'e2e', text: '✓ 点一下显示「计数 1」。' },
])
await runTurn(appId, 'e2e-2')

const secondTexts = (await childToolTexts(appId)).filter((text) => !firstTexts.includes(text))
const passed = secondTexts.find((text) => text.includes('✓ 断言通过'))
check('★ 修完之后同一条断言通过了（这就是 DoD ①）', passed !== undefined, secondTexts.join('\n---\n').slice(0, 400))

await cleanup()

console.log('')
if (failures === 0) {
  console.log('全部通过 ✅')
  process.exit(0)
}
console.log(`失败 ${failures} 项 ❌`)
process.exit(1)
