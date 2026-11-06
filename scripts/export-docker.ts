/**
 * Docker 导出的端到端：**导出 → `docker compose up -d` → 打接口 → 拆掉**。
 *
 * 这一步以前是"卡在本机没容器运行时"（M2 第 8 步，从七月底挂到现在）。现在有 Docker 了，
 * 所以它必须验的是真东西：
 *
 *   1. 产物里那几个容器文件生成得对（Dockerfile / compose / .dockerignore）
 *   2. **构建上下文里没有 `node_modules`** —— 宿主是 macOS、镜像是 linux，
 *      拷过去就是"起来即崩"，而那种错看起来像应用代码有问题
 *   3. 镜像真能 build（依赖在镜像里装，`pnpm install --prod`）
 *   4. db 服务先 healthy，app 才启动（`depends_on: condition: service_healthy`）
 *   5. `/api/health` 200 —— 迁移在容器里自动跑完了
 *   6. 首页返回 HTML（`serve.mjs` 在同一端口分流静态与 /api）
 *
 * 用法：`pnpm e2e:docker`（需要本机有 docker；没有就 skip，不算失败）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type RunningServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-docker-token'
/**
 * docker 的绝对路径。
 *
 * 不往 PATH 里塞 /usr/local/bin：那里有个 brew 装的 Node 20，会把它放到项目要求的
 * Node 22 前面（症状是 `No such built-in module: node:sqlite`，看着像代码坏了）。
 */
const DOCKER = existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker'
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

function docker(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(DOCKER, args, { cwd, env, encoding: 'utf8', timeout: 10 * 60 * 1000 })
  return {
    code: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
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
    await new Promise((r) => setTimeout(r, 500))
  }
}

/* ---------- 0. 没有 docker 就跳过（这不是失败） ---------- */
const probe = spawnSync(DOCKER, ['info'], { encoding: 'utf8', timeout: 30_000 })
if (probe.status !== 0) {
  console.log('跳过：本机没有可用的 docker（e2e:docker 只验真机，不做假）')
  console.log(`${(probe.stderr ?? '').trim().split('\n')[0] ?? ''}`)
  process.exit(0)
}

const home = await mkdtemp(join(tmpdir(), 'tenon-docker-e2e-'))
console.log(`TENON_HOME = ${home}\n`)

/*
 * 两种模式。
 *
 * `postgres:18-alpine` 有 250MB，在某些网络下拉一次要十几分钟（甚至拉不下来）。
 * 那种情况下**不能把整条链路判失败** —— 能验的那部分（构建上下文、镜像 build、
 * 容器起、静态服务）和数据库无关。诚实的做法是跑能跑的，并说清缺什么。
 */
const hasPostgres = spawnSync(DOCKER, ['image', 'inspect', 'postgres:18-alpine'], { encoding: 'utf8' }).status === 0
const templateId = hasPostgres ? 'nest-api' : 'react-vite'
console.log(
  hasPostgres
    ? '模式：全栈（含 PostgreSQL）'
    : '模式：纯前端（postgres 镜像不在本地 —— 数据库那条这次验不了，其余照验）',
)
console.log('')

let server: RunningServer | undefined
// 名字带随机后缀：并行跑两次（或上次没拆干净）时不会互相踩
const project = `tenon-e2e-${Math.random().toString(36).slice(2, 8)}`

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
  console.log(`1) 建应用（${templateId}）`)
  server = await startServer({
    port: 0,
    token: TOKEN,
    env: { TENON_HOME: home, TENON_FAUX: '1' },
    preview: { installDeps: false },
  })
  const created = await rpc<{ app: { id: string } }>('app.create', {
    name: 'Docker 验收',
    templateId,
  })
  const port = await freePort()
  console.log(`\n2) 导出 Docker 构建上下文（对外端口 ${port}）`)
  const started = Date.now()
  const artifact = await rpc<{
    dir: string
    target: string
    files: number
    bytes: number
    hasApi: boolean
  }>('export.docker', { appId: created.app.id, port })
  console.log(`   ${artifact.dir}（${artifact.files} 个文件，${Math.round((Date.now() - started) / 1000)}s）`)

  check('产物标记为 docker', artifact.target === 'docker')
  check(`后端识别与模板一致（hasApi=${String(artifact.hasApi)}）`, artifact.hasApi === hasPostgres)

  console.log('\n3) 容器文件的形状')
  for (const name of ['Dockerfile', 'docker-compose.yml', '.dockerignore', 'serve.mjs', 'dist']) {
    check(`有 ${name}`, existsSync(join(artifact.dir, name)))
  }
  // 关键：宿主依赖不能进构建上下文
  check('没有 node_modules（架构不匹配的源头）', !existsSync(join(artifact.dir, 'node_modules')))

  const dockerfile = await readFile(join(artifact.dir, 'Dockerfile'), 'utf8')
  check('Dockerfile 在镜像里装依赖', dockerfile.includes('pnpm install --prod'))
  if (hasPostgres) {
    check('Dockerfile 健康检查打 /api/health', dockerfile.includes('3000/api/health'))
    check('产物里有 dist-server', existsSync(join(artifact.dir, 'dist-server')))
  }
  const compose = await readFile(join(artifact.dir, 'docker-compose.yml'), 'utf8')
  check('compose 只映射一个端口', compose.includes(`'${port}:3000'`))
  if (hasPostgres) {
    check('compose 自带 postgres', compose.includes('postgres:18-alpine'))
    check('db 健康后才起 app', compose.includes('condition: service_healthy'))
    check('密码没有默认值（必须显式给）', compose.includes('DB_PASSWORD:?'))
  } else {
    // 纯前端不该凭空长出一个 db 服务
    check('纯前端不生成 db 服务', !compose.includes('postgres'))
  }

  console.log('\n4) docker compose up -d（要 build 镜像，几分钟）')
  const up = docker(
    ['compose', '-p', project, 'up', '-d', '--build'],
    artifact.dir,
    {
      ...process.env,
      DB_PASSWORD: 'e2e-only-password',
      /*
       * 容器里装依赖走国内镜像源（可用 E2E_NPM_REGISTRY 覆盖）。
       * 我们验的是「导出产物能不能 build 起来」，不是「registry.npmjs.org 通不通」——
       * 后者在这个网络环境下直连要 2 分钟下 4MB，pnpm 一定会超时。
       */
      NPM_REGISTRY: process.env['E2E_NPM_REGISTRY'] ?? 'https://registry.npmmirror.com',
    },
  )
  if (up.code !== 0) {
    console.log(up.out.slice(-1500))
  }
  check('compose up 成功', up.code === 0, up.out.slice(-600))
  if (up.code === 0) {
    const base = `http://127.0.0.1:${port}`

    console.log('\n5) 容器真的在服务')
    try {
      const page = await waitHttp(`${base}/`, 240_000)
      const html = await page.text()
      check('首页返回 HTML（静态文件在容器里）', html.includes('<div id="root"'))
      if (hasPostgres) {
        const health = await waitHttp(`${base}/api/health`, 120_000)
        check('GET /api/health 200（迁移在容器里跑完了）', health.status === 200)
        const items = await fetch(`${base}/api/items`)
        check('/api 转给了后端容器', items.ok)
      }
    } catch (error) {
      check('容器起来了并能响应', false, error instanceof Error ? error.message : String(error))
      console.log(docker(['compose', '-p', project, 'logs', '--tail', '40'], artifact.dir).out.slice(-1800))
    }

    console.log('\n6) 容器状态')
    const ps = docker(['compose', '-p', project, 'ps', '--format', 'json'], artifact.dir)
    check('容器在跑', ps.out.includes('running'), ps.out.slice(0, 400))
  }

  console.log('\n7) 拆掉（含卷）')
  // --rmi local：把这次 build 出来的镜像一起删掉（不然每跑一次留 279MB）
  const down = docker(['compose', '-p', project, 'down', '-v', '--rmi', 'local'], artifact.dir)
  check('compose down 干净退出', down.code === 0, down.out.slice(-400))
} catch (error) {
  failures += 1
  console.log(`\n✗ 中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  // 无论成败都把容器拆掉，别把项目和卷留在机器上
  await server?.close().catch(() => {})
  if (failures === 0) {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  } else {
    console.log(`\n产物与 home 保留在 ${home}（排查用）`)
  }
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log(
  hasPostgres
    ? '\n全部通过：导出的 Docker 上下文能 build 起来、带库、迁移自动跑。'
    : '\n通过（纯前端模式）：构建上下文 → 镜像 build → 容器起来 → 静态文件服务。\n' +
        '数据库那条没验：先 `docker pull postgres:18-alpine`（250MB，网络慢就挂着拉），\n' +
        '拉好之后重跑这条命令，会自动切到全栈模式。',
)
