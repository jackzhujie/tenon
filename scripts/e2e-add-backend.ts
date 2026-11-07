/**
 * 真机端到端：**给一个纯前端应用加后端，然后它真的能起来**。
 *
 * 这条链路专门验四件事，每件都只有真跑才验得出来：
 *
 * 1. `app.addBackend` 之后网关认这个后端（`/api/*` 被分流到 Nest，而不是 502）
 * 2. **Nest 的 CJS 产物在 ESM 应用里能跑** —— `react-vite` 模板有 `"type": "module"`，
 *    不钉产物目录的模块格式就是 `require is not defined`（见 STATUS §4.55）
 * 3. 预览是 `tsc --watch` 起后端的，**不经过 `build:api`** —— 所以"钉 commonjs"这件事
 *    在预览这条路上只能由网关做，脚本里那个 mark-cjs 帮不上忙
 * 4. 前端一行没动：加完后端页面还照常开
 *
 * 不进 CI（要联网装 NestJS，几十秒）。用法：
 *   pnpm e2e:backend
 *   pnpm e2e:backend --keep
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-backend-token'
const keep = process.argv.includes('--keep')

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-backend-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: {
    // 首次要装 NestJS 全家桶
    readyTimeoutMs: 10 * 60 * 1000,
    apiReadyTimeoutMs: 5 * 60 * 1000,
    log: (line) => console.log(`  [preview] ${line}`),
  },
})

async function rpc<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

interface AddBackendResult {
  applied: boolean
  files: string[]
  addedScripts: string[]
  notes: string[]
  deps: { installed: boolean; durationMs: number } | null
}

try {
  console.log('1) 建一个纯前端应用（react-vite，package.json 里有 type: module）')
  const created = await rpc<{ app: { id: string } }>('app.create', { name: '报销 E2E' })
  const appId = created.app.id
  const repo = join(home, 'apps', appId, 'repo')
  const pkgBefore = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
    type?: string
  }
  check('是 ESM 应用（这条用例的前提）', pkgBefore.type === 'module', String(pkgBefore.type))

  console.log('\n2) 加后端（要装 NestJS，可能几十秒）')
  const started = Date.now()
  const added = await rpc<AddBackendResult>('app.addBackend', { id: appId, installDeps: true })
  console.log(`  耗时 ${Date.now() - started}ms，${added.files.length} 个新文件`)
  check('applied', added.applied)
  check('写了 api/main.ts', added.files.includes('api/main.ts'))
  check('依赖装上了', added.deps?.installed === true, JSON.stringify(added.deps))
  for (const note of added.notes) console.log(`  注意：${note}`)

  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
    type?: string
    tenon?: { api?: string }
    scripts?: Record<string, string>
  }
  check('tenon.api 指向 api/main.ts', pkg.tenon?.api === 'api/main.ts')
  check('仍然保留 type: module（没有为了省事把应用改成 CJS）', pkg.type === 'module')

  console.log('\n3) 起预览（tsc --watch 起后端，等 /api/health）')
  const previewStart = Date.now()
  await rpc('preview.start', { appId })
  const ready = await server.preview.waitReady(appId, 10 * 60 * 1000)
  if (ready.state !== 'ready') throw new Error(`预览没就绪：${ready.error ?? '未知原因'}`)
  console.log(`  就绪耗时 ${Date.now() - previewStart}ms`)
  check('有后端端口（起了 Nest）', ready.apiPort !== null, `apiPort=${String(ready.apiPort)}`)
  check(
    'readiness 四格全 ready（server=ready 说明 /api/health 已通过）',
    JSON.stringify(ready.readiness) ===
      JSON.stringify({ deps: 'ready', db: 'ready', server: 'ready', preview: 'ready' }),
    JSON.stringify(ready.readiness),
  )

  /*
   * ★ 这条是 §4.55 那个坑的判据：产物目录里的 package.json 一旦缺了，
   * Nest 进程会以 `require is not defined` 立刻退出，`/api/health` 永远不通。
   */
  const marker = join(repo, 'dist-server', 'package.json')
  check(
    '网关给 tsc 产物钉了 commonjs（预览不经过 build:api，这一步只能由网关做）',
    existsSync(marker) && (await readFile(marker, 'utf8')).includes('commonjs'),
    existsSync(marker) ? await readFile(marker, 'utf8') : '文件不存在',
  )

  const url = ready.url as string
  console.log('\n4) 经网关打 /api/health')
  const health = await fetch(`${url}/api/health`)
  check('HTTP 200', health.status === 200, `status=${health.status}`)
  const body = (await health.json()) as {
    ok?: boolean
    db?: { poolMax?: number | null; migrations?: number; version?: string }
  }
  check('ok: true', body.ok === true, JSON.stringify(body).slice(0, 200))
  check('poolMax 是 1（PGlite 档必须为 1，否则并发事务互相回滚）', body.db?.poolMax === 1, String(body.db?.poolMax))
  check('连的是 PGlite 版的 PG（版本号里有 PostgreSQL）', /PostgreSQL/i.test(body.db?.version ?? ''), String(body.db?.version))
  check('迁移计数可读（刚加后端时是 0，不是报错）', typeof body.db?.migrations === 'number', String(body.db?.migrations))

  console.log('\n5) 前端一行没动：页面照常开')
  const html = await (await fetch(url)).text()
  check('HTML 里有挂载点', html.includes('<div id="root">'))
  check('HTML 里引了入口模块', html.includes('/src/main.tsx'))

  console.log('\n6) 业务接口还不存在时是 404（不是 500，也不是挂着不回）')
  const missing = await fetch(`${url}/api/items`)
  check('未定义的 /api 路径回 404', missing.status === 404, `status=${missing.status}`)
} catch (error) {
  failures += 1
  console.log(`\n✗ 异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  // `close()` 自己会停掉所有预览（含后端那两条子进程）
  await server.close().catch(() => undefined)
  if (keep) console.log(`\n工作区保留在：${home}`)
  else await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => undefined)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
