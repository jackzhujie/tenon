/**
 * `pnpm dev:web` —— 一条命令把「server + 前端」拉起来。
 *
 * 为什么不写成 `concurrently "pnpm dev:server" "pnpm dev:web"`：
 * 前端需要 server 的**端口和 Token**，而 Token 每次启动随机（见 `server/src/auth.ts`）。
 * 所以必须先起 server、读它打印的 `TENON_READY {json}`，再把这两个值注入 Vite。
 * 猜端口或写死 Token 都会让页面在某个时刻以一个看不懂的 401 白屏。
 *
 * 默认开 `TENON_FAUX=1`：第一次跑这个项目的人手上不一定有 API Key，
 * 而 faux 能把「提交 → 流式 → 落库 → 提交 git」这条链路完整跑一遍。
 * 想接真模型就 `TENON_FAUX=0 pnpm dev:web`。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDir = join(root, 'apps', 'web')

interface ReadyInfo {
  url: string
  port: number
  token: string
  home: string
  model: { mode: string; modelId: string } | null
}

/**
 * 找到某个包真正的 **JS 入口**（不是 `node_modules/.bin` 里那个壳）。
 *
 * 踩过的坑：`.bin/tsx` 在 POSIX 上是一段 `sh` 脚本（`basedir=$(dirname ...)`），
 * 用 `node .bin/tsx` 启动会直接 `SyntaxError: missing ) after argument list` ——
 * 而且报错看起来像 tsx 坏了，其实是启动方式错了。
 * 所以这里读包自己的 `package.json.bin`，拿它指向的 `.js/.mjs` 交给 node 跑：
 * 少一层 shell、跨平台一致，也顺带绕开 Windows 上 `.bin/*.cmd` 的差异。
 */
function resolvePackageBin(pkgName: string): string {
  const searchDirs = [join(webDir, 'node_modules', pkgName), join(root, 'node_modules', pkgName)]
  for (const dir of searchDirs) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const bin =
      typeof parsed.bin === 'string'
        ? parsed.bin
        : (parsed.bin?.[pkgName] ?? Object.values(parsed.bin ?? {})[0])
    if (bin === undefined) continue
    const target = join(dir, bin)
    if (existsSync(target)) return target
  }
  throw new Error(`找不到 ${pkgName} 的入口，先跑一次 pnpm install`)
}

const children = new Set<ChildProcess>()
let shuttingDown = false

/**
 * 开发态把官方 Hub 的地址与公钥注进去（`apps/desktop/hub.defaults.json`）。
 *
 * 不注的话，`pnpm dev:web` 起来的 server 商店永远是"未配置" —— 而那不是一个错误，
 * 界面上只是一片空，没人会报上来。打包版有 `dist/hub.json` 兜底，开发态没有，
 * 所以这一档单独补：两处都读同一个文件，不会各写一套。
 *
 * 环境变量优先：设了 `TENON_HUB_URL` 就完全交给它（私有 Hub / 排障）。
 */
function hubEnvDefaults(): Record<string, string> {
  if ((process.env['TENON_HUB_URL'] ?? '').trim() !== '') return {}
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, 'apps', 'desktop', 'hub.defaults.json'), 'utf8'),
    ) as { hubUrl?: unknown; publicKey?: unknown }
    if (typeof parsed.hubUrl !== 'string' || typeof parsed.publicKey !== 'string') return {}
    if (parsed.hubUrl === '' || parsed.publicKey === '') return {}
    return { TENON_HUB_URL: parsed.hubUrl, TENON_HUB_PUBLIC_KEY: parsed.publicKey }
  } catch {
    // 读不到就当没配：开发态拿不到商店不该让 dev 起不来
    return {}
  }
}

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  // 给子进程一点收尾时间（vite 要关监听、server 要关库），然后兜底
  setTimeout(() => process.exit(code), 400)
}

function wireSignals(child: ChildProcess): void {
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown) return
    process.stderr.write(
      `\n[dev:web] 子进程退出（code=${String(code)} signal=${String(signal)}），一并关闭。\n`,
    )
    shutdown(code ?? 1)
  })
}

async function startServer(): Promise<ReadyInfo> {
  const bin = join(root, 'packages', 'server', 'src', 'bin.ts')
  const faux = process.env['TENON_FAUX'] ?? '1'

  const child = spawn(process.execPath, [resolvePackageBin('tsx'), bin], {
    cwd: root,
    env: { ...process.env, TENON_FAUX: faux, ...hubEnvDefaults() },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  wireSignals(child)

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
  })

  const stdout = child.stdout
  if (stdout === null) throw new Error('server 没有 stdout')

  const lines = createInterface({ input: stdout })
  return await new Promise<ReadyInfo>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('等 TENON_READY 超时（30s）：server 起了但没报告地址'))
    }, 30_000)

    lines.on('line', (line) => {
      if (!line.startsWith('TENON_READY ')) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(line.slice('TENON_READY '.length)) as ReadyInfo)
      } catch (err) {
        reject(new Error(`TENON_READY 解析失败：${String(err)}`))
      }
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server 启动失败（code=${String(code)}）`))
    })
  })
}

async function main(): Promise<void> {
  process.stdout.write('[dev:web] 启动本地 server…\n')
  const ready = await startServer()

  const modelText =
    ready.model === null ? '未配置模型' : `${ready.model.mode} · ${ready.model.modelId}`
  process.stdout.write(`[dev:web] server 就绪 ${ready.url}（模型：${modelText}）\n`)
  if (ready.model?.mode === 'faux') {
    process.stdout.write('[dev:web] 用的是本地假模型，回复是固定文案 —— 只验证链路，不是真回答。\n')
  }

  const webPort = process.env['TENON_WEB_PORT'] ?? '5173'
  const vite = spawn(process.execPath, [resolvePackageBin('vite')], {
    cwd: webDir,
    env: {
      ...process.env,
      TENON_SERVER_URL: ready.url,
      TENON_SERVER_TOKEN: ready.token,
      TENON_WEB_PORT: webPort,
    },
    stdio: 'inherit',
  })
  wireSignals(vite)

  process.stdout.write(`\n[dev:web] 打开 http://127.0.0.1:${webPort}\n\n`)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stdout.write(`\n[dev:web] 收到 ${signal}，正在关闭…\n`)
    shutdown(0)
  })
}

main().catch((err: unknown) => {
  process.stderr.write(`[dev:web] ${err instanceof Error ? err.message : String(err)}\n`)
  shutdown(1)
})
