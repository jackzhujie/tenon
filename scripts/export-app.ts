/**
 * 静态包导出的端到端：**导出来东西真的能跑起来**（DESIGN §13.1 的第二种产物）。
 *
 * 这一步以前只有设计（`export.docker` / 静态包两档都写在 §13 里，一行代码都没有）。
 * 现在验的是完整链路：
 *
 *   建应用 → 导出（跑模板自己的 build）→ 用 PGlite 起一个**真的 TCP PostgreSQL**
 *   → 在产物目录里跑 `./start.sh` → 打 `/api/health` 与首页
 *
 * 那个 PGlite 是刻意的：它充当"用户自己的 PostgreSQL"，证明产物**只认 `DATABASE_URL`**
 * 这一件事 —— 它不知道对面是 WASM 版还是真 PG（铁律 2 的验证方式）。
 *
 * 用法：`pnpm e2e:export`（首次要联网装两次依赖：应用的 dev 依赖、产物的 prod 依赖）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgliteProvider } from '../packages/db-provisioner/src/index.js'
import { appPaths, resolveHome } from '../packages/core/src/index.js'
import { startServer, type RunningServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-export-token'
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 等到 URL 返回 200（产物里的 serve.mjs 起得比后端快，所以两条都要等） */
async function waitHttp(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() > deadline) throw new Error(`等不到 ${url}：${last}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

const home = await mkdtemp(join(tmpdir(), 'tenon-export-e2e-'))
console.log(`TENON_HOME = ${home}\n`)

let server: RunningServer | undefined
let db: PgliteProvider | undefined
let exported: { pid: number | undefined; stop(): void } | undefined

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code?: string; message?: string }
}

async function rpc<T>(method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server!.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.code ?? '?'} ${body.error?.message ?? ''}`)
  return body.data as T
}

try {
  /* ---------- 1. 建一个全栈应用（nest-api：有后端，最能证明迁移与 /api 分流） ---------- */
  console.log('1) 建应用（nest-api 模板：React + NestJS）')
  server = await startServer({
    port: 0,
    token: TOKEN,
    env: { TENON_HOME: home, TENON_FAUX: '1' },
    // 导出自己会装依赖，这里不要 preview 再装一遍
    preview: { installDeps: false },
  })
  const created = await rpc<{ app: { id: string; name: string } }>('app.create', {
    name: '导出验收',
    templateId: 'nest-api',
  })
  const appId = created.app.id
  const paths = appPaths(resolveHome({ TENON_HOME: home }), appId)
  check('应用目录建好了', existsSync(paths.repoDir))

  /* ---------- 2. 导出 ---------- */
  console.log('\n2) 导出静态包（要跑 pnpm install + build + prod install，两三分钟）')
  const started = Date.now()
  const result = await rpc<{
    dir: string
    files: number
    bytes: number
    hasApi: boolean
    version: string | null
    headSha: string | null
  }>('export.static', { appId })
  const elapsed = Math.round((Date.now() - started) / 1000)
  console.log(`   产物 ${result.dir}（${Math.round(result.bytes / 1024 / 1024)}MB，${result.files} 个文件，${elapsed}s）`)

  check('识别出这个应用有后端', result.hasApi)
  check('产物在 <app>/exports/<时间戳> 下', result.dir.startsWith(join(paths.dir, 'exports')))
  check('带了提交号（知道产物对应哪一版代码）', result.headSha !== null)

  console.log('\n3) 产物的形状')
  for (const name of ['dist', 'dist-server', 'serve.mjs', 'start.sh', '.env.example', 'README.md', 'package.json']) {
    check(`有 ${name}`, await exists(join(result.dir, name)))
  }
  check('有生产依赖（node_modules 非空）', await exists(join(result.dir, 'node_modules', '@nestjs', 'core')))
  check('没有把 db 目录打进产物（生产不碰 pglite）', !(await exists(join(result.dir, 'pgdata'))))

  const serveSource = await readFile(join(result.dir, 'serve.mjs'), 'utf8')
  check('serve.mjs 里没有 pglite 之类的运行时依赖', !serveSource.includes('pglite'))
  const startMode = (await stat(join(result.dir, 'start.sh'))).mode & 0o777
  check('start.sh 可执行（chmod 755）', (startMode & 0o111) !== 0, startMode.toString(8))

  /* ---------- 3. 起一个"用户自己的 PostgreSQL"（PGlite 顶替） ---------- */
  console.log('\n4) 起一个真 TCP 的 PostgreSQL（PGlite 顶替用户自备的库）')
  db = new PgliteProvider({ dataDir: join(home, 'pgdata-e2e'), log: () => {} })
  await db.start()
  const databaseUrl = db.connectionString()
  check('拿到连接串（应用只认它，不知道对面是 WASM）', databaseUrl.startsWith('postgres://'), databaseUrl)

  /* ---------- 4. 在产物里跑 ./start.sh ---------- */
  console.log('\n5) 在产物目录里跑 ./start.sh')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    // PGlite 只有一个 backend 会话（真 PG 上是普通连接池上限）
    DATABASE_POOL_MAX: '1',
    PORT: String(port),
    HOST: '127.0.0.1',
  }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['NODE_OPTIONS']

  const child = spawn(join(result.dir, 'start.sh'), [], { cwd: result.dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  exported = {
    pid: child.pid,
    stop: () => child.kill('SIGTERM'),
  }

  const health = await waitHttp(`${base}/api/health`, 120_000)
  check('GET /api/health 返回 200（后端起来了，迁移也跑完了）', health.status === 200)

  const page = await waitHttp(`${base}/`, 30_000)
  const html = await page.text()
  check('首页返回 HTML（静态文件服务在同一个端口上）', html.includes('<div id="root"'))
  check('首页走的是产物里的 dist/index.html', html.includes('/assets/'))

  const apiItems = await (await fetch(`${base}/api/items`)).json()
  check('/api 真的转给了后端（不是被静态服务吃掉）', Array.isArray(apiItems) || typeof apiItems === 'object')

  const missing = await fetch(`${base}/no-such-page`)
  const missingBody = await missing.text()
  check('未知路径回 index.html（前端路由）', missing.ok && missingBody.includes('<div id="root"'))

  /* ---------- 5. 缺 DATABASE_URL 时要被拦住 ---------- */
  console.log('\n6) 不配数据库就别启动（错在启动前说，不要错在第一个请求上）')
  const bare = spawn(join(result.dir, 'start.sh'), [], {
    cwd: result.dir,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let bareOut = ''
  bare.stderr.on('data', (chunk: Buffer) => {
    bareOut += chunk.toString()
  })
  const bareCode = await new Promise<number | null>((resolve) => bare.on('exit', (code) => resolve(code)))
  check('退出码非零', bareCode !== 0, String(bareCode))
  check('报错里说的是 DATABASE_URL 与怎么设', bareOut.includes('DATABASE_URL'), bareOut.slice(0, 200))
} catch (error) {
  failures += 1
  console.log(`\n✗ 中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  exported?.stop()
  await db?.stop().catch(() => {})
  await server?.close().catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过：导出的静态包拷到别处也能跑，只认 DATABASE_URL。')
