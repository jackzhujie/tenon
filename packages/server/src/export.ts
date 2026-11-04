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
import { resolvePnpm } from '@tenon/core'
import { ensureDeps, nodeRunEnv } from '@tenon/gateway'
import { TenonError } from '@tenon/protocol'

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
  /** 每读一行输出回调一次（进度展示；也给 e2e 当观测点） */
  readonly onLog?: (line: string) => void
  /** 注入 pnpm（默认 `resolvePnpm(process.env)`）。测试里换成一个假的 */
  readonly env?: NodeJS.ProcessEnv
}

export interface StaticExportResult {
  readonly dir: string
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
    throw new TenonError('EXPORT_FAILED', '这个工作区没有 package.json，导不出东西', { repoDir })
  }
  try {
    return JSON.parse(raw) as PackageJson
  } catch (error) {
    throw new TenonError('EXPORT_FAILED', 'package.json 不是合法 JSON，先修好再导出', {
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
  onLog?: (line: string) => void
  label: string
}): Promise<{ code: number | null; output: string }> {
  const lines: string[] = []
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      lines.push(`[tenon] ${options.label} 超时（${Math.round(options.timeoutMs / 1000)}s），已终止`)
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
      lines.push(`[tenon] 起不来（${options.command}）：${error.message}`)
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
  const args = ['run', options.script]
  return runOnce({
    command: pnpm.isScript ? process.execPath : pnpm.command,
    args: pnpm.isScript ? [pnpm.command, ...args] : args,
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
export function exportStamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}-${time}`
}

export async function exportStatic(options: StaticExportOptions): Promise<StaticExportResult> {
  const env = options.env ?? process.env
  const pkg = await readPackageJson(options.repoDir)
  const scripts = pkg.scripts ?? {}
  const apiEntry = typeof pkg.tenon?.api === 'string' ? pkg.tenon.api : null
  const hasApi = apiEntry !== null

  if (typeof scripts['build'] !== 'string') {
    throw new TenonError('EXPORT_FAILED', '这个应用的 package.json 没有 build 脚本，不知道怎么构建', {
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
    throw new TenonError('EXPORT_FAILED', '装依赖失败（构建需要 vite 与 tsc）', {
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
    throw new TenonError('EXPORT_FAILED', `构建失败（pnpm run build 退出码 ${front.code ?? 'null'}）`, {
      phase: 'build',
      output: front.output,
    })
  }

  if (hasApi) {
    if (typeof scripts['build:api'] !== 'string') {
      // 有后端却没有构建脚本 —— 说清是哪一半缺，别让它变成一个"导出成功但跑不起来"的包
      throw new TenonError(
        'EXPORT_FAILED',
        '这个应用声明了后端（package.json 的 tenon.api），但没有 build:api 脚本',
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
      throw new TenonError('EXPORT_FAILED', `后端编译失败（pnpm run build:api 退出码 ${back.code ?? 'null'}）`, {
        phase: 'build:api',
        output: back.output,
      })
    }
  }

  const distDir = join(options.repoDir, 'dist')
  if (!existsSync(distDir)) {
    // 构建说成功但产物不在 —— 后端脚本改写、vite 配了别的 outDir，都是这种表现
    throw new TenonError('EXPORT_FAILED', '构建完成了，但没有 dist/ 目录（前端产物去哪了？）', {
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
  await writeFile(join(options.outDir, 'serve.mjs'), renderServe({ hasApi }), 'utf8')
  await writeFile(join(options.outDir, 'start.sh'), renderStart({ hasApi }), { encoding: 'utf8', mode: 0o755 })
  await writeFile(join(options.outDir, '.env.example'), renderEnvExample({ hasApi }), 'utf8')
  await writeFile(
    join(options.outDir, 'README.md'),
    renderReadme({
      appName: options.appName,
      appId: options.appId,
      hasApi,
      hasLock: existsSync(join(options.repoDir, 'pnpm-lock.yaml')),
    }),
    'utf8',
  )

  /* 4) prod 依赖：让产物真的能"拷到服务器就跑" */
  if (options.installDeps !== false) {
    const pnpm = resolvePnpm(env)
    const args = ['install', '--prod', '--prefer-offline', '--reporter=append-only']
    if (existsSync(join(options.outDir, 'pnpm-lock.yaml'))) args.push('--frozen-lockfile')
    const installed = await runOnce({
      command: pnpm.isScript ? process.execPath : pnpm.command,
      args: pnpm.isScript ? [pnpm.command, ...args] : args,
      cwd: options.outDir,
      env: pnpm.isScript ? nodeRunEnv(env) : env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      label: 'pnpm install --prod',
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    })
    if (installed.code !== 0) {
      throw new TenonError('EXPORT_FAILED', `装生产依赖失败（退出码 ${installed.code ?? 'null'}）`, {
        phase: 'install',
        output: installed.output,
      })
    }
  }

  const measured = await measure(options.outDir, ['node_modules'])
  return {
    dir: options.outDir,
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
    console.error('[serve] 后端进程退出（' + (signal ?? code) + '），整个服务一起停')
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
    res.end('后端还没起来（或已经退了）。看本进程的日志。')
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
    res.end('没有 dist/index.html —— 产物不完整，重新导出一次。')
  }
})

server.listen(PORT, HOST, () => {
  console.log('[serve] http://' + HOST + ':' + PORT + (HAS_API ? '（/api 转给 127.0.0.1:' + API_PORT + '）' : ''))
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
# 由 Tenon 导出时生成。
#
# 这个应用只认一个 DATABASE_URL（不判断自己跑在桌面还是服务器）。
# 数据库要先存在：迁移会在启动时自动跑，但库里没有 migrations 表之前得能连上。
set -eu

if [ -z "\${DATABASE_URL:-}" ]; then
  echo "[tenon] 缺 DATABASE_URL。" >&2
  echo "        例：export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/myapp" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[tenon] 找不到 node（需要 Node 20 以上）。" >&2
  exit 1
fi

exec node serve.mjs
${input.hasApi ? '' : '# 这个应用没有后端：serve.mjs 只发静态文件，DATABASE_URL 其实用不上（留着无害）\n'}`
}

export function renderEnvExample(input: { hasApi: boolean }): string {
  return `# 复制成 .env 再改成自己的值（start.sh 不读 .env，需要你 export 或用进程管理器注入）
#
# 应用只认这一个数据库变量 —— 它不判断自己跑在哪儿（这是刻意的：
# 一旦代码里出现"桌面还是容器"的分支，导出就必然破）。
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/myapp

# 并发容量参数，不是环境判断：真 PG 上就是连接池上限。
# DATABASE_POOL_MAX=10

# 对外端口（默认 3000）。${
    input.hasApi
      ? '后端会自动用 PORT+1，由 serve.mjs 反代，不用另外配。'
      : '这个应用没有后端。'
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

由 Tenon 导出的静态包（应用 ID：\`${input.appId}\`）。

## 跑起来

\`\`\`bash
# 1. 准备一个 PostgreSQL，把连接串给它
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/myapp

# 2. 起服务（迁移会自动跑）
./start.sh
\`\`\`

打开 http://localhost:3000 。${
    input.hasApi
      ? '前端与 `/api` 在同一个端口上，反代只需要转一个口。'
      : '这是纯前端应用：`serve.mjs` 只发静态文件。'
  }

依赖已经装在 \`node_modules/\` 里（只含生产依赖）。要重新装：

\`\`\`bash
${input.hasLock ? 'pnpm install --prod --frozen-lockfile' : 'pnpm install --prod（这个产物没有 lock 文件，版本可能浮动）'}
\`\`\`

## 这个产物里**没有**什么

- **没有数据库**。PGlite（WASM 版 PostgreSQL）只是 Tenon 本地预览用的，生产产物只认
  \`DATABASE_URL\`。你需要自己准备 PostgreSQL 13+。
- **没有组件**。AI 小助手、导出 CSV、审批流这些是 Tenon 运行时注入到预览页里的，
  不属于应用代码 —— 导出的包里自然也没有。要用它们就在 Tenon 里用。
- **没有反向代理和 HTTPS**。前面挂一层 nginx / Caddy 即可（只转一个端口）：

\`\`\`nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
\`\`\`

## 数据

迁移在启动时自动跑（\`migrationsRun: true\`），表结构只由 \`dist-server/api/migrations/\`
决定 —— 不要手改库。备份就是备份那个 PostgreSQL。
`
}
