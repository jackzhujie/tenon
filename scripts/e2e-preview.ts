/**
 * 真机端到端：建应用 → 装依赖 → 起 Vite → 经网关打开首屏 → 改文件 → 停。
 *
 * 这条链路**不进 CI**：要联网装 React，第一次几十秒。`pnpm test` 里对应的部分是
 * 用 stub 上游验状态机（`packages/gateway/test/preview.test.ts` 等）。
 *
 * 用法：
 *   pnpm e2e:preview            # 跑完删临时目录
 *   pnpm e2e:preview --keep     # 留下目录，自己用浏览器看
 *   TENON_FAUX=1 pnpm e2e:preview
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-token'
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

function ms(from: number): string {
  return `${Date.now() - from}ms`
}

/**
 * 轮询到页面里出现某段文本。
 *
 * 为什么不能"写完立刻 GET"：Vite 的转译缓存是靠文件监听失效的，写完那一刻
 * watcher 可能还没回调（chokidar 有几十毫秒的合并窗口）。真实的 HMR 也是这条路径，
 * 所以这里轮询而不是断言"一次就对"——一次就对反而说明走的是别的机制。
 */
async function waitForContent(url: string, needle: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await (await fetch(url)).text()
    if (last.includes(needle)) return last
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return last
}

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: {
    // 首次装依赖要联网，把首屏等待放宽
    readyTimeoutMs: 5 * 60 * 1000,
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

try {
  console.log('1) 建应用')
  const created = await rpc<{ app: { id: string; slug: string } }>('app.create', {
    name: '待办清单 E2E',
  })
  const appId = created.app.id
  const repo = join(home, 'apps', appId, 'repo')
  check('模板已铺好（index.html 存在）', await readFile(join(repo, 'index.html'), 'utf8').then(
    (html) => html.includes('<div id="root">'),
    () => false,
  ))
  check('package.json 名字是 slug', await readFile(join(repo, 'package.json'), 'utf8').then(
    (raw) => (JSON.parse(raw) as { name: string }).name === created.app.slug,
    () => false,
  ))

  console.log('\n2) 起预览（首次要 pnpm install，可能要几十秒）')
  const installStart = Date.now()
  await rpc('preview.start', { appId })
  const ready = await server.preview.waitReady(appId, 5 * 60 * 1000)
  if (ready.state !== 'ready') {
    throw new Error(`预览没就绪：${ready.error ?? '未知原因'}`)
  }
  console.log(`  就绪耗时 ${ms(installStart)}（含依赖安装）`)
  const url = ready.url as string
  console.log(`  网关地址 ${url}（dev server 在 :${ready.upstreamPort}）`)
  check('readiness 三项都 ready', JSON.stringify(ready.readiness) ===
    JSON.stringify({ deps: 'ready', server: 'ready', preview: 'ready' }))

  console.log('\n3) 打开首屏（经网关，不是直连 dev server）')
  const html = await (await fetch(url)).text()
  check('HTML 里有挂载点', html.includes('<div id="root">'))
  check('HTML 里引了入口模块', html.includes('/src/main.tsx'))
  check('HTML 是模板渲染过的（没有残留占位符）', !html.includes('{{'))

  const entry = await (await fetch(`${url}/src/main.tsx`)).text()
  check('入口模块被 Vite 转译过（拿到的是 JS 不是 TSX）', entry.includes('jsxDEV') || entry.includes('jsx('))
  check('入口模块里没有 TS 类型标注残留', !entry.includes(': string'))

  console.log('\n4) 改一个文件（Agent 写代码走的就是这条路）')
  const appFile = join(repo, 'src', 'App.tsx')
  const before = await readFile(appFile, 'utf8')
  await writeFile(appFile, before.replace('<h1>{appName}</h1>', '<h1>改过了：{appName}</h1>'), 'utf8')

  const patched = await waitForContent(`${url}/src/App.tsx`, '改过了')
  check(
    'dev server 重新转译了新内容（HMR 骑的就是这条路）',
    patched.includes('改过了'),
    `最后 200 字：${patched.slice(-200)}`,
  )

  console.log('\n5) 停预览')
  const stopped = await rpc<{ preview: { state: string } }>('preview.stop', { appId })
  check('state 回到 stopped', stopped.preview.state === 'stopped')
  const gone = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(
    () => false,
    () => true,
  )
  check('网关已经关掉', gone)
} catch (err) {
  failures += 1
  console.error('\n运行失败：', err instanceof Error ? err.message : err)
} finally {
  await server.close()
  if (keep) console.log(`\n保留目录：${home}`)
  else await rm(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
