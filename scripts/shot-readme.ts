/**
 * README 首图：**一段对话 + 它当场改出来的应用**。
 *
 * 为什么单独一个脚本、而不复用 `shot:chat`：那个是验收脚本，剧本是"排查 lint 为什么报错"，
 * 而且它不启动预览（右侧空白）。README 首图要回答的是另一个问题 ——
 * "我说一句话，它到底能不能做出东西"，所以这里让 faux 模型按剧本**真的写两个文件**
 * （`src/App.tsx` + `src/styles.css`，见 `scripts/fixtures/readme-app/`），
 * 再起真预览让 Vite 热更新，最后截一张左对话、右成品的图。
 *
 * 两处刻意的处理：
 * - 顶栏的"假模型 · 仅验证链路"在截图前隐藏。它对开发者有用（明确告诉你回复是假的），
 *   但放在门面图上会让第一次看到的人以为整个产品是假的。只影响截图，不改产品。
 * - 窗口固定 1280×860：GitHub 正文宽约 880px，太宽的图会被压得看不清字。
 *
 * 用法：`pnpm shot:readme`（先 `pnpm build:web`）。产物写进 `docs/images/`，
 * 直接提交进仓库 —— README 引用相对路径，不能放 /tmp。
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'shot-readme-token'
const outDir = join(repo, 'docs', 'images')
await mkdir(outDir, { recursive: true })

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-readme-'))

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  // 首图要的是"预览里真有一个界面"，所以依赖必须真装（几十秒）
  preview: { installDeps: true },
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

const QUESTION = '做一个报销审批系统：待审列表、金额合计，能通过和驳回'

console.log('1) 建应用')
const created = await rpc<{ app: { id: string } }>('app.create', { name: '报销审批系统' })
const appId = created.app.id

console.log('2) 写剧本（faux 会真的落两个文件）')
const appTsx = await readFile(join(here, 'fixtures', 'readme-app', 'App.tsx'), 'utf8')
const styles = await readFile(join(here, 'fixtures', 'readme-app', 'styles.css'), 'utf8')

server.agent.model?.script([
  { tool: 'read', args: { path: 'src/App.tsx' } },
  { tool: 'write', args: { path: 'src/App.tsx', content: appTsx } },
  { tool: 'write', args: { path: 'src/styles.css', content: styles } },
  {
    text: [
      '做好了，右侧就是它 —— 一个能用的报销审批页：',
      '',
      '- **待审列表**：申请人、事由、金额、时间，按状态分四个页签',
      '- **金额合计**：只算待审批的，点「通过」或「驳回」会立刻重算',
      '- **数据留在本机**：`src/App.tsx` 与 `src/styles.css` 两个文件，已自动提交成一个 Git 版本',
      '',
      '想改就说 —— 比如「金额超过 1000 的要两个人审」。',
    ].join('\n'),
  },
])

console.log('3) 起预览（首次要装依赖，可能要几十秒）')
await rpc('preview.start', { appId })
const ready = await server.preview.waitReady(appId, 5 * 60 * 1000)
if (ready.state !== 'ready') throw new Error(`预览没就绪：${ready.error ?? '未知'}`)
console.log(`   预览就绪：${String(ready.url)}`)

console.log('4) 开窗截图')
const mainPath = join(home, 'electron-main.cjs')
await writeFile(mainPath, electronMain(), 'utf8')

const code = await new Promise<number | null>((resolve) => {
  /*
   * `--no-sandbox` 是必须的：CI/无头环境里 Chromium 的沙箱起不来，症状是一串
   * `sandbox initialization failed: Operation not permitted`，然后 loadURL 直接
   * ERR_FAILED —— 看起来像"服务端没起来"，其实是渲染进程根本没跑起来。
   * 另外 `ELECTRON_RUN_AS_NODE` 必须从环境里删掉，否则这个二进制会当 node 用。
   */
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['--no-sandbox', mainPath], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  child.on('exit', (exitCode) => {
    clearTimeout(timer)
    resolve(exitCode)
  })
})

await server.close()
console.log(code === 0 ? `\n截图在 ${outDir}` : `\n截图失败（exit ${String(code)}）`)
process.exit(code === 0 ? 0 : 1)

/** Electron 里跑的那一段。注入的是纯 JS，别在这里写类型标注 */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const token = ${JSON.stringify(TOKEN)}
const appId = ${JSON.stringify(appId)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  const img = await win.capturePage()
  require('node:fs').writeFileSync(out + '/' + name + '.png', img.toPNG())
  console.log('   shot: ' + name)
}

async function submit() {
  const response = await fetch(url + '/rpc/chat.submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ appId, content: ${JSON.stringify(QUESTION)}, requestId: 'shot-readme' }),
  })
  return response.status
}

/** 顶栏那行"假模型 · 仅验证链路"在门面图上会被读成"这产品是假的"，截图前藏掉 */
async function hideFakeBadge(frame) {
  return frame.executeJavaScript('(() => {' +
    'const hits = [...document.querySelectorAll("*")].filter((n) => n.children.length === 0 && (n.textContent || "").includes("假模型"));' +
    'hits.forEach((n) => { n.style.visibility = "hidden" });' +
    'return hits.length' +
    '})()')
}

/**
 * 滚到最上面。
 *
 * 首图要讲"我说了一句话 → 它做出来了"，那条**用户消息**必须在画面里 ——
 * 否则右边突然出现一个做好的界面，读者不知道是谁做的。
 * 不挑选择器：把所有可滚动的容器一起滚到顶，这段对话本来就只有一轮。
 */
async function scrollToTop(frame) {
  return frame.executeJavaScript('(() => {' +
    'let n = 0;' +
    'document.querySelectorAll("*").forEach((el) => { if (el.scrollHeight > el.clientHeight + 40) { el.scrollTop = 0; n += 1 } });' +
    'return n' +
    '})()')
}

async function run() {
  const win = new BrowserWindow({ show: false, width: 1280, height: 860 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await sleep(3000)
  await hideFakeBadge(frame)

  const status = await submit()
  console.log('   submit: ' + status)

  // 等这一轮跑完（状态回到"空闲"）
  for (let i = 0; i < 80; i += 1) {
    await sleep(500)
    const idle = await frame.executeJavaScript(
      'Boolean([...document.querySelectorAll("div")].find((n) => (n.textContent || "").trim() === "空闲"))',
    )
    if (idle) break
  }

  // 预览是独立 iframe，跨源读不到内部；给 Vite 热更新留足时间，然后人眼看图确认
  await sleep(6000)
  await hideFakeBadge(frame)
  await scrollToTop(frame)
  await sleep(400)
  await shot(win, 'chat-and-preview')

  app.exit(0)
}

app.whenReady().then(run).catch((error) => {
  console.error(error)
  app.exit(1)
})
`
}
