/**
 * Electron 主进程：**只做壳**。
 *
 * 这个文件的每一行都应该能用一句话解释"这为什么不是业务"：
 *
 * - 不 import 任何 `@tenon/*` 包：一旦主进程认识 Core，Web 模式与 Agent 自调试就都废了（铁律 1）
 * - 不知道数据库在哪、不知道模型是什么：`TENON_HOME` 由这里给，但它只负责"指一个目录"
 * - 不拼 URL、不造 Token：只从 `TENON_READY` 里读（`supervisor.ts` 负责解析）
 *
 * 它真正负责的只有生命周期：起子进程 → 等就绪 → 开窗口 → 关窗口时把子进程收干净。
 */
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { resolveDesktopPaths, type DesktopPaths } from './paths.js'
import { startSupervisor, type ServerReady, type ServerSupervisor } from './supervisor.js'

/** `TENON_SMOKE=1`：加载完后打印一条 `TENON_SMOKE {...}` 再退出（打包冒烟用，不需要人看） */
const SMOKE = process.env['TENON_SMOKE'] === '1'

let win: BrowserWindow | null = null
let supervisor: ServerSupervisor | null = null
/** 只允许停在这个 origin 上：外链交给系统浏览器，别把窗口变成浏览器 */
let serverOrigin: string | null = null

function buildEnv(paths: DesktopPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }

  // 壳告诉 server 四件事：页面在哪、模板在哪、组件在哪、数据放哪。其余全由 server 自己决定
  env['TENON_WEB_DIR'] = paths.webDir
  env['TENON_TEMPLATES_DIR'] = paths.templatesDir
  /*
   * 组件目录必须由壳来指：`@tenon/component-host` 只在开发态能按 `import.meta.url` 找到
   * `plugins/bundled`，打包进 `server.mjs` 之后那个相对位置全错 —— 而错的表现是
   * "插件页空空如也"，没有任何报错。这与 `TENON_TEMPLATES_DIR` 是同一个坑。
   */
  env['TENON_PLUGINS_DIR'] = paths.pluginsDir
  /*
   * Hub 配置同理（M6 第 5 步）：壳只**指路径**，不读内容 —— 读法是
   * `@tenon/component-host` 的 `resolveHubConfig`（壳不认识任何 `@tenon/*`，铁律 1）。
   *
   * 为什么需要这一行：环境变量在双击打开的 `.app` 里根本不存在，于是 M6 之前
   * 打包版的组件商店**永远**显示"未配置"，而且那不是错误、没人会报。
   *
   * 用 `??=`：用户显式设了 `TENON_HUB_CONFIG_FILE` 时以他为准（私有 Hub / 排障）。
   * 另外两个环境变量（`TENON_HUB_URL`/`TENON_HUB_PUBLIC_KEY`）仍由业务侧判优先级，
   * 壳不判断"配了没配"——那属于配置语义，不属于生命周期。
   */
  env['TENON_HUB_CONFIG_FILE'] ??= paths.hubConfigFile
  env['TENON_HOME'] ??= join(app.getPath('userData'), 'home')

  // 开发态便利：没配 provider 就先跑 faux，否则第一次启动只会得到"没有可用模型"
  if (!app.isPackaged && env['TENON_FAUX'] === undefined) env['TENON_FAUX'] = '1'
  return env
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    // 和界面底色一致：窗口先出现、页面后到的那一瞬不该是白屏
    backgroundColor: '#080706',
    show: false,
    webPreferences: {
      // 页面来自 http://127.0.0.1:<随机端口>，不需要任何 Node 能力
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    win = null
  })

  const wc = window.webContents

  // 外链一律出系统浏览器：窗口里没有地址栏，跳走了就回不来
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (serverOrigin !== null && new URL(url).origin === serverOrigin) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  // 页面里的 console 打到主进程 stderr，打包后排查问题全靠它。
  // 用新签名（`level` 是字符串）—— 老的位置参数在 Electron 39 里已标 deprecated
  wc.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      const where = event.sourceId === '' ? '' : ` (${event.sourceId}:${String(event.lineNumber)})`
      process.stderr.write(`[web:${event.level}] ${event.message}${where}\n`)
    }
  })

  return window
}

/** 出错时也要让人看见东西：一个能读的说明，而不是转圈的空窗口 */
function showErrorPage(target: BrowserWindow, title: string, detail: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;padding:48px;background:#080706;color:#e8e0d5;font:14px/1.7 -apple-system,system-ui,sans-serif">
<h1 style="font-size:16px;font-weight:600;margin:0 0 12px">${title}</h1>
<pre style="white-space:pre-wrap;color:#a49a8c;font-size:12.5px;margin:0">${detail.replace(/</g, '&lt;')}</pre>
</body>`
  void target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  target.show()
}

async function runSmokeProbe(target: BrowserWindow): Promise<void> {
  try {
    // 等界面真正就绪（boot 要拉 app.list / template.list / health）。
    // 不等就会拍到"正在连接本地服务…"那一帧，看起来像坏了，其实是还没开始
    const deadline = Date.now() + 20_000
    for (;;) {
      const ready = (await target.webContents.executeJavaScript(
        `document.querySelector('header') !== null && !document.body.innerText.includes('正在连接')`,
      )) as boolean
      if (ready || Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const probe = (await target.webContents.executeJavaScript(`(() => {
      const bridge = window.__TENON__ || {}
      return {
        title: document.title,
        text: (document.body.innerText || '').slice(0, 200),
        buttons: [...document.querySelectorAll('header button')].map((b) => (b.textContent || '').trim()).slice(0, 8),
        hasToken: typeof bridge.token === 'string' && bridge.token.length > 0,
        iframes: document.querySelectorAll('iframe').length,
      }
    })()`)) as {
      title: string
      text: string
      buttons: string[]
      hasToken: boolean
      iframes: number
    }
    // 带上 server 地址：退出后外面会去连它，连不上才算"子进程真收干净了"
    process.stdout.write(`TENON_SMOKE ${JSON.stringify({ ...probe, url: serverOrigin })}\n`)
  } catch (error) {
    process.stdout.write(
      `TENON_SMOKE_ERROR ${error instanceof Error ? error.message : String(error)}\n`,
    )
  } finally {
    app.quit()
  }
}

async function main(): Promise<void> {
  const paths = resolveDesktopPaths({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })

  win = createWindow()

  supervisor = startSupervisor({
    entry: paths.serverEntry,
    env: buildEnv(paths),
    onLog: (line) => {
      process.stderr.write(`[server] ${line}\n`)
    },
    onReady: (ready: ServerReady) => {
      serverOrigin = new URL(ready.url).origin
      // 首次与每次重启都会走到这里：地址和 Token 都变了，窗口必须重新加载
      win?.loadURL(ready.url).catch((error: unknown) => {
        process.stderr.write(`[tenon] 打开界面失败：${String(error)}\n`)
      })
    },
    onGaveUp: (error) => {
      if (win === null) return
      showErrorPage(win, '本机服务反复崩溃', error.message)
    },
  })

  try {
    await supervisor.ready
  } catch (error) {
    if (win !== null) {
      showErrorPage(
        win,
        '本机服务没能启动',
        error instanceof Error ? error.message : String(error),
      )
    }
    // 起不来就没有可用的产品：别留一个空壳窗口在那里
    if (!SMOKE) return
  }

  if (SMOKE && win !== null) {
    win.webContents.once('did-finish-load', () => {
      void runSmokeProbe(win!)
    })
  }
}

// 单实例：第二个实例会起第二个 server（另一个 Token、另一个 HOME），窗口却只有一个
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  // 单窗口产品：关窗就退出。留着进程 = 留着一个占端口的 server，用户下次打开会以为"卡住了"
  app.on('window-all-closed', () => {
    app.quit()
  })

  // 退出前把子进程收干净：它在写 tenon.db，被 SIGKILL 掉只会留下一个需要恢复的库
  app.on('before-quit', (event) => {
    const current = supervisor
    if (current === null) return
    supervisor = null
    event.preventDefault()
    void current.stop().finally(() => {
      app.exit(0)
    })
  })

  if (process.platform === 'win32') app.setAppUserModelId('dev.tenon.app')

  void app.whenReady().then(main)
}
