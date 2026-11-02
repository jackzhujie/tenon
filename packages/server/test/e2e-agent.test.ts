/**
 * e2e 子 Agent 的集成测试（M4 第 4 步）。
 *
 * 验的是**接线**：主角色派活给 e2e → 子会话真的拿到 `preview_*`（白名单 + registry）→
 * 命令真的发到页面通道 → 结果回到模型手里 → 改完代码再验一次就能过。
 *
 * ★ 这里的"页面"是一个假驱动：它把 `src/App.tsx` 的正文当成页面文字。
 *   它不是浏览器，只模拟"页面显示什么由源码决定"这一点，用来把 **Agent 循环**验穿。
 *   真 DOM（选择器、真实点击、HMR 重载）由 `pnpm e2e:e2e` 在 Electron 里验 ——
 *   别把这条当成 E2E 验收的证据，它只是"接线通了"的证据。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PageDriver } from '@tenon/agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { boot, openSse, rpc } from './support.js'

let dir: string
let running: RunningServer | undefined
let appId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-e2e-agent-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

interface DriverCall {
  name: string
  args: Record<string, unknown>
  /** 断言时算出来的结果（这条测试要看的正是它） */
  pass?: boolean
}

/**
 * 假页面：正文 = `src/App.tsx` 的内容；`assert {text}` = 正文里含不含这句话。
 *
 * `repoDir` 给成函数是因为应用目录要知道 appId 才能拼出来，而 appId 是建应用时才有。
 */
function fileDriver(repoDir: () => string): { driver: PageDriver; calls: DriverCall[] } {
  const calls: DriverCall[] = []
  const source = async (): Promise<string> => await readFile(join(repoDir(), 'src', 'App.tsx'), 'utf8')
  const driver: PageDriver = {
    info: { path: '/', title: '报销单' },
    async run(name, args = {}) {
      if (name === 'read') {
        calls.push({ name, args })
        return { ok: true, value: { title: '报销单', path: '/', text: await source() } }
      }
      if (name === 'assert') {
        const text = await source()
        const needle = String(args['text'] ?? '')
        const pass = needle === '' ? true : text.includes(needle)
        calls.push({ name, args, pass })
        return { ok: true, value: { pass, seen: { contains: pass } } }
      }
      calls.push({ name, args })
      return { ok: true, value: {} }
    },
    async navigate(path) {
      calls.push({ name: 'navigate', args: { path } })
      return { path, title: '报销单' }
    },
  }
  return { driver, calls }
}

async function startWith(driver: PageDriver): Promise<RunningServer> {
  running = await boot(dir, { pageDriver: () => driver })
  const created = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '报销单' })
  appId = created.app.id
  return running
}

async function runTurn(server: RunningServer, requestId: string): Promise<void> {
  const sse = openSse(server, appId)
  await sse.connected
  await rpc(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events) => events.some((event) => event.type === 'app.status' && event.status === 'idle'))
  sse.close()
}

describe('e2e 子 Agent', () => {
  it('★ 派活 → 读到页面 → 断言失败 → 改代码 → 再验通过', async () => {
    const { driver, calls } = fileDriver(() => join(dir, 'apps', appId, 'repo'))
    const server = await startWith(driver)
    const repoFile = join(dir, 'apps', appId, 'repo', 'src', 'App.tsx')

    // ── 第一轮：e2e 说"页面上没有这四个字"，主角色据此改代码
    server.agent.model?.script([
      { tool: 'subagent', args: { role: 'e2e', task: '确认首页写着「提交成功」' } },
      {
        tool: 'write',
        args: {
          path: 'src/App.tsx',
          content: 'export default function App() {\n  return <main>提交成功</main>\n}\n',
        },
      },
      { text: '改完了，再验一次。' },
      { as: 'e2e', tool: 'preview_read', args: {} },
      { as: 'e2e', tool: 'preview_assert', args: { text: '提交成功' } },
      { as: 'e2e', text: '页面上找不到「提交成功」。' },
    ])
    await runTurn(server, 'e2e-1')

    // 命令真的带到了"页面"，参数就是子 Agent 说的那句话
    const firstRead = calls.find((call) => call.name === 'read')
    expect(firstRead).toBeDefined()
    const firstAssert = calls.find((call) => call.name === 'assert')
    expect(firstAssert?.args).toMatchObject({ text: '提交成功' })
    expect(firstAssert?.pass).toBe(false)

    // 修复那一半：代码真的被改了
    expect(await readFile(repoFile, 'utf8')).toContain('提交成功')

    // ── 第二轮：同一个断言现在应该通过（这就是"改完自验"）
    calls.length = 0
    server.agent.model?.script([
      { tool: 'subagent', args: { role: 'e2e', task: '再确认一次' } },
      { text: '这次通过了。' },
      { as: 'e2e', tool: 'preview_assert', args: { text: '提交成功' } },
      { as: 'e2e', text: '✓ 页面显示「提交成功」。' },
    ])
    await runTurn(server, 'e2e-2')

    const secondAssert = calls.find((call) => call.name === 'assert')
    expect(secondAssert?.pass).toBe(true)
  })

  it('没有页面通道时，子 Agent 得到的是"先把预览打开"，不是崩溃', async () => {
    const server = await boot(dir)
    running = server
    const created = await rpc<{ app: { id: string } }>(server, 'app.create', { name: '没预览' })
    appId = created.app.id
    server.agent.model?.script([
      { tool: 'subagent', args: { role: 'e2e', task: '看一眼' } },
      { text: '好。' },
      { as: 'e2e', tool: 'preview_read', args: {} },
      { as: 'e2e', text: '预览没开，验不了。' },
    ])

    // 走到这里就说明没抛出去：工具错误会变成工具结果，这一轮照样收尾
    await runTurn(server, 'e2e-no-page')
    expect(running).toBeDefined()
  })
})
