/**
 * 应用菜单与删除：**界面上的第一条"从建到删"完整旅程**（M6 收口时补的缺口）。
 *
 * 为什么需要这个脚本：`app.delete` 的后端从 M1 就在（还专门踩过"不能调 chat.close()"
 * 那个坑，budget.test 里钉着），`useWorkspace.deleteApp` 也写好了 —— 但**界面上没有
 * 任何入口**，`deleteApp` 是一段没人调用的死代码。于是用户建了几个试验应用之后，
 * 一个都删不掉，只能去删 `~/.tenon/home/apps` 目录。
 *
 * 这种"后端有、前端没有"的漏法不会有任何测试报警：所有单测都在验 RPC，所有 e2e 都在
 * 走既有的界面路径。所以这里验的是**界面**：
 *
 *   1. 菜单打得开、列得出现在有哪些应用
 *   2. 删除要二次确认（一次误点 = 代码与数据全没）
 *   3. 取消之后什么都没变
 *   4. 确认之后：菜单里少一个、当前应用自动切到剩下的
 *   5. 后端与磁盘同步：`app.list` 里没有、`home/apps/<id>` 目录也没了
 *
 * 用法：`pnpm e2e:apps`（先 `pnpm build:web` —— 它加载的是打包后的界面）
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
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

const TOKEN = 'e2e-apps-token'
/** 故意取有辨识度的名字：断言靠 textContent 里找它，不靠位置 */
const KEEP = '留下的应用'
const DROP = '要删掉的应用'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const home = await mkdtemp(join(tmpdir(), 'tenon-apps-e2e-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  // 只是建个应用并删掉，不需要装依赖（那要联网）
  preview: { installDeps: false },
  webDir: join(repo, 'apps', 'web', 'dist'),
})

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { message?: string }
}

async function rpc<T>(method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.message ?? '未知'}`)
  return body.data as T
}

/** 在真 Chromium 里点一遍，把每一步的观察结果打回来 */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(server.url)}
const keep = ${JSON.stringify(KEEP)}
const drop = ${JSON.stringify(DROP)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(frame, script, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const ok = await frame.executeJavaScript(script).catch(() => false)
    if (ok === true) return true
    if (Date.now() > deadline) throw new Error('等不到：' + label)
    await sleep(120)
  }
}

const click = (frame, selector) =>
  frame.executeJavaScript(
    '(() => { const node = document.querySelector(' + JSON.stringify(selector) + '); if (!node) return false; node.click(); return true })()',
  )

/** 菜单里每条应用的文本（去掉模板名那截，只看名字够不够判断） */
const menuNames = (frame) =>
  frame.executeJavaScript(
    '[...document.querySelectorAll("[data-tenon-app]")].map((n) => (n.querySelector("span.truncate") || {}).textContent || "")',
  )

async function run() {
  const out = {}
  const win = new BrowserWindow({ show: false, width: 1200, height: 860 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)

  // ① 界面起来了（拿到 token、拉完 app.list）
  await waitFor(frame, 'document.querySelector("header") !== null && !document.body.innerText.includes("正在连接")', '界面就绪')
  out.headerBefore = await frame.executeJavaScript(
    '(() => { const b = document.querySelector("[data-tenon-app-menu-trigger]"); return b ? b.textContent.trim() : null })()',
  )

  // ② 菜单列得出来
  await click(frame, '[data-tenon-app-menu-trigger]')
  await waitFor(frame, 'document.querySelector("[data-tenon-app-menu]") !== null', '菜单打开')
  await waitFor(frame, 'document.querySelectorAll("[data-tenon-app]").length === 2', '两个应用都在')
  out.namesBefore = await menuNames(frame)

  // ③ 删除要二次确认 —— 这一步是"防误点"的全部
  const targets = await frame.executeJavaScript(
    '[...document.querySelectorAll("[data-tenon-app]")].map((n) => ({ id: n.getAttribute("data-tenon-app"), name: ((n.querySelector("span.truncate") || {}).textContent || "") }))',
  )
  const victim = targets.find((item) => item.name.indexOf(drop) !== -1)
  out.victim = victim || null
  await frame.executeJavaScript(
    '(() => { const nodes = [...document.querySelectorAll("[data-tenon-app]")]; const row = nodes.find((n) => (n.textContent || "").indexOf(' + JSON.stringify(drop) + ') !== -1); if (!row) return false; const btn = row.parentElement.querySelector("[data-tenon-action=delete-app]"); if (!btn) return false; btn.click(); return true })()',
  )
  await waitFor(frame, 'document.querySelector("[data-tenon-confirm-delete]") !== null', '出现确认')
  out.confirmText = await frame.executeJavaScript(
    '(() => { const n = document.querySelector("[data-tenon-confirm-delete]"); return n ? n.textContent.trim() : "" })()',
  )

  // ④ 取消之后什么都没变
  await click(frame, '[data-tenon-action="cancel-delete"]')
  await waitFor(frame, 'document.querySelector("[data-tenon-confirm-delete]") === null', '确认被取消')
  out.namesAfterCancel = await menuNames(frame)

  // ⑤ 再点一次，这回确认
  await frame.executeJavaScript(
    '(() => { const nodes = [...document.querySelectorAll("[data-tenon-app]")]; const row = nodes.find((n) => (n.textContent || "").indexOf(' + JSON.stringify(drop) + ') !== -1); if (!row) return false; const btn = row.parentElement.querySelector("[data-tenon-action=delete-app]"); if (!btn) return false; btn.click(); return true })()',
  )
  await waitFor(frame, 'document.querySelector("[data-tenon-confirm-delete]") !== null', '第二次确认')
  await click(frame, '[data-tenon-action="confirm-delete"]')
  await waitFor(
    frame,
    // 两个条件都要：确认区在删除中一直挂着，而那一行不渲染 [data-tenon-app] —— 只看数量会在 RPC 还没回来时就通过
    'document.querySelector("[data-tenon-confirm-delete]") === null && document.querySelectorAll("[data-tenon-app]").length === 1',
    '删除完成',
    30000,
  )
  out.namesAfter = await menuNames(frame)
  out.headerAfter = await frame.executeJavaScript(
    '(() => { const b = document.querySelector("[data-tenon-app-menu-trigger]"); return b ? b.textContent.trim() : null })()',
  )
  await win.close()
  return out
}

app.whenReady().then(async () => {
  try {
    process.stdout.write('E2E_RESULT ' + JSON.stringify(await run()) + '\\n')
  } catch (error) {
    process.stdout.write('E2E_ERROR ' + JSON.stringify(String((error && error.message) || error)) + '\\n')
  } finally {
    app.exit(0)
  }
})
`
}

let mainFile = ''
try {
  console.log(`1) 建两个应用（真 app.create，"${DROP}" 最后建所以是当前应用）`)
  const first = await rpc<{ app: { id: string } }>('app.create', { name: KEEP })
  const second = await rpc<{ app: { id: string } }>('app.create', { name: DROP })
  const homeRoot = resolveHome({ TENON_HOME: home })
  const keepDir = appPaths(homeRoot, first.app.id).dir
  const dropDir = appPaths(homeRoot, second.app.id).dir
  check('两个应用的目录都在磁盘上', (await exists(keepDir)) && (await exists(dropDir)))

  // 造一个"发布过"的痕迹：备份裸库。删应用时要一起清掉（否则留下没人能访问的孤儿）
  const dropBackup = appPaths(homeRoot, second.app.id).backupRepo
  await mkdir(dropBackup, { recursive: true })

  console.log('\n2) 真 Chromium：打开菜单 → 删除 → 取消 → 再删除 → 确认')
  mainFile = join(home, 'e2e-apps-main.cjs')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(mainFile, electronMain(), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  // 沙箱在收窄的 shell 里初始化会失败 → 页面 ERR_FAILED（与其它 e2e 一样）
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

  const error = /E2E_ERROR (.*)/.exec(stdout)
  if (error?.[1] !== undefined) throw new Error(JSON.parse(error[1]) as string)
  const matched = /E2E_RESULT (\{.*\})/.exec(stdout)
  if (matched?.[1] === undefined) throw new Error(`Electron 没吐出结果：${stdout.slice(-600)}`)
  const ui = JSON.parse(matched[1]) as {
    headerBefore: string | null
    namesBefore: string[]
    victim: { id: string; name: string } | null
    confirmText: string
    namesAfterCancel: string[]
    namesAfter: string[]
    headerAfter: string | null
  }

  console.log('\n3) 界面上的观察')
  check('菜单里有两条', ui.namesBefore.length === 2, JSON.stringify(ui.namesBefore))
  check(`当前应用是「${DROP}」`, (ui.headerBefore ?? '').includes(DROP), String(ui.headerBefore))
  check('点删除先要二次确认（不会一下就没）', ui.confirmText.includes('不能恢复'), ui.confirmText)
  check('确认文案说了会连数据库和日志一起删', ui.confirmText.includes('数据库'), ui.confirmText)
  check('取消之后两条都还在', ui.namesAfterCancel.length === 2, JSON.stringify(ui.namesAfterCancel))
  check('确认之后菜单里只剩一条', ui.namesAfter.length === 1, JSON.stringify(ui.namesAfter))
  check('剩下的是没被删的那个', (ui.namesAfter[0] ?? '').includes(KEEP), String(ui.namesAfter[0]))
    check(`当前应用自动切到「${KEEP}」（删的正是当前那个）`, (ui.headerAfter ?? '').includes(KEEP), String(ui.headerAfter))

  console.log('\n4) 后端与磁盘同步')
  const list = await rpc<{ apps: { id: string; name: string }[] }>('app.list', { includeArchived: false })
  check('app.list 里只剩一个', list.apps.length === 1, JSON.stringify(list.apps.map((a) => a.name)))
  check('留下的那个还在', list.apps[0]?.id === first.app.id)
  check('删掉的那个目录已经不在了', !(await exists(dropDir)))
  check('留下的那个目录没被动', await exists(keepDir))
  check('发布用的备份裸库也清掉了', !(await exists(dropBackup)))
} catch (error) {
  failures += 1
  console.log(`\n✗ 中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.close().catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过：应用能从界面上建、也能从界面上删干净。')
