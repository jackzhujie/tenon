/**
 * 导出「静态包」：把一个生成出来的应用变成一个**能拷走就跑的目录**（DESIGN §13.1）。
 *
 * 这是「发布」的另一半。现在能做的只有「冻结版本 + 本地裸库」（§13.3）—— 那是给
 * 人看的代码备份；而用户真正要拿出去的是**能上线的东西**。
 *
 * 产物长这样（`<home>/apps/<appId>/exports/<时间戳>/`）：
 *
 * ```
 *   dist/            前端产物（vitest build）
 *   dist-server/     后端产物（tsc -p tsconfig.server.json）
 *   node_modules/    只装 prod（真的能不联网直接跑）
 *   package.json  pnpm-lock.yaml
 *   serve.mjs        单端口启动器：静态文件 + /api 反代（生成，源码里没有）
 *   start.sh         一条命令起来（生成）
 *   .env.example     要配什么（生成）
 *   README.md        怎么部署（生成）
 * ```
 *
 * 四个刻意的决定：
 *
 * 1. **产物里没有 pglite。** PGlite 是「预览用的零安装数据库」，而生产产物只认
 *    `DATABASE_URL`。把 wasm + pg-gateway 塞进产物会让它变成一个"自带数据库的运行时"，
 *    那是另一个产品（也违背 §6.4 把 pglite 定位成开发档）。
 * 2. **单端口靠一个生成的 `serve.mjs`**，不改应用源码。生成的模板里后端只监听
 *    `127.0.0.1` 的 `/api`，前端是静态文件 —— 要让"一个端口对外"成立，得有人在前面
 *    分流。放进模板会让所有应用都背着一段"生产用的代码"（铁律 2 的反面）。
 * 3. **跑模板自己的 `build` / `build:api`**，不在导出的代码里重写构建命令。Agent 可能
 *    改了 `build`（加 prebuild、换 bundler），自己拼 `vite build` 就会与它脱节。
 * 4. **默认带上 prod 依赖**（`pnpm install --prod`）。这让产物真的"拷到服务器就能跑"；
 *    代价是导出时要联网（或者命中 pnpm store）与几十 MB 的体积。给 `installDeps: false`
 *    可以关掉，产物里就只留 lock 文件。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { invokePnpm, resolvePnpm, withNodeShim } from '@tenon/core'
import { ensureDeps, nodeRunEnv } from '@tenon/gateway'
import { msg, TenonError } from '@tenon/protocol'

/** 构建可能真的要几分钟（tsc + vite + 冷缓存），但"跑了一小时"就是在绕圈 */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 失败时贴给用户的最后几行（与 preview 的日志哲学一致：够用、不淹没） */
const LOG_TAIL = 30

export interface StaticExportOptions {
  readonly repoDir: string
  /** 产物目录。调用方负责用 `appPaths(…).exportsDir` 拼出来 */
  readonly outDir: string
  readonly appName: string
  /** 产物 README 里要写的两件事：这应用叫什么、它从哪来 */
  readonly appId: string
  /** 设成 false 就只产出代码与 lock，不装依赖（测试用，也方便"我自己装"的人） */
  readonly installDeps?: boolean
  /**
   * `docker` = 额外生成 `Dockerfile` / `docker-compose.yml` / `.dockerignore`，
   * 并且**不装宿主的 node_modules**（镜像是 linux，宿主是 macOS，依赖要在镜像里装）。
   */
  readonly target?: 'static' | 'docker'
  /** compose 里对外映射的端口（默认 3000） */
  readonly port?: number
  /** 每读一行输出回调一次（进度展示；也给 e2e 当观测点） */
  readonly onLog?: (line: string) => void
  /** 注入 pnpm（默认 `resolvePnpm(process.env)`）。测试里换成一个假的 */
  readonly env?: NodeJS.ProcessEnv
}

export interface StaticExportResult {
  readonly dir: string
  /** 这份产物是给谁用的（`static` = 拷走直接跑；`docker` = 构建上下文） */
  readonly target: 'static' | 'docker'
  /** 产物的文件数（不含 node_modules —— 那个数没意义，几万） */
  readonly files: number
  /** 产物字节数（含 node_modules，用户关心的是"要传多大"） */
  readonly bytes: number
  /** 这个应用有后端吗（决定 start.sh 起的进程、README 的说明） */
  readonly hasApi: boolean
  /** 导出时的应用版本号（`package.json` 的 `version`） */
  readonly version: string | null
  /** 导出时的 HEAD（产物与哪一版代码对应） */
  readonly headSha: string | null
}

interface PackageJson {
  readonly name?: unknown
  readonly version?: unknown
  readonly scripts?: Record<string, unknown>
  readonly tenon?: { readonly api?: unknown }
}

async function readPackageJson(repoDir: string): Promise<PackageJson> {
  const file = join(repoDir, 'package.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new TenonError('EXPORT_FAILED', msg('error.export.noPackage'), { repoDir })
  }
  try {
    return JSON.parse(raw) as PackageJson
  } catch (error) {
    throw new TenonError('EXPORT_FAILED', msg('error.export.badJson'), {
      repoDir,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 跑一条一次性的命令（与 `spawnLogged` 的区别：那个管长驻进程，这个等它结束）。
 *
 * 返回值只有退出码与输出 —— 调用方决定"非零要不要抛"，因为 `pnpm run build` 与
 * `pnpm install` 的失败含义不同（一个是代码坏了，一个是网络/磁盘）。
 */
async function runOnce(options: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** Windows 上 pnpm 是 `.cmd`，必须经过 shell（见 `invokePnpm`） */
  shell?: boolean
  onLog?: (line: string) => void
  label: string
}): Promise<{ code: number | null; output: string }> {
  const lines: string[] = []
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      // 应用自己的 `.bin/*` 是 `exec node` 的 shim —— 打包版里得给它一个 node
      env: withNodeShim(options.env),
      shell: options.shell === true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      lines.push(`[tenon] ${options.label} timed out after ${Math.round(options.timeoutMs / 1000)}s, killed`)
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue
        lines.push(line)
        options.onLog?.(line)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      // 进程压根没起来（找不到 pnpm / 没有执行权限）：把原因留在输出里，别只给一个 null
      lines.push(`[tenon] could not start (${options.command}): ${error.message}`)
      clearTimeout(timer)
      resolve(null)
    })
    child.on('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  return { code, output: lines.slice(-LOG_TAIL).join('\n') }
}

/** 用 pnpm 跑一个 script。打包态下 pnpm 是随包的 `.cjs`，必须用 node 跑 */
async function runScript(options: {
  repoDir: string
  script: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  onLog?: (line: string) => void
}): Promise<{ code: number | null; output: string }> {
  const pnpm = resolvePnpm(options.env)
  const call = invokePnpm(pnpm, ['run', options.script])
  return runOnce({
    command: call.command,
    args: call.args,
    shell: call.shell,
    cwd: options.repoDir,
    env: pnpm.isScript ? nodeRunEnv(options.env) : options.env,
    timeoutMs: options.timeoutMs,
    label: `pnpm run ${options.script}`,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  })
}

/** 递归数文件与字节（跳过 `node_modules` 的计数交给调用方单独算） */
async function measure(dir: string, skip: readonly string[] = []): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { files, bytes }
  }
  for (const name of entries) {
    const full = join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) {
      if (skip.includes(name)) {
        // 跳过的目录只统计体积，不数文件（node_modules 里几万个文件，数它没有意义）
        bytes += await dirBytes(full)
        continue
      }
      const inner = await measure(full, skip)
      files += inner.files
      bytes += inner.bytes
    } else {
      files += 1
      bytes += info.size
    }
  }
  return { files, bytes }
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for (const name of await readdir(dir)) {
    const full = join(dir, name)
    const info = await stat(full)
    total += info.isDirectory() ? await dirBytes(full) : info.size
  }
  return total
}

/** 只拷这些（白名单，不是黑名单：漏拷一个新目录比多拷一堆垃圾好查） */
const COPY_ENTRIES = ['dist', 'dist-server', 'package.json', 'pnpm-lock.yaml', 'README.md'] as const

/**
 * 产物的目录名：`20261104-224512`（本地时间）。
 *
 * 为什么按时间戳而不是版本号：同一版代码可能导两次（改了配置、换一台机器），
 * 按版本号会让第二次覆盖第一次，而用户手上那份可能已经在服务器上跑着了。
 * 本地时间而不是 UTC：这是给人看的目录名，用户会拿它跟"我刚才那次"对。
 */
/**
 * 失败消息里带**最后几行**输出。
 *
 * 原来只有一句"构建失败（退出码 1）"，用户既看不出原因，也不知道去哪儿看
 * （完整输出在日志面板里，但要自己翻）。把尾巴贴进消息，对话框里就能判断是
 * 类型错误、还是并发/磁盘/网络。
 */
function tailOf(output: string, lines = 6, max = 400): string {
  const tail = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join('\n')
  if (tail === '') return ''
  const clipped = tail.length > max ? `…${tail.slice(-max)}` : tail
  return `\n${clipped}`
}

export function exportStamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}-${time}`
}

/**
 * 同一个仓库同时只允许一次导出。
 *
 * 两次导出都调 `pnpm run build`，而 vite build 会**先清空 `dist/`** ——
 * 并发跑的时候后一个把前一个的产物删掉，前一个就报"构建失败（退出码 1）"。
 * 用户看到的是"导出静态包成功、导出 Docker 失败"这种莫名其妙的不一致
 * （两个按钮点得快就会这样），而代码本身完全没问题。
 */
const running = new Map<string, true>()

/** 互斥本身抽出来：它没有 I/O，可以直接单测（导出真跑一次要几十秒） */
export async function withExportLock<T>(repoDir: string, task: () => Promise<T>): Promise<T> {
  if (running.has(repoDir)) {
    throw new TenonError(
      'EXPORT_FAILED',
      msg('error.export.busyExporting'),
      { phase: 'busy' },
    )
  }
  running.set(repoDir, true)
  try {
    return await task()
  } finally {
    running.delete(repoDir)
  }
}

export async function exportStatic(options: StaticExportOptions): Promise<StaticExportResult> {
  return withExportLock(options.repoDir, () => runExport(options))
}

async function runExport(options: StaticExportOptions): Promise<StaticExportResult> {
  const env = options.env ?? process.env
  const pkg = await readPackageJson(options.repoDir)
  const scripts = pkg.scripts ?? {}
  const apiEntry = typeof pkg.tenon?.api === 'string' ? pkg.tenon.api : null
  const hasApi = apiEntry !== null

  if (typeof scripts['build'] !== 'string') {
    throw new TenonError('EXPORT_FAILED', msg('error.export.noBuildScript'), {
      repoDir: options.repoDir,
    })
  }

  /*
   * 0) 依赖。模板的 `build` 要 vite 与 tsc，而"从没起过预览就直接导出"完全可能
   * （用户建完应用先去点了导出）。复用 preview 的 `ensureDeps` 而不是自己拼
   * `pnpm install`：它已经处理了超时、日志尾、打包态下的随包 pnpm。
   */
  try {
    await ensureDeps({
      repoDir: options.repoDir,
      env,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    })
  } catch (error) {
    throw new TenonError('EXPORT_FAILED', msg('error.export.installFailed'), {
      phase: 'deps',
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  /* 1) 构建：先前端（模板的 build 通常含 typecheck），再后端 */
  const front = await runScript({
    repoDir: options.repoDir,
    script: 'build',
    env,
    timeoutMs: BUILD_TIMEOUT_MS,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  })
  if (front.code !== 0) {
    throw new TenonError(
      'EXPORT_FAILED',
      msg('error.export.buildFailed', { code: front.code ?? 'null', tail: tailOf(front.output) }),
      { phase: 'build', output: front.output },
    )
  }

  if (hasApi) {
    if (typeof scripts['build:api'] !== 'string') {
      // 有后端却没有构建脚本 —— 说清是哪一半缺，别让它变成一个"导出成功但跑不起来"的包
      throw new TenonError(
        'EXPORT_FAILED',
        msg('error.export.noBuildApi'),
        { api: apiEntry },
      )
    }
    const back = await runScript({
      repoDir: options.repoDir,
      script: 'build:api',
      env,
      timeoutMs: BUILD_TIMEOUT_MS,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    })
    if (back.code !== 0) {
      throw new TenonError(
        'EXPORT_FAILED',
        msg('error.export.apiBuildFailed', { code: back.code ?? 'null', tail: tailOf(back.output) }),
        { phase: 'build:api', output: back.output },
      )
    }
  }

  const distDir = join(options.repoDir, 'dist')
  if (!existsSync(distDir)) {
    // 构建说成功但产物不在 —— 后端脚本改写、vite 配了别的 outDir，都是这种表现
    throw new TenonError('EXPORT_FAILED', msg('error.export.noDist'), {
      repoDir: options.repoDir,
    })
  }

  /* 2) 收集：outDir 先清空（重复导出要幂等），再按白名单拷 */
  await mkdir(options.outDir, { recursive: true })
  for (const name of await readdir(options.outDir)) {
    await rm(join(options.outDir, name), { recursive: true, force: true })
  }
  for (const name of COPY_ENTRIES) {
    const from = join(options.repoDir, name)
    if (!existsSync(from)) continue
    await cp(from, join(options.outDir, name), { recursive: true })
  }

  /* 3) 生成四个文件：启动器、启动脚本、环境变量示例、部署说明 */
  const target = options.target ?? 'static'
  const hasLock = existsSync(join(options.repoDir, 'pnpm-lock.yaml'))
  await writeFile(join(options.outDir, 'serve.mjs'), renderServe({ hasApi }), 'utf8')
  await writeFile(join(options.outDir, 'start.sh'), renderStart({ hasApi }), { encoding: 'utf8', mode: 0o755 })
  await writeFile(join(options.outDir, '.env.example'), renderEnvExample({ hasApi }), 'utf8')
  await writeFile(
    join(options.outDir, 'README.md'),
    renderReadme({
      appName: options.appName,
      appId: options.appId,
      hasApi,
      hasLock,
    }),
    'utf8',
  )

  /*
   * 3b) Docker 产物：三个文本文件。**依赖仍然不在宿主上装** ——
   * 镜像是 linux、宿主是 macOS，只要有一个原生模块就会"起来即崩"，
   * 而那种错看起来像"代码有问题"。所以 `pnpm install --prod` 写在 Dockerfile 里。
   */
  if (target === 'docker') {
    await writeFile(join(options.outDir, 'Dockerfile'), renderDockerfile({ hasApi, hasLock }), 'utf8')
    await writeFile(
      join(options.outDir, 'docker-compose.yml'),
      renderCompose({ appName: options.appName, hasApi, port: options.port ?? 3000 }),
      'utf8',
    )
    await writeFile(join(options.outDir, '.dockerignore'), renderDockerignore(), 'utf8')
  }

  /* 4) prod 依赖：让静态包真的能"拷到服务器就跑"（Docker 产物不需要，镜像里装） */
  if (target === 'static' && options.installDeps !== false) {
    const pnpm = resolvePnpm(env)
    const args = ['install', '--prod', '--prefer-offline', '--reporter=append-only']
    if (existsSync(join(options.outDir, 'pnpm-lock.yaml'))) args.push('--frozen-lockfile')
    const installCall = invokePnpm(pnpm, args)
    const installed = await runOnce({
      command: installCall.command,
      args: installCall.args,
      shell: installCall.shell,
      cwd: options.outDir,
      env: pnpm.isScript ? nodeRunEnv(env) : env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      label: 'pnpm install --prod',
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    })
    if (installed.code !== 0) {
      throw new TenonError('EXPORT_FAILED', msg('error.export.prodInstallFailed', { code: installed.code ?? 'null' }), {
        phase: 'install',
        output: installed.output,
      })
    }
  }

  const measured = await measure(options.outDir, ['node_modules'])
  return {
    dir: options.outDir,
    target,
    files: measured.files,
    bytes: measured.bytes,
    hasApi,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    headSha: await headOf(options.repoDir),
  }
}

async function headOf(repoDir: string): Promise<string | null> {
  try {
    const head = (await readFile(join(repoDir, '.git', 'HEAD'), 'utf8')).trim()
    if (head.startsWith('ref: ')) {
      const ref = await readFile(join(repoDir, '.git', head.slice(5)), 'utf8')
      return ref.trim()
    }
    return head
  } catch {
    return null
  }
}

/**
 * 单端口启动器。**这是产物的一部分，不是应用的源码** —— 应用代码不该知道自己被导出，
 * 也不该出现 `if (production)` 这种分支（铁律 2 的精神）。
 *
 * 职责只有两条：`/api/*` 转给后端子进程，其余按静态文件发（找不到就回 index.html）。
 * 不做压缩、不做缓存头 —— 那是反向代理该干的，写在这里只会让人以为它做了。
 */
export function renderServe(input: { hasApi: boolean }): string {
  return `/**
 * 单端口启动器（由 Tenon 导出时生成，不是应用的源码）。
 *
 *   /api/*  → 后端子进程（${input.hasApi ? 'dist-server/api/main.js' : '本应用没有后端'}）
 *   其余    → dist/ 下的静态文件，找不到就回 index.html（前端路由）
 *
 * 环境变量：PORT（默认 3000）、HOST（默认 0.0.0.0）、API_PORT（默认 PORT+1）
 */
import { createServer, request } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const API_PORT = Number(process.env.API_PORT ?? PORT + 1)
const CLIENT_DIR = join(here, 'dist')
const API_ENTRY = join(here, 'dist-server', 'api', 'main.js')
const HAS_API = ${input.hasApi ? 'true' : 'false'}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}
const mimeOf = (file) => MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream'

let api = null

if (HAS_API) {
  api = spawn(process.execPath, [API_ENTRY], {
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: 'inherit'
  })
  api.on('exit', (code, signal) => {
    console.error('[serve] backend exited (' + (signal ?? code) + '); stopping the whole server')
    process.exit(1)
  })
}

/** /api/* 转给后端。用 pipe 而不是自己攒 body：上传大文件时攒会爆内存 */
function proxy(req, res) {
  const upstream = request(
    { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    }
  )
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('The backend is not up (or has exited). Check the log of this process.')
  })
  req.pipe(upstream)
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0] ?? '/'
  if (HAS_API && url.startsWith('/api/')) return proxy(req, res)

  // 路径穿越：normalize 之后必须还在 CLIENT_DIR 之下
  const rel = normalize(decodeURIComponent(url)).replace(/^(\\.\\.[/\\\\])+/, '')
  let file = join(CLIENT_DIR, rel)
  if (!file.startsWith(CLIENT_DIR)) file = join(CLIENT_DIR, 'index.html')

  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
  } catch {
    // 找不到就当 SPA 路由，回 index.html（前端自己 404）
    file = join(CLIENT_DIR, 'index.html')
  }

  try {
    const info = await stat(file)
    res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': info.size })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('No dist/index.html — the bundle is incomplete. Export again.')
  }
})

server.listen(PORT, HOST, () => {
  console.log('[serve] http://' + HOST + ':' + PORT + (HAS_API ? ' (/api proxied to 127.0.0.1:' + API_PORT + ')' : ''))
})

const shutdown = () => {
  server.close()
  if (api !== null) api.kill('SIGTERM')
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
`
}

export function renderStart(input: { hasApi: boolean }): string {
  return `#!/usr/bin/env sh
# Generated by Tenon at export time.
#
# This app knows exactly one database variable, DATABASE_URL (it does not care
# whether it runs on a desktop or a server).
# The database must exist first: migrations run on startup, but the app has to be
# able to connect before the migrations table exists.
set -eu

if [ -z "\${DATABASE_URL:-}" ]; then
  echo "[tenon] DATABASE_URL is not set." >&2
  echo "        e.g. export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/myapp" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[tenon] node not found (Node 20 or newer is required)." >&2
  exit 1
fi

exec node serve.mjs
${input.hasApi ? '' : '# This app has no backend: serve.mjs only serves static files, so DATABASE_URL is unused (harmless to keep)\n'}`
}

export function renderEnvExample(input: { hasApi: boolean }): string {
  return `# Copy to .env and put your own values in (start.sh does not read .env —
# export the variables or inject them through your process manager).
#
# The app knows only this one database variable — it does not detect where it runs
# (deliberate: the moment the code branches on "desktop or container", export breaks).
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/myapp

# A capacity knob, not an environment check: on real PostgreSQL this is the pool limit.
# DATABASE_POOL_MAX=10

# Public port (default 3000).${
    input.hasApi
      ? ' The backend automatically takes PORT+1 and serve.mjs proxies to it — nothing to configure.'
      : ' This app has no backend.'
  }
# PORT=3000
# HOST=0.0.0.0
`
}

export function renderReadme(input: {
  appName: string
  appId: string
  hasApi: boolean
  hasLock: boolean
}): string {
  return `# ${input.appName}

Exported by Tenon as a static bundle (app ID: \`${input.appId}\`).

## Running it

\`\`\`bash
# 1. Prepare a PostgreSQL and give it the connection string
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/myapp

# 2. Start the server (migrations run automatically)
./start.sh
\`\`\`

Open http://localhost:3000 .${
    input.hasApi
      ? ' The frontend and `/api` share one port, so a reverse proxy only forwards one.'
      : ' This is a frontend-only app: `serve.mjs` only serves static files.'
  }

Dependencies are already installed under \`node_modules/\` (production only). To reinstall:

\`\`\`bash
${input.hasLock ? 'pnpm install --prod --frozen-lockfile' : 'pnpm install --prod (this bundle has no lockfile, so versions may drift)'}
\`\`\`

## What this bundle does **not** contain

- **No database.** PGlite (PostgreSQL compiled to WASM) is only used by the local
  Tenon preview; the production bundle knows only \`DATABASE_URL\`. You need to
  provide PostgreSQL 13+ yourself.
- **No components.** The AI assistant, CSV export and approval flow are injected
  into the preview page by the Tenon runtime — they are not app code, so they are
  not in the bundle either. Use them inside Tenon.
- **No reverse proxy and no HTTPS.** Put nginx / Caddy in front (a single port):

\`\`\`nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
\`\`\`

## Data

Migrations run on startup (\`migrationsRun: true\`) and the schema is determined only by
\`dist-server/api/migrations/\` — do not hand-edit the database. A backup is a backup of
that PostgreSQL.
`
}

/**
 * Dockerfile —— **从静态包派生**，不做多阶段构建。
 *
 * 两个容易搞反的点：
 * 1. **构建不在镜像里做**。静态包已经在 Tenon 那侧 `pnpm run build` 过了；在镜像里再跑
 *    一遍就是两套构建环境，而那正是「导出」要消灭的不确定性。
 * 2. **但依赖必须在镜像里装**。产物里的 `node_modules`（如果有）来自 macOS，镜像是
 *    linux —— 只要有一个原生模块，容器起来就崩，而报错看起来像应用代码的问题。
 */
export function renderDockerfile(input: { hasApi: boolean; hasLock: boolean }): string {
  const frozen = input.hasLock ? ' --frozen-lockfile' : ''
  const apiLayer = input.hasApi ? 'COPY dist-server ./dist-server\n' : ''
  const healthPath = input.hasApi ? '/api/health' : '/'
  return `# Generated by Tenon at export time (not app source).
#
# No multi-stage build: the static bundle was already built on the Tenon side.
# Dependencies must be installed here: the bundle comes from macOS and the image is
# linux — a single native module makes the copied node_modules crash on startup,
# and that error looks like the app code is broken.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000

# The three build-args are **optional network adapters**; unset means upstream defaults:
#   NPM_REGISTRY   point this at a mirror when installs are slow or blocked
#                  (corepack and pnpm each read one variable)
#   HTTP(S)_PROXY  corporate networks that require a proxy
ARG NPM_REGISTRY
ARG HTTP_PROXY
ARG HTTPS_PROXY

COPY package.json ${input.hasLock ? 'pnpm-lock.yaml ' : ''}./
# Pin pnpm 9: corepack enable installs the latest pnpm (12), while the lockfile was
# produced by pnpm 9 — pnpm 12's supply-chain policy rejects that lock ("relax the
# policy that flagged them"), which looks like a dependency problem but is a version
# mismatch.
RUN if [ -n "$NPM_REGISTRY" ]; then export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"; fi \\
 && corepack enable \\
 && corepack prepare pnpm@9 --activate \\
 && pnpm install --prod${frozen}\${NPM_REGISTRY:+ --registry=$NPM_REGISTRY}

COPY dist ./dist
${apiLayer}COPY serve.mjs ./

EXPOSE 3000
# start-period gives the first boot room to run migrations: until the tables exist,
# ${healthPath} cannot answer
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \\
  CMD wget -qO- http://127.0.0.1:3000${healthPath} || exit 1
CMD ["node", "serve.mjs"]
`
}

/**
 * docker-compose.yml —— 有后端就自带一个 PostgreSQL。
 *
 * `DB_PASSWORD` 用 `${DB_PASSWORD:?...}`：**必须显式给**。给一个默认值（比如 changeme）
 * 等于把一个弱密码的数据库摆在公网上，而这恰好是最容易被跳过的一步。
 */
export function renderCompose(input: { appName: string; hasApi: boolean; port: number }): string {
  /*
   * 抬头按 hasApi 分支：纯前端应用的用户照着"先给 DB_PASSWORD"去设一个变量，
   * 结果是给一个不存在的数据库配密码 —— 那比不写更糟。
   */
  const header = input.hasApi
    ? `# Generated by Tenon at export time. To start (the database password is required):
#   DB_PASSWORD=<your password> docker compose up -d
# Check whether it is alive:
#   curl -s localhost:${input.port}/api/health
`
    : `# Generated by Tenon at export time. To start:
#   docker compose up -d
# Check whether it is alive:
#   curl -s localhost:${input.port}/
`
  if (!input.hasApi) {
    return `${header}services:
  app:
    build:
      context: .
      # Pass the host's HTTP(S)_PROXY into the build (empty is fine; inside a container 127.0.0.1 means the container itself)
      args:
        # Do not read HTTP_PROXY directly: that address is the **host's** view, and 127.0.0.1
        # inside a container points at the container itself. Pass BUILD_HTTP_PROXY instead
        # (an address the container can actually reach).
        NPM_REGISTRY: \${NPM_REGISTRY:-}
        HTTP_PROXY: \${BUILD_HTTP_PROXY:-}
        HTTPS_PROXY: \${BUILD_HTTPS_PROXY:-}
    ports: ['${input.port}:3000']
    restart: unless-stopped
`
  }
  return `${header}services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: \${DB_PASSWORD:?set one first, e.g. export DB_PASSWORD=...}
    volumes:
      # The official 18+ image moved PGDATA to /var/lib/postgresql/18/docker and accepts
      # **only** /var/lib/postgresql as the mount point. Mounting .../data makes the entry
      # script decide "data is on the wrong mount" and refuse to start (the container
      # ends up unhealthy, and the log says it in a roundabout way).
      - db:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U app']
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  app:
    build:
      context: .
      args:
        # Do not read HTTP_PROXY directly: that address is the **host's** view, and 127.0.0.1
        # inside a container points at the container itself. Pass BUILD_HTTP_PROXY instead
        # (an address the container can actually reach).
        NPM_REGISTRY: \${NPM_REGISTRY:-}
        HTTP_PROXY: \${BUILD_HTTP_PROXY:-}
        HTTPS_PROXY: \${BUILD_HTTPS_PROXY:-}
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD}@db:5432/app
      # On real PostgreSQL this is just the pool limit (not an environment check — do not branch on it)
      DATABASE_POOL_MAX: 10
    ports: ['${input.port}:3000']
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

volumes:
  db:
`
}

/** 构建上下文里不该出现的东西。`node_modules` 排第一位：那是架构不匹配的源头 */
export function renderDockerignore(): string {
  return `# Dependencies are installed inside the image (host is macOS, image is linux —
# copying node_modules over crashes on boot)
node_modules
# Local machine state does not go into the image
.env
*.log
# Not needed for the build, but kept in the directory for compose to read
Dockerfile
docker-compose.yml
.dockerignore
README.md
`
}
