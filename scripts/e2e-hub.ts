/**
 * 从零发布一个组件（M6 第 5 步）：**一条命令走完"发出去 → 被装上"**。
 *
 * 为什么这件事必须是个可复跑脚本，而不是文档里的一段手工步骤：
 * 发布链路横跨四个环节（打包签名 → 索引签名 → 静态托管 → 客户端验签安装），
 * 每一环都有"看起来成功、其实没生效"的错法：
 *
 * - 包签了但索引没签 → 客户端拒（安全正确，但发布者会以为是网络问题）
 * - 索引写了相对地址 → 客户端拒（`url-outside-hub`），而本地手点一切正常
 * - 包里的清单没改成 `source: 'hub'` → 装上了但加载器不认
 * - 索引没标 `pricing` → 付费组件被下载到用户磁盘（M6 第 5 步补的门）
 *
 * 单测里那些事都验过，但验的是**夹具**（`fake-hub.ts` 手搓的索引）。这里验的是
 * `pnpm pack:plugin` 的**真实产物**：同一个 `packComponent`、同一套签名、真正的
 * HTTP 静态目录。发布当天不会出现"我们的包先生不出来"。
 *
 * 用法：`pnpm e2e:hub`（不联网、不要密钥 —— 现场生成一对临时 Ed25519 密钥）
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hubKeyFingerprint } from '../packages/component-host/src/index.js'
import { startServer, type RunningServer } from '../packages/server/src/index.js'
import { PackError, packComponent } from './lib/pack.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(join(here, '..'))
const SOURCE_DIR = join(repo, 'plugins', 'bundled')

/** 免费的那个：无权限、只有 web facet —— 最能代表"一个普通组件" */
const FREE = 'tenon.official.csv-export'
/** 做成付费版的那个：用它验"连下载都不给" */
const PAID = 'tenon.official.approval'

const TOKEN = 'e2e-hub-token'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; details?: { hint?: string } }
}

async function rpc<T>(server: RunningServer, method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.code ?? '?'} ${body.error?.message ?? ''}`)
  return body.data as T
}

/** 与前端 `rpc()` 同一个判断：期望失败时用这个，拿到 code 而不是异常 */
async function rpcError(
  server: RunningServer,
  method: string,
  input: unknown = {},
): Promise<{ status: number; code: string; message: string }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<unknown>
  return { status: response.status, code: body.error?.code ?? '', message: body.error?.message ?? '' }
}

/**
 * 一个真的静态 Hub：从目录里读文件。
 *
 * 不做 MIME / 缓存 / 目录索引 —— 客户端只要 JSON，多写一层反而会掩盖真实问题。
 * 路径穿越只防一下（`..` 拒绝）：这是本机脚本，但"用别人的字节拼路径"这个习惯不该带出去。
 */
function startStaticHub(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    if (path.includes('..')) {
      res.writeHead(400)
      res.end('{}')
      return
    }
    void readFile(join(root, path))
      .then((data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(data)
      })
      .catch(() => {
        res.writeHead(404)
        res.end('{}')
      })
  })
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      resolveListen({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

const work = await mkdtemp(join(tmpdir(), 'tenon-e2e-hub-'))
const home = join(work, 'home')
const hubRoot = join(work, 'hub')
await mkdir(home, { recursive: true })
await mkdir(hubRoot, { recursive: true })

/*
 * 密钥现场生成。真实发布用的是 `~/.tenon/hub-key.pem` 那种长期私钥，而这里每次都换 ——
 * 恰好能顺带证明"客户端只认指纹对应的那一把"这件事没有别的隐藏依赖。
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

console.log(`工作目录 = ${work}\n`)

const hub = await startStaticHub(hubRoot)
let server: RunningServer | undefined

try {
  console.log(`1) 起一个空 Hub（${hub.url}）—— 还没有任何组件`)
  const emptyIndex = await fetch(`${hub.url}/index.json`)
  check('空 Hub 上读 index.json 是 404（不是空清单 —— 客户端要能分辨"没发布"与"发布了但为空"）', emptyIndex.status === 404)

  console.log('\n2) 用发布脚本打第一个包（免费组件）')
  const free = await packComponent({
    sourceDir: SOURCE_DIR,
    outDir: hubRoot,
    id: FREE,
    privateKey: PRIVATE_PEM,
    hubUrl: hub.url,
  })
  check(`产出 ${FREE}-${free.version}.json`, (await stat(free.file)).size > 0)
  check('同一次发布里写了签名索引', free.indexFile !== null)

  console.log('\n3) 再发一个付费组件（同一个 Hub、同一个索引）')
  const paid = await packComponent({
    sourceDir: SOURCE_DIR,
    outDir: hubRoot,
    id: PAID,
    privateKey: PRIVATE_PEM,
    // 只是把清单里的 pricing 改掉 —— 组件代码本身不变，这正是"付费"在协议里的含义
    patchManifest: (raw) => ({ ...raw, pricing: { type: 'paid', sku: 'tenon.official.approval.pro' } }),
    hubUrl: hub.url,
  })
  check('索引里现在有两个组件', paid.indexComponents === 2, `实际 ${paid.indexComponents}`)

  console.log('\n4) 起真 server（配置指向这个 Hub）')
  server = await startServer({
    port: 0,
    token: TOKEN,
    env: {
      TENON_HOME: home,
      TENON_FAUX: '1',
      TENON_HUB_URL: hub.url,
      // 故意写成一行带字面量 \n 的形式：CI 里 PEM 就是这么传的
      TENON_HUB_PUBLIC_KEY: PUBLIC_PEM.replaceAll('\n', '\\n'),
    },
    preview: { installDeps: false },
  })
  console.log(`   server = ${server.url}`)

  const status = await rpc<{
    configured: boolean
    hubUrl: string | null
    keyFingerprint: string | null
    origin: string | null
    note: string | null
  }>(server, 'hub.status')
  check('hub.status 说已配置', status.configured)
  check('来源是环境变量', status.origin === 'env', `实际 ${String(status.origin)}`)
  check(
    '公钥指纹与客户端算的一致（一行 PEM 也能还原）',
    status.keyFingerprint === hubKeyFingerprint(PUBLIC_PEM),
    `server=${String(status.keyFingerprint)} 本地=${hubKeyFingerprint(PUBLIC_PEM)}`,
  )

  console.log('\n5) 检查更新：索引验签通过就能看到目录')
  const catalog = await rpc<{
    reachable: boolean
    error: string | null
    components: { id: string; latest: string; paid: boolean; installedVersion: string | null }[]
  }>(server, 'hub.check')
  check('连得上且索引验签通过', catalog.reachable && catalog.error === null, String(catalog.error))
  const freeEntry = catalog.components.find((item) => item.id === FREE)
  const paidEntry = catalog.components.find((item) => item.id === PAID)
  check(`目录里有 ${FREE}@${free.version}`, freeEntry?.latest === free.version)
  check('免费组件的 paid 标记是 false', freeEntry?.paid === false)
  check('付费组件的 paid 标记是 true（来自包里的清单，索引照它标）', paidEntry?.paid === true)
  check('两个都还没装到本机', freeEntry?.installedVersion === null && paidEntry?.installedVersion === null)

  console.log('\n6) 装到本机（hub.install）')
  const installed = await rpc<{ id: string; version: string; dir: string }>(server, 'hub.install', { id: FREE })
  check(`装在 ${installed.dir.replace(work, '<work>')}`, installed.dir.startsWith(join(home, 'plugins')))
  check('包里的清单被改写成 source=hub（否则加载器不认）', await hasHubSource(installed.dir))

  console.log('\n7) 付费组件：连下载都不给')
  const paidAttempt = await rpcError(server, 'hub.install', { id: PAID })
  check('返回 HUB_PAID_NOT_AVAILABLE（不是"包坏了"）', paidAttempt.code === 'HUB_PAID_NOT_AVAILABLE', paidAttempt.code)
  check('提示里说了"购买流程还没做"', /购买|付费/.test(paidAttempt.message), paidAttempt.message)
  check(
    '磁盘上连目录都没建（不是下下来再拒）',
    await absent(join(home, 'plugins', PAID)),
  )

  console.log('\n8) 装进应用（component.install —— 与 Agent 的工具同一个入口）')
  const created = await rpc<{ app: { id: string } }>(server, 'app.create', { name: 'Hub 验收' })
  const appId = created.app.id
  const inApp = await rpc<{
    components: { id: string; version: string; source: string; loaded: boolean }[]
    problems: { code: string; message: string }[]
    downloaded: boolean
  }>(server, 'component.install', { appId, id: FREE })
  const mounted = inApp.components.find((item) => item.id === FREE)
  check('装配声明里有它', mounted !== undefined)
  check('加载器选中了 hub 那一份（覆盖层生效）', mounted?.source === 'hub', String(mounted?.source))
  check('版本就是刚发布的那个', mounted?.version === free.version)
  check('真的会被加载（不是只写了个声明）', mounted?.loaded === true)
  check('没有再下载一次（本机已经有了）', inApp.downloaded === false)
  check('没有任何 problem', inApp.problems.length === 0, JSON.stringify(inApp.problems))

  const agentsDoc = await readFile(join(home, 'apps', appId, 'repo', 'docs', 'AGENTS.md'), 'utf8').catch(() => '')
  check('AGENTS.md 同步了（不然 Agent 会自己再写一个）', agentsDoc.includes(FREE))

  console.log('\n9) 索引被改过 → 客户端必须拒（降级攻击的入口）')
  const indexPath = join(hubRoot, 'index.json')
  const goodIndex = await readFile(indexPath, 'utf8')
  const tampered = JSON.parse(goodIndex) as { components: { versions: { version: string }[] }[] }
  const downgrade = tampered.components[0]?.versions[0]
  if (downgrade !== undefined) downgrade.version = '0.0.1'
  await writeFile(indexPath, JSON.stringify(tampered))
  const afterTamper = await rpc<{ reachable: boolean; error: string | null; components: unknown[] }>(
    server,
    'hub.check',
  )
  check('reachable=false（不是崩溃、也不是静默用旧数据）', afterTamper.reachable === false)
  check('原因指向验签', /签名|signature/i.test(afterTamper.error ?? ''), String(afterTamper.error))
  check('目录是空的（不拿没验过的数据凑数）', afterTamper.components.length === 0)
  await writeFile(indexPath, goodIndex)
  const restored = await rpc<{ reachable: boolean }>(server, 'hub.check')
  check('还原之后立刻恢复（没有把坏结果缓存住）', restored.reachable === true)

  console.log('\n10) 卸掉之后回到"可安装"，且本机的包还在')
  const removed = await rpc<{ removed: boolean; components: unknown[] }>(server, 'component.remove', { appId, id: FREE })
  check('移除了', removed.removed === true)
  const list = await rpc<{ available: { id: string; installed: boolean; source: string }[] }>(server, 'component.list', {
    appId,
  })
  const available = list.available.find((item) => item.id === FREE)
  check('回到可安装列表', available !== undefined && available.installed === false)
  check('本机的包没被删（"移除"不是"卸载"）', !(await absent(installed.dir)))

  console.log('\n11) 密钥不对时也要拒（同一个 Hub、换一把公钥）')
  const { publicKey: otherKey } = generateKeyPairSync('ed25519')
  // 不重启 server：直接看客户端函数的行为更省时间，也更能说明"验签是本地计算"
  const { fetchHubIndex } = await import('../packages/component-host/src/index.js')
  const wrongKey = await fetchHubIndex({
    config: { hubUrl: hub.url, publicKey: otherKey.export({ type: 'spki', format: 'pem' }).toString() },
  })
  check('换一把公钥 → 验签失败', !wrongKey.ok && wrongKey.problem.code === 'bad-signature')
} catch (error) {
  failures += 1
  console.log(`\n✗ 中断：${error instanceof PackError ? error.message : String(error)}`)
} finally {
  await server?.close().catch(() => {})
  await hub.close()
  await rm(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过：一个组件从零发布到被装上，链路完整。')

/** 装好的包里的 manifest 是不是 `source: 'hub'` */
async function hasHubSource(dir: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { source?: string }
    return raw.source === 'hub'
  } catch {
    return false
  }
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch {
    return true
  }
}
