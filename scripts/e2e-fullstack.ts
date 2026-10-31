/**
 * 真机端到端（M2）：建全栈应用 → 装依赖 → 起 PGlite → 起 Nest → 经网关 CRUD → 重启后数据还在。
 *
 * 这条链路**不进 CI**：要联网装 NestJS（首次一两分钟），还要等 PGlite 冷启动 + tsc 编译。
 * `pnpm test` 里对应的是用 stub 后端与假库验状态机（`packages/gateway/test/preview.test.ts`）。
 *
 * 它守的是单测**没法**守的四件事：
 * 1. 模板装得起来、跑得起来（tsc + 装饰器 + 迁移自动执行）
 * 2. `pool.max=1` 真的传到了 pg.Pool（`/api/health` 从驱动实例上读回来的）
 * 3. 网关的 `/api/*` 分流没串到 Vite
 * 4. 停预览再起，数据还在（PGlite 数据目录没被清）
 *
 * 用法：
 *   pnpm e2e:fullstack            # 跑完删临时目录
 *   pnpm e2e:fullstack --keep     # 留下目录，自己用浏览器看
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-fullstack-token'
const keep = process.argv.includes('--keep')

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface Item {
  id: number
  title: string
  done: boolean
  createdAt: string
}

interface LogEntry {
  id: string
  appId: string
  at: number
  source: 'web' | 'api' | 'vite' | 'db' | 'tenon'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  detail: string | null
  repeat: number
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

function ms(from: number): string {
  return `${Date.now() - from}ms`
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-full-'))
  console.log(`TENON_HOME=${home}`)

  const server = await startServer({
    env: { ...process.env, TENON_HOME: home, TENON_FAUX: '1' },
    token: TOKEN,
    preview: { installDeps: true, readyTimeoutMs: 90_000, apiReadyTimeoutMs: 240_000 },
  })

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(`${server.url}/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(params),
    })
    const envelope = (await response.json()) as Envelope<T>
    if (!envelope.ok || envelope.data === undefined) {
      throw new Error(`${method} 失败：${envelope.error?.code} ${envelope.error?.message}`)
    }
    return envelope.data
  }

  try {
    console.log('\n1) 建一个全栈应用（nest-api 模板）')
    const created = await rpc<{ app: { id: string; slug: string; templateId: string } }>('app.create', {
      name: '库存清单',
      templateId: 'nest-api',
    })
    const appId = created.app.id
    check('模板是 nest-api', created.app.templateId === 'nest-api', created.app.templateId)
    check('铺出了后端目录', true)

    console.log('\n2) 起预览（首次要装 NestJS 依赖 + PGlite 冷启动 + tsc 首次编译，耐心等）')
    const startedAt = Date.now()
    await rpc('preview.start', { appId })
    const ready = await server.preview.waitReady(appId, 10 * 60 * 1000)
    if (ready.state !== 'ready') {
      throw new Error(`预览没就绪：${ready.error ?? '未知原因'}`)
    }
    console.log(`  就绪耗时 ${ms(startedAt)}（含依赖安装 + 数据库 + 后端）`)
    console.log(`  网关 ${ready.url}（vite :${ready.upstreamPort}，api :${String(ready.apiPort)}）`)

    check(
      'readiness 四格全 ready',
      JSON.stringify(ready.readiness) ===
        JSON.stringify({ deps: 'ready', db: 'ready', server: 'ready', preview: 'ready' }),
      JSON.stringify(ready.readiness),
    )
    check('起了后端（apiPort 非空）', ready.apiPort !== null, `apiPort=${String(ready.apiPort)}`)
    check(
      'gatewayPort 与 url 端口一致（HMR 靠它）',
      new URL(ready.url as string).port === String(ready.gatewayPort),
      `url=${String(ready.url)} gatewayPort=${String(ready.gatewayPort)}`,
    )

    const url = ready.url as string
    console.log('\n3) 健康检查（经网关打后端）')
    const health = (await (await fetch(`${url}/api/health`)).json()) as {
      ok: boolean
      db: { database: string; version: string; poolMax: number | null; migrations: number }
    }
    check('ok=true', health.ok === true)
    check('后端连的就是应用库', health.db.database === 'postgres', health.db.database)
    check('方言是 PostgreSQL', health.db.version.includes('PostgreSQL'), health.db.version)
    /*
     * ★ 这条是整个 M2 第 1 步的验收核心之一。
     * `poolMax` 不是把环境变量原样回显，而是从 TypeORM 的 driver.master.options.max
     * 读回来的 —— 也就是**真的传到了 pg.Pool**。读回 10 就说明 DATABASE_POOL_MAX
     * 没被应用侧采纳，PGlite 上迟早会出现并发事务互相回滚（静默丢数据）。
     */
    check('pool.max 真的是 1（PGlite 单会话硬约束）', health.db.poolMax === 1, String(health.db.poolMax))
    check('迁移自动跑过了', health.db.migrations >= 1, String(health.db.migrations))

    console.log('\n4) CRUD（前端用的同一组相对路径）')
    const post = await fetch(`${url}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '螺丝刀' }),
    })
    const created_item = (await post.json()) as Item
    check('POST /api/items 创建成功', post.ok && created_item.title === '螺丝刀', `HTTP ${post.status}`)

    const list = (await (await fetch(`${url}/api/items`)).json()) as { items: Item[] }
    check('GET /api/items 读回一条', list.items.length === 1, JSON.stringify(list.items))

    const patch = await fetch(`${url}/api/items/${created_item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done: true }),
    })
    const patched = (await patch.json()) as Item
    check('PATCH 改 done', patch.ok && patched.done === true, JSON.stringify(patched))

    const bad = await fetch(`${url}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    check('空标题被 zod 拦下（400）', bad.status === 400, `HTTP ${bad.status}`)

    const missing = await fetch(`${url}/api/items/99999`)
    check('不存在的路径 404（不是回落到前端页面）', missing.status === 404, `HTTP ${missing.status}`)

    console.log('\n5) 前端与后端在同一个源上')
    const page = await (await fetch(url)).text()
    check('网关 / 仍然给 Vite（拿到 index.html）', page.includes('<div id="root">'), page.slice(0, 80))
    check('HMR 客户端指向网关端口', page.includes('@vite/client') || page.includes('/src/main.tsx'))
    const dbFiles = await readdir(join(home, 'apps', appId, 'pgdata')).catch(() => [] as string[])
    check('pgdata 落盘了（不是纯内存库）', dbFiles.length > 0, dbFiles.slice(0, 5).join(','))

    console.log('\n6) 运行日志：子进程输出与页面异常都进得去（错误面板的数据源）')
    /*
     * 子进程那一路只能靠真跑：stub 上游不会真的往 stderr 写东西。
     * 断言落在"确实收到了 Vite 与 Nest 的输出"—— 这两条一有，面板才不会空着。
     */
    const logsBefore = await rpc<{ entries: LogEntry[] }>('logs.list', { appId, limit: 200 })
    const sources = new Set(logsBefore.entries.map((entry) => entry.source))
    check(
      '收得到构建/前端的输出（vite 来源有日志）',
      sources.has('vite'),
      JSON.stringify([...sources]),
    )
    check(
      '收得到后端输出（api 来源有日志）',
      sources.has('api'),
      JSON.stringify(logsBefore.entries.filter((entry) => entry.source === 'api').slice(-2)),
    )
    check(
      'ANSI 转义已剥掉（否则界面里全是 [2m 之类）',
      logsBefore.entries.every((entry) => !entry.message.includes('\u001B')),
    )

    // 页面侧：SDK 用相对路径 POST，网关自己吃掉（不转发给 Vite / Nest）
    const reported = await fetch(`${url}/__tenon/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        level: 'error',
        message: 'e2e: 页面渲染失败（探针）',
        detail: 'at App.tsx:1:1',
      }),
    })
    check('上报端点回 204（不落上游，也不报错）', reported.status === 204, `HTTP ${reported.status}`)

    const logsAfter = await rpc<{ entries: LogEntry[] }>('logs.list', { appId, sources: ['web'] })
    const mine = logsAfter.entries.find((entry) => entry.message.includes('e2e: 页面渲染失败'))
    check('前端上报的异常进了日志，且带着堆栈', mine?.detail === 'at App.tsx:1:1', JSON.stringify(mine))

    console.log('\n7) 停预览再起：数据必须还在（停 ≠ 删库）')
    await rpc('preview.stop', { appId })
    const stopped = await rpc<{ preview: { state: string; url: string | null } }>('preview.status', { appId })
    check('停掉后 state=stopped 且没有 url', stopped.preview.state === 'stopped' && stopped.preview.url === null)

    const restartAt = Date.now()
    await rpc('preview.start', { appId })
    const again = await server.preview.waitReady(appId, 5 * 60 * 1000)
    check('第二次起得来（依赖已装好，快很多）', again.state === 'ready', again.error ?? '')
    console.log(`  二次就绪耗时 ${ms(restartAt)}`)
    const list2 = (await (await fetch(`${again.url ?? ''}/api/items`)).json()) as { items: Item[] }
    check('数据还在', list2.items.length === 1 && list2.items[0]?.title === '螺丝刀', JSON.stringify(list2.items))
  } finally {
    await server.close().catch(() => undefined)
    // 失败时一定留下现场：日志、pgdata、dist-server 都在里面，删了就真没法查
    if (keep || failures > 0) console.log(`\n保留目录：${home}`)
    else await rm(home, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error('\n炸了：', err)
  process.exit(1)
})
