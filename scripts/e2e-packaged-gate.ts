/**
 * 打包运行时的门禁回归：**用 Electron 二进制跑 `dist/server/server.mjs`，并把 PATH 里的 node 去掉**。
 *
 * ## 为什么必须单开这一条
 *
 * `node-shim` 修的是"打包版的机器上没有 Node"：应用自己的 `node_modules/.bin/*` 是
 * `exec node` 的 shim，没有 node 就报 `exec: node: not found`，于是
 *
 * - 发布门禁的 lint 永远红，
 * - 导出静态包 / Docker 上下文在 `pnpm run build` 那一步失败。
 *
 * 而这个 bug **在单元测试层测不出来**：vitest 跑在 node 里，`process.versions.electron`
 * 是空的 —— `nodeShimDir()` 直接返回 `null`，薄壳根本不会被创建。所以必须真的用
 * Electron 二进制起一次服务，并且真的把 node 从 PATH 里拿掉。
 *
 * ## 它验的三件事
 *
 * 1. 服务能在"没有 node 的 PATH"里起来（这本身就是打包版的启动条件）
 * 2. 应用的依赖装得上（`pretest` 之后 `node_modules/vite` 存在）
 * 3. `release.check` 的 lint 那一项**真的跑了**，而且输出里没有 `exec: node: not found`
 *
 * 用法：`pnpm e2e:packaged`（先 `pnpm build:desktop`）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const appDir = join(repo, 'apps', 'desktop')
const serverEntry = join(appDir, 'dist', 'server', 'server.mjs')

const require = createRequire(import.meta.url)
/** electron 包的默认导出就是可执行文件路径；带 `ELECTRON_RUN_AS_NODE=1` 时它就是 node */
const electronPath = require(join(appDir, 'node_modules', 'electron')) as unknown as string

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; details?: unknown }
}

interface CheckOutcome {
  id: string
  status: 'pass' | 'fail' | 'skip'
  summary: string
  detail: string | null
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail === '' ? '' : `\n     ${detail}`}`)
  }
}

async function main(): Promise<void> {
  if (!existsSync(serverEntry)) {
    throw new Error(`没有打包产物：${serverEntry}\n先跑 \`pnpm build:desktop\``)
  }
  const home = await mkdtemp(join(tmpdir(), 'tenon-packaged-'))

  /*
   * ★ 关键：PATH 里**没有** node。
   * `/usr/local/bin` 通常是 node 的安装位置，这里刻意只留 `/usr/bin:/bin`（sh/sed/dirname 够用）。
   * 如果这条脚本在 PATH 里仍能跑通，说明我们真的自己解决了 node。
   */
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TENON_HOME: home,
    TENON_FAUX: '1',
    ELECTRON_RUN_AS_NODE: '1',
    PATH: '/usr/bin:/bin',
  }
  delete env['NODE_OPTIONS']

  console.log(`1) 用 Electron 二进制起 server（PATH=${env['PATH']}，里面没有 node）`)
  const child = spawn(electronPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] })

  let ready: { url: string; token: string } | null = null
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    const match = /TENON_READY (\{.*\})/.exec(chunk)
    if (match !== null && ready === null) {
      const parsed = JSON.parse(match[1]!) as { url: string; token: string }
      ready = { url: parsed.url, token: parsed.token }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const server = await waitFor(() => ready, 30_000, '服务没在 30 秒内就绪')
  console.log(`   ${server.url}`)

  const rpc = async <T>(method: string, input: unknown): Promise<T> => {
    const response = await fetch(`${server.url}/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify(input),
    })
    const body = (await response.json()) as Envelope<T>
    if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
    return body.data as T
  }

  try {
    console.log('2) 建应用（react-vite），等依赖装上')
    const created = await rpc<{ app: { id: string } }>('app.create', {
      name: '打包门禁回归',
      templateId: 'react-vite',
      styleId: null,
    })
    const appId = created.app.id
    const marker = join(home, 'apps', appId, 'repo', 'node_modules', 'vite', 'package.json')

    /*
     * 装依赖是建应用时 fire-and-forget 起的（十几秒）。这里等的是"应用自己的工作区里
     * 真的有 vite" —— 它是 `pnpm run lint` 能跑起来的前提之一。
     */
    const deadline = Date.now() + 180_000
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    check('依赖装好了（repo/node_modules/vite 存在）', existsSync(marker), `等的是 ${marker}`)

    console.log('3) 跑发布门禁：lint 必须真跑（而不是"node 找不到"）')
    const result = await rpc<{ gate: { ok: boolean; checks: CheckOutcome[] }; blocked: unknown }>(
      'release.check',
      { appId },
    )
    const lint = result.gate.checks.find((item) => item.id === 'lint')
    check('门禁里有 lint 这一项', lint !== undefined)
    if (lint !== undefined) {
      const text = `${lint.summary}\n${lint.detail ?? ''}`
      console.log(`   lint: ${lint.status} — ${lint.summary}`)
      check(
        '★ lint 不是"node 找不到"（这是这条脚本存在的理由）',
        !/exec: node: not found|node: not found|not recognized as an internal/i.test(text),
        text.slice(0, 400),
      )
      // 模板是干净的：lint 要么通过，要么报的是**代码问题**（不是环境问题）
      check('lint 状态是 pass（react-vite 模板本身没有 lint 错误）', lint.status === 'pass', text.slice(0, 400))
    }

    /*
     * 导出静态包走的是同一条 `pnpm run build` —— 也就依赖同一个 node。
     * `installDeps: false` 是为了快：装生产依赖要再跑一次 pnpm（几十秒），
     * 而这里要验的是 **build 能不能跑起来**，不是产物完整性。
     */
    console.log('4) 导出静态包：build 也必须真跑')
    const exported = await rpc<{ dir: string }>('export.static', { appId, installDeps: false })
    /*
     * 布局是：`start.sh`（一条命令起来）+ `dist/`（vite 的产物）+ `server.js` + README。
     * `index.html` 在 `dist/` 下，不在根上。
     */
    check('导出的目录存在', existsSync(exported.dir), exported.dir)
    check('有 start.sh（"拷走就能跑"的入口）', existsSync(join(exported.dir, 'start.sh')), exported.dir)
    check(
      '有 dist/index.html（说明 vite build 真的跑完了）',
      existsSync(join(exported.dir, 'dist', 'index.html')),
      exported.dir,
    )
  } finally {
    child.kill('SIGKILL')
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }

  if (stderr.trim() !== '') {
    const lines = stderr.trim().split('\n')
    console.log(`\nserver stderr（末 6 行）：\n${lines.slice(-6).join('\n')}`)
  }
  if (failures > 0) {
    console.log(`\n${failures} 项失败`)
    if (stdout.trim() !== '') console.log(`\nserver stdout（末 10 行）：\n${stdout.trim().split('\n').slice(-10).join('\n')}`)
    process.exit(1)
  }
  console.log('\n全部通过 ✅')
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, message: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
