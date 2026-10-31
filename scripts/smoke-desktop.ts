/**
 * 桌面版冒烟：真的起一次 Electron，真的加载界面，然后**验证关窗之后子进程收干净了**。
 *
 * 为什么不靠人点：这条链路最贵的三个失败模式都不报错 ——
 * 1. 打包漏了 `web/`：窗口打开是空白，主进程日志干净
 * 2. 打包漏了 `templates/`：界面正常，一建应用就 500
 * 3. 退出没杀子进程：`tenon.db` 留在半开状态，下次启动看到"上次没关干净"
 *
 * 所以这里断言四件事：窗口里有内容、内容是渲染器（不是错误页）、server 地址真的在服务、
 * 进程退出之后那个地址**连不上**。`TENON_SMOKE=1` 让主进程加载完就打印一行再退出。
 */
import { spawn } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const appDir = join(repo, 'apps', 'desktop')

/**
 * `--packaged`：跑 `release/mac/Tenon.app` 里的那一份，而不是 node_modules 里的 electron。
 * 这两条路径的区别正是"开发能跑、装上白屏"的全部来源（资源在 `Contents/Resources` 而不是 `dist/`）。
 */
const PACKAGED = process.argv.includes('--packaged')

const require = createRequire(import.meta.url)
/** electron 包的默认导出就是可执行文件路径（只有在 Electron 运行时里才是 API） */
const electronPath = require(join(appDir, 'node_modules', 'electron')) as unknown as string
const packagedExe = join(appDir, 'release', 'mac', 'Tenon.app', 'Contents', 'MacOS', 'Tenon')

interface Probe {
  title: string
  text: string
  buttons: string[]
  hasToken: boolean
  iframes: number
  url: string | null
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✅ ${name}`)
  } else {
    failures += 1
    console.log(`  ❌ ${name}${detail === '' ? '' : `\n     ${detail}`}`)
  }
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-desktop-'))

  if (PACKAGED) {
    try {
      await access(packagedExe)
    } catch {
      throw new Error(`没有打包产物：${packagedExe}\n先跑 \`pnpm pack:desktop\``)
    }
  }

  const exe = PACKAGED ? packagedExe : electronPath
  const args = PACKAGED ? [] : ['.']
  console.log(`\n1) 起 ${PACKAGED ? '打包后的 Tenon.app' : 'electron .'}（HOME=${home}）`)

  /*
   * `ELECTRON_RUN_AS_NODE` 必须从环境里删掉。
   *
   * 它是给"用 Electron 的可执行文件当 node 跑 server"用的（supervisor 会显式设置），
   * 但**从 IDE / 其他 Electron 应用里启动脚本时，它会自己出现在环境变量里**（宿主就是 Electron）。
   * 带着它启动 `electron .` 的结果是：主进程被当成普通 node 跑，`import ... from 'electron'`
   * 解析到 npm 包那个"返回可执行文件路径"的 shim → 报 `does not provide an export named 'BrowserWindow'`。
   * 症状看着像 ESM 不支持，其实是环境变量。
   */
  const env: NodeJS.ProcessEnv = { ...process.env, TENON_SMOKE: '1', TENON_HOME: home, TENON_FAUX: '1' }
  delete env['ELECTRON_RUN_AS_NODE']

  /*
   * 两个只在自动化冒烟里加的开关：
   * - `--no-sandbox`：Chromium 的渲染器沙箱在受限容器/CI 里初始化不了
   *   （`sandbox initialization failed: Operation not permitted` → GPU 进程直接退出）
   * - `--disable-gpu`：同上，没有 GPU 时它会拿走整个进程（`GPU process isn't usable. Goodbye.`）
   *
   * 产品本身**不传**这两个：默认就是开沙箱的。这里只是为了让"无人值守跑一次"可行。
   */
  const child = spawn(exe, [...args, '--no-sandbox', '--disable-gpu'], {
    cwd: appDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code)
    })
  })

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !stdout.includes('TENON_SMOKE')) {
    if (child.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const line = stdout.split('\n').find((item) => item.startsWith('TENON_SMOKE '))
  check('主进程加载完了界面并回报了探针', line !== undefined, stderr.slice(-1200))

  let probe: Probe | null = null
  if (line !== undefined) {
    probe = JSON.parse(line.slice('TENON_SMOKE '.length)) as Probe
    console.log(`  标题「${probe.title}」 首屏文字：${JSON.stringify(probe.text.slice(0, 80))}`)
  }

  console.log('\n2) 界面是真的渲染器，不是错误页')
  check('首屏有内容（不是空白）', probe !== null && probe.text.trim().length > 0)
  check(
    '有交互控件（「新建应用」之类）',
    probe !== null && probe.buttons.length > 0,
    probe === null ? '' : `buttons=${JSON.stringify(probe.buttons)}`,
  )
  check('没有落到错误页', probe !== null && !probe.text.includes('没能启动'))

  console.log('\n3) 页面拿到了 Token（同源托管的注入生效）')
  /*
   * 断言落在**页面自己看到的** `window.__TENON__.token` 上，而不是外部 fetch index.html：
   * 探针打印完主进程就会退出、server 随之关闭，外部再去 fetch 是一场竞态。
   */
  check('window.__TENON__ 里有 token', probe !== null && probe.hasToken)
  check('界面没停在「正在连接本地服务」', probe !== null && !probe.text.includes('正在连接'))

  console.log('\n4) 退出后子进程收干净（端口不该再有人听）')
  const code = await exited
  check('主进程正常退出', code === 0, `exit=${String(code)}\n${stderr.slice(-800)}`)
  if (probe?.url != null) {
    let alive = false
    try {
      const response = await fetch(`${probe.url}/api/health`)
      alive = response.ok
    } catch {
      alive = false
    }
    check('server 已停止（没有孤儿进程占端口）', !alive)
  }

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
