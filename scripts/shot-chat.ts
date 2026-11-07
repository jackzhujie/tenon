/**
 * 对话界面的**人眼验收**：探索合并、子 Agent 层级、Markdown 渲染。
 *
 * 为什么必须看：这三件事全是"看着对不对"的问题 —— 合并后的那一行读不读得懂、
 * 子 Agent 的缩进像不像主从关系、表格和粗体有没有渲染出来。类型检查和单测一个字都答不了。
 *
 * 做法：faux 模型按剧本跑一轮**真的**工具调用（`ls` / `read` / `cat`），中间派一个
 * explore 子 Agent，让它在子会话里 `sleep 3` —— 那一小段就是为了把"子 Agent 正在跑"
 * 这一帧抓到（任务图只描述"现在"，跑完 pi 就把节点回收了）。
 *
 * 用法：`pnpm shot:chat`（先 `pnpm build:web`；截图落在 /tmp/tenon-chat/*.png）
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

const TOKEN = 'shot-chat-token'
const outDir = '/tmp/tenon-chat'
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-chat-'))
const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  webDir: join(repo, 'apps', 'web', 'dist'),
})

const ANSWER = `## 排查结论

**根因不在代码里**，在这台机器的 \`PATH\` 上。

### 我看了什么

- \`package.json\` 里的脚本（\`lint\` 走 \`eslint .\`）
- \`src/App.tsx\` 与 \`src/main.tsx\` 的入口关系
- \`node_modules/.bin/eslint\` 这个包装脚本本身

| 环境 | lint | typecheck | build |
|---|---|---|---|
| 无 node | ✗ | — | — |
| node 20 | ✅ | ✅ | ✗ \`ERR_REQUIRE_ESM\` |
| node 22 | ✅ | ✅ | ✅ |

修法只有一句：\`pnpm run lint\` 要在 **node 22** 下跑。

\`\`\`sh
nvm use 22 && pnpm run lint
\`\`\`

> 顺带说一句：\`~~删掉 scripts/run\`~~ 那条不是必须的，留着也不影响。`

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
const created = await rpc<{ app: { id: string } }>('app.create', { name: '报销审批系统' })
const appId = created.app.id

/*
 * 剧本：三条连续探索（应该被并成一行）→ 派一个 explore 子 Agent（应当显示成嵌套卡片）
 * → 一段 Markdown 回答（应当渲染出标题/表格/粗体/代码块/删除线）。
 * 子 Agent 那一"道"先 `sleep 3`，好让截图抓得到它还在跑的样子。
 */
server.agent.model?.script([
  // 子 Agent 放在第一步、子会话里 `sleep 6`：faux 跑得太快，不拖住就抓不到那一帧
  { tool: 'subagent', args: { role: 'explore', task: '找出前端入口文件是哪个' } },
  { tool: 'bash', args: { command: 'ls -la' } },
  { tool: 'read', args: { path: 'package.json' } },
  { tool: 'bash', args: { command: "cat src/App.tsx 2>/dev/null | head -5; echo '---'; ls src" } },
  { text: ANSWER },
  { as: 'explore', tool: 'bash', args: { command: 'sleep 6' } },
  { as: 'explore', text: '入口是 src/main.tsx，App.tsx 只是根组件。' },
])

/**
 * 旁路读一眼服务端到底推了什么（只在排障时用）。
 *
 * 这次就靠它分开"服务端没推"与"前端没接"：截图里一直看不到子 Agent 卡片，
 * 是这个探针证明图里**确实有** delegated 节点，问题在渲染侧。
 */
async function watchGraph(target: string): Promise<{ frames: number; delegated: number }> {
  const events = await fetch(`${server.url}/events?token=${TOKEN}&appId=${target}`)
  const reader = events.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frames = 0
  let delegated = 0
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((item) => item.startsWith('data: '))
      if (line === undefined) continue
      try {
        const payload = JSON.parse(line.slice(6)) as { type?: string; graph?: { nodes: Array<{ scope: string }> } }
        if (payload.type !== 'taskgraph.update') continue
        frames += 1
        if (payload.graph !== undefined && payload.graph.nodes.some((node) => node.scope === 'delegated')) {
          delegated += 1
        }
      } catch {
        /* 半帧，等下一块 */
      }
    }
  }
  await reader.cancel().catch(() => undefined)
  return { frames, delegated }
}

function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const token = ${JSON.stringify(TOKEN)}
const appId = ${JSON.stringify(appId)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/' + name + '.png', img.toPNG()))
}

async function submit() {
  const response = await fetch(url + '/rpc/chat.submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ appId, content: 'lint 一直报错，帮我看看', requestId: 'shot-1' }),
  })
  return response.status
}

async function run() {
  const win = new BrowserWindow({ show: false, width: 1180, height: 860 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await sleep(2500)

  const status = await submit()

  /*
   * 只在"有子 Agent 卡片"的那一刻截图。faux 跑得飞快，固定 sleep 很容易错过那一帧，
   * 所以轮询 DOM：出现「步」字样的子 Agent 卡片就抓。
   */
  let captured = false
  let lastButtons = ''
  // 注入的是**纯 JS**（.cjs），别在这里写类型标注
  const history = []
  for (let i = 0; i < 50 && !captured; i += 1) {
    await sleep(400)
    const probe = await frame.executeJavaScript(\`(() => {
      const all = [...document.querySelectorAll('button')].map((n) => (n.textContent || '').trim())
      // 两条都踩过：① 正则穿两层模板字符串会被煮坏 ② 只看前 12 个按钮会漏掉排在后面的卡片
      const dbg = globalThis.__tenonDebug || null
      return { has: all.some((text) => text.includes(' 步')), dbg: dbg ? { nodes: (dbg.graph && dbg.graph.nodes || []).length, active: String(dbg.active) } : null, buttons: all.slice(0, 12).map((t) => t.slice(0, 40)) }
    })()\`)
    lastButtons = JSON.stringify(probe.buttons)
    const snapshot = probe.buttons.join(' | ') + ' ### ' + JSON.stringify(probe.dbg)
    if (!history.includes(snapshot)) history.push(snapshot)
    if (probe.has) {
      await shot(win, '2-子代理运行中')
      captured = true
    }
  }
  if (!captured) await shot(win, '2-未捕获')

  // 等这一轮真的结束（输入框可用 / 状态回到空闲）
  for (let i = 0; i < 60; i += 1) {
    await sleep(500)
    const idle = await frame.executeJavaScript(
      "Boolean([...document.querySelectorAll('div')].find((n) => (n.textContent || '').trim() === '空闲'))",
    )
    if (idle) break
  }
  await sleep(800)
  await shot(win, '1-合并后')

  // 展开那条"查看代码"，看逐条原文
  const opened = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((n) => /查看代码/.test(n.textContent || ''))
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(700)
  await shot(win, '3-展开探索')

  // 滚到底看 Markdown 回答
  await frame.executeJavaScript(\`(() => {
    const scroller = [...document.querySelectorAll('div')].find((n) => n.scrollHeight > n.clientHeight + 80 && /overflow-y-auto/.test(n.className || ''))
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    return true
  })()\`)
  await sleep(600)
  await shot(win, '4-markdown')

  await win.close()
  return { submitStatus: status, captured, opened, lastButtons, history: history.slice(0, 6) }
}

app.whenReady().then(async () => {
  try {
    process.stdout.write('SHOT ' + JSON.stringify(await run()) + '\\n')
  } catch (error) {
    process.stdout.write('SHOT_ERR ' + String((error && error.message) || error) + '\\n')
  } finally {
    app.exit(0)
  }
})
`
}

try {
  const mainFile = join(home, 'shot-chat-main.cjs')
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
    }, 180_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  console.log('旁路看服务端推送：', await watchGraph(appId))
  const line = stdout.split('\n').find((item) => item.startsWith('SHOT'))
  console.log(line ?? stdout.slice(-600))
  const files = await readFile(join(outDir, '1-合并后.png')).then(
    () => true,
    () => false,
  )
  console.log(files ? `截图在 ${outDir}` : '没抓到截图')
} finally {
  await server.close()
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => undefined)
}
