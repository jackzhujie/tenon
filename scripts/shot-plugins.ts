/**
 * 插件页「检查更新 → 更新」的**人眼验收**（M6 第 2 步）。
 *
 * 单测能证明 hub.check 算出"有新版"、hub.install 换了版本，但证明不了**用户能不能看懂**：
 * 那一行是不是写清"1.1.0 → 1.2.0"、点完按钮版本号有没有当场变、连不上 Hub 时是不是
 * 一句灰字而不是红屏。这些只能看。
 *
 * 这个脚本做的事（全是真的）：
 *   1. 生成一对 Ed25519 密钥，把**真的** AI 小助手打成 1.1.0 与 1.2.0 两个签名包
 *   2. 起一个假 Hub（真发 /index.json 与包），服务端按 TENON_HUB_URL 配上去
 *   3. 建应用 → 装内置 1.0.0 → 从 Hub 装 1.1.0（走真 RPC）
 *   4. 真 Chromium：开插件页 → 截图 → 点「检查更新」→ 截图 → 点「更新」→ 截图
 *   5. 断言：点更新前界面写着 v1.1.0 → v1.2.0；点完之后列表里是 v1.2.0
 *
 * 截图里那条「没加载起来（原因见下）」是**预期**的：脚本没起预览（起预览要联网装 React），
 * 而组件是在预览启动时才激活的。别把它当成 bug。
 *
 * 用法：`pnpm shot:plugins`（先 build:web）→ /tmp/tenon-plugins/*.png
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HUB_INDEX_FORMAT,
  installComponent,
  signBundle,
  signHubIndex,
  type HubIndexComponent,
} from '../packages/component-host/src/index.js'
import { appPaths, resolveHome } from '../packages/core/src/index.js'
import { startServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'shot-token'
const outDir = '/tmp/tenon-plugins'
const COMPONENT = 'tenon.official.ai-assistant'
await mkdir(outDir, { recursive: true })

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/* ---------- 1. 用真的组件内容打两个版本的签名包 ---------- */

const CSV = 'tenon.official.csv-export'

/** 用**真的**组件内容造一个包（版本号由这里定，内容与内置那份一样） */
async function makeBundle(id: string, version: string): Promise<unknown> {
  const dir = join(repo, 'plugins', 'bundled', id)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const files: Record<string, string> = {}
  for (const name of ['server.js', 'web.js']) {
    const content = await readFile(join(dir, name), 'utf8').catch(() => '')
    if (content === '') {
      console.error(`缺 ${id}/${name} —— 先跑 pnpm build:plugins`)
      process.exit(1)
    }
    files[name] = content
  }
  // README 可选（与 pack:plugin 一致：它是给 Agent 读的说明，不是运行时必需）
  const readme = await readFile(join(dir, 'README.md'), 'utf8').catch(() => '')
  if (readme !== '') files['README.md'] = readme
  return signBundle({ format: 1, manifest: { ...manifest, version, source: 'hub' } as never, files }, PRIVATE_PEM)
}

const bundles: Record<string, unknown> = {
  [`${COMPONENT}-1.1.0`]: await makeBundle(COMPONENT, '1.1.0'),
  [`${COMPONENT}-1.2.0`]: await makeBundle(COMPONENT, '1.2.0'),
  // 商店里要有一个"这个应用还没装"的组件，否则看到的是空列表
  [`${CSV}-1.0.0`]: await makeBundle(CSV, '1.0.0'),
}

/* ---------- 2. 假 Hub：真发索引与包 ---------- */

/** Hub 上"现在发布了哪些版本"。更新这件事的本质就是它会变 */
let publishedAi = ['1.0.0', '1.1.0']

const hub = createServer((req, res) => {
  const url = req.url ?? ''
  if (url === '/index.json') {
    const origin = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
    const components: HubIndexComponent[] = [
      {
        id: COMPONENT,
        name: 'AI 小助手',
        description: '应用内悬浮球 + 对话（宿主注入模型能力）',
        versions: publishedAi.map((version) => ({
          version,
          url: `${origin}/bundles/${COMPONENT}-${version}.json`,
          notes: version === '1.2.0' ? '回答支持中断；球可以拖到任意角落' : '首个 Hub 版',
          publishedAt: Date.now(),
        })),
      },
      {
        id: CSV,
        name: '导出 CSV',
        description: '抓页面上的 table 导成 CSV（Excel 直接打开）',
        versions: [
          {
            version: '1.0.0',
            url: `${origin}/bundles/${CSV}-1.0.0.json`,
            notes: '首个 Hub 版',
            publishedAt: Date.now(),
          },
        ],
      },
    ]
    const index = signHubIndex(
      { format: HUB_INDEX_FORMAT, generatedAt: Date.now(), components },
      PRIVATE_PEM,
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(index))
    return
  }
  const match = /^\/bundles\/(.+)\.json$/.exec(url)
  const payload = match === null ? undefined : bundles[match[1] ?? '']
  if (payload !== undefined) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', () => resolve()))
const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-plugins-'))
const server = await startServer({
  port: 0,
  token: TOKEN,
  env: {
    TENON_HOME: home,
    TENON_FAUX: '',
    TENON_HUB_URL: hubUrl,
    // 环境变量里换行写成 \n（与真实部署时 .env 的写法一致）
    TENON_HUB_PUBLIC_KEY: PUBLIC_PEM.replaceAll('\n', '\\n'),
  },
  webDir: join(repo, 'apps', 'web', 'dist'),
})
console.log(`服务 ${server.url}`)
console.log(`假 Hub ${hubUrl}`)

async function rpc<T>(method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: { message?: string } }
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.message ?? '未知'}`)
  return body.data as T
}

function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const win = new BrowserWindow({ show: false, width: 1200, height: 860 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await sleep(2500)

  // 打开插件页
  const opened = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim().startsWith('插件'))
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(700)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/1-插件页.png', img.toPNG()))

  // 点「检查更新」
  const checked = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '检查更新')
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(1500)
  const before = await frame.executeJavaScript(\`(() => {
    const text = document.body.innerText || ''
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line !== '')
    const row = lines.find((line) => line.indexOf('v1.1.0') !== -1 && line.indexOf('v1.2.0') !== -1) || null
    return { hasUpdateRow: row !== null, row: row, text: text.slice(0, 1200) }
  })()\`)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/2-有更新.png', img.toPNG()))

  // 点「更新」
  const clicked = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '更新')
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(3000)
  const after = await frame.executeJavaScript(\`(() => {
    const text = document.body.innerText || ''
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line !== '')
    const notice = lines.find((line) => line.indexOf('已更新到') === 0) || lines.find((line) => line.indexOf('已装好') === 0) || null
    return { has12: text.indexOf('v1.2.0') !== -1, notice: notice, text: text.slice(0, 1200) }
  })()\`)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/3-已更新.png', img.toPNG()))

  // 商店：这里应该有一个"这个应用还没装"的组件（导出 CSV）
  const storeOpened = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '商店')
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(1800)
  const store = await frame.executeJavaScript(\`(() => {
    const text = document.body.innerText || ''
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line !== '')
    const row = lines.find((line) => line.indexOf('导出 CSV') !== -1) || null
    return { hasCsv: row !== null, row: row, text: text.slice(0, 1200) }
  })()\`)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/4-商店.png', img.toPNG()))

  // 点「下载并安装」
  /*
   * 点**那一行**的按钮，不是"页面上第一个装按钮"。商店里同时有"导出 CSV"与"审批流"
   * 两个可装项（本机 bundled 的那两个），按文案取第一个会装错 —— 我第一次就装成了审批流。
   */
  const storeClicked = await frame.executeJavaScript(\`(() => {
    const row = [...document.querySelectorAll('li')].find((node) => (node.textContent || '').indexOf('导出 CSV') !== -1)
    if (!row) return false
    const btn = [...row.querySelectorAll('button')].find((node) => {
      const label = (node.textContent || '').trim()
      return label === '下载并安装' || label === '装到此应用'
    })
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(4000)

  // 回到「已装」：现在应该有两个组件
  const backToInstalled = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim().indexOf('已装') === 0)
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(1200)
  const installedView = await frame.executeJavaScript(\`(() => {
    const text = document.body.innerText || ''
    const count = [...document.querySelectorAll('li')].filter((node) => (node.textContent || '').indexOf('tenon.official.') !== -1).length
    return {
      hasCsv: text.indexOf('导出 CSV') !== -1,
      both: text.indexOf('AI 小助手') !== -1 && text.indexOf('导出 CSV') !== -1,
      count: count
    }
  })()\`)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/5-装完.png', img.toPNG()))

  await win.close()
  return { opened, checked, before, clicked, after, storeOpened, store, storeClicked, backToInstalled, installedView }
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

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures += 1
}

try {
  /* ---------- 3. 建应用 + 装内置 1.0.0 + 从 Hub 装 1.1.0 ---------- */

  /*
   * 界面语言先钉成中文：这一趟的断言全是中文文案（"下载并安装"、"已装"、"导出 CSV"）。
   * 不钉的话，在英文系统上跑会整片红 —— 看起来像功能坏了，其实只是脚本在按中文找按钮。
   */
  await rpc('settings.set', { values: { 'ui.locale': 'zh' } })

  const created = await rpc<{ app: { id: string } }>('app.create', { name: '组件更新演示' })
  const appId = created.app.id
  const repoDir = appPaths(resolveHome({ TENON_HOME: home }), appId).repoDir
  await installComponent({
    repoDir,
    roots: [{ kind: 'bundled', dir: join(repo, 'plugins', 'bundled') }],
    tenonVersion: '0.0.0',
    id: COMPONENT,
    mounts: [{ slot: 'app.shell.overlay', order: 100 }],
  })

  const installed = await rpc<{ version: string; reloadedApps: number }>('hub.install', {
    id: COMPONENT,
    version: '1.1.0',
  })
  console.log(`从 Hub 装了 v${installed.version}（重载 ${installed.reloadedApps} 个应用）`)
  // Hub 之后又发了一版：这是"检查更新"要看见的东西
  publishedAi = ['1.0.0', '1.1.0', '1.2.0']

  const status = await rpc<{ configured: boolean; hubUrl: string | null }>('hub.status')
  check('Hub 已配置（配置从环境变量读进来）', status.configured && status.hubUrl === hubUrl)

  const beforeCheck = await rpc<{ components: { installedVersion: string | null; latest: string; update: boolean }[] }>(
    'hub.check',
  )
  check(
    'RPC 层面：1.1.0 已装、1.2.0 可更新',
    beforeCheck.components[0]?.installedVersion === '1.1.0' &&
      beforeCheck.components[0]?.latest === '1.2.0' &&
      beforeCheck.components[0]?.update === true,
    JSON.stringify(beforeCheck.components[0]),
  )

  /* ---------- 4. 真 Chromium 里点一遍 ---------- */

  const mainFile = join(home, 'shot-main.cjs')
  await writeFile(mainFile, electronMain(), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  // 沙箱在被收窄的 shell 里会初始化失败 → network service 崩 → 打开本地页面 ERR_FAILED
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
    }, 150_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const shot = /SHOT (\{.*\})/.exec(stdout)
  if (shot?.[1] === undefined) {
    console.error(stdout.slice(-800))
    throw new Error('Electron 没吐出结果')
  }
  const result = JSON.parse(shot[1]) as {
    opened: boolean
    checked: boolean
    before: { hasUpdateRow: boolean; row: string | null }
    clicked: boolean
    after: { has12: boolean; notice: string | null }
    storeOpened: boolean
    store: { hasCsv: boolean; row: string | null }
    storeClicked: boolean
    backToInstalled: boolean
    installedView: { hasCsv: boolean; both: boolean; count: number }
  }

  check('插件页打得开', result.opened)
  check('「检查更新」按钮点了有反应', result.checked)
  check('界面上写着 1.1.0 → 1.2.0', result.before.hasUpdateRow, result.before.row ?? '')
  check('「更新」按钮点得动', result.clicked)
  check('更新完界面显示 1.2.0', result.after.has12, result.after.notice ?? '')

  check('商店页签打得开', result.storeOpened)
  check('商店里列出了没装过的组件（导出 CSV）', result.store.hasCsv, result.store.row ?? '')
  check('「下载并安装」按钮点得动', result.storeClicked)
  check('装完回到「已装」，两个组件都在', result.backToInstalled && result.installedView.both, result.installedView.count + ' 行')

  const appsAfter = await rpc<{ components: { id: string; version: string; source: string }[] }>(
    'component.list',
    { appId },
  )
  /*
   * 注意 source 是 **bundled**：导出 CSV 本来就随包（本机有），所以商店优先装本机那份，
   * 不走网络。这正是想要的顺序 —— "本机能装的不该因为没网就装不了"。
   * （Hub 下载那条路在 `component-store.test.ts` 里验：本机没有 → downloaded=true。）
   */
  check(
    '装配声明里真的多了第二个组件，且优先用本机那份（没白下）',
    appsAfter.components.length === 2 &&
      appsAfter.components.some(
        (item) => item.id === 'tenon.official.csv-export' && item.source === 'bundled',
      ),
    JSON.stringify(appsAfter.components.map((item) => item.id + '@' + item.version + '(' + item.source + ')')),
  )

  const finalCheck = await rpc<{ components: { installedVersion: string | null; update: boolean }[] }>('hub.check')
  check(
    '更新之后再查：已是最高版（不再提示更新）',
    finalCheck.components[0]?.installedVersion === '1.2.0' && finalCheck.components[0]?.update === false,
    JSON.stringify(finalCheck.components[0]),
  )

  console.log(`\n截图在 ${outDir}`)
  if (failures > 0) {
    console.error(`\n${failures} 项失败`)
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
} finally {
  await server.close()
  await new Promise<void>((resolve) => hub.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
}
