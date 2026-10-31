/**
 * 工具层集成测试：Agent 到底有没有"能写文件"。
 *
 * 用 faux 的剧本驱动（`model.script`），不碰真模型 —— mock harness 是更差的选择，
 * 那会把真正要验的东西（pi-durable 的工具任务、git 提交、SSE 事件）全绕过去。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SseEvent } from '@tenon/protocol'
import type { RunningServer } from '../src/index.js'
import { boot as bootServer, openSse, rpc } from './support.js'

let dir: string
let running: RunningServer | undefined

const boot = (): Promise<RunningServer> => bootServer(dir)
const repoOf = (appId: string): string => join(dir, 'apps', appId, 'repo')

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/**
 * 建应用 + 连 SSE + 提交一轮，等这轮真正落定。
 *
 * 闸门是 `app.status: idle`，**不是** `git.commit`：这一轮没有文件改动时根本不会产生提交，
 * 拿提交当屏障会一直等到超时。idle 还是在提交之后才发的（服务端保证了顺序）。
 */
async function runTurn(appId: string, requestId: string): Promise<SseEvent[]> {
  const server = running as RunningServer
  const sse = openSse(server, appId)
  await sse.connected
  await rpc(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events) =>
    events.some((event) => event.type === 'app.status' && event.status === 'idle'),
  )
  sse.close()
  return sse.events
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-tools-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('工具层（write / edit / bash）', () => {
  it('write 真的落盘，并且这一轮产生了 git commit 与 tool.start 事件', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '写文件' })
    const model = running.agent.model
    expect(model?.mode).toBe('faux')
    model?.script([
      { tool: 'write', args: { path: 'index.html', content: '<h1>你好，榫</h1>\n' } },
      { text: '首页已经创建好了。' },
    ])

    const events = await runTurn(app.id, 'w1')

    const written = await readFile(join(repoOf(app.id), 'index.html'), 'utf8')
    expect(written).toContain('你好，榫')

    const started = events.find((event) => event.type === 'tool.start')
    expect(started?.type).toBe('tool.start')
    if (started?.type === 'tool.start') {
      expect(started.name).toBe('write')
      // 护栏：工具的参数要能在前端原样展示
      expect(started.args?.['path']).toBe('index.html')
    }

    const { commits } = await rpc<{ commits: Array<{ message: string }> }>(running, 'git.log', {
      appId: app.id,
    })
    // 建应用 1 个 + 这一轮 1 个
    expect(commits).toHaveLength(2)
    expect(commits[0]?.message).toContain('一轮对话')
  })

  it('edit 能改已有文件（read → edit 这条最常见的组合）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '改文件' })
    running.agent.model?.script([
      { tool: 'write', args: { path: 'App.tsx', content: 'export default function App() {\n  return null\n}\n' } },
      { text: '先建个空组件。' },
    ])
    await runTurn(app.id, 'e1')

    running.agent.model?.script([
      {
        tool: 'edit',
        // pi-coding-agent 的 edit 入参是 `edits: [{ oldText, newText }]`，不是 old_string/new_string
        args: { path: 'App.tsx', edits: [{ oldText: 'return null', newText: 'return <div>你好</div>' }] },
      },
      { text: '改好了。' },
    ])
    await runTurn(app.id, 'e2')

    const edited = await readFile(join(repoOf(app.id), 'App.tsx'), 'utf8')
    expect(edited).toContain('<div>你好</div>')
    expect(edited).not.toContain('return null')
  })

  it('bash 在应用仓库里执行，写出的文件进得了 commit', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '跑命令' })
    running.agent.model?.script([
      { tool: 'bash', args: { command: 'echo hello > note.txt' } },
      { text: '命令执行完了。' },
    ])
    const events = await runTurn(app.id, 'b1')

    const note = await readFile(join(repoOf(app.id), 'note.txt'), 'utf8')
    expect(note.trim()).toBe('hello')
    expect(events.some((event) => event.type === 'tool.start')).toBe(true)

    const { commits } = await rpc<{ commits: Array<{ message: string }> }>(running, 'git.log', {
      appId: app.id,
    })
    expect(commits).toHaveLength(2)
  })

  it('工具不能写到应用仓库之外（../ 越界被拒，且这一轮照样结束）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '越界' })
    running.agent.model?.script([
      { tool: 'write', args: { path: '../../escape.txt', content: '不该被写出来' } },
      { text: '写不了，被拦住了。' },
    ])
    await runTurn(app.id, 'x1')

    expect(await exists(join(dir, 'apps', 'escape.txt'))).toBe(false)
    expect(await exists(join(dir, 'escape.txt'))).toBe(false)
  })

  it('进程重启后，已有会话仍然拿得到完整工具集（configure 补上，老应用不掉队）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '老应用' })
    // 先跑一轮把会话建起来，再重启进程，模拟"应用是上个版本创建的"
    running.agent.model?.script([{ text: '先聊一句。' }])
    await runTurn(app.id, 'old1')
    await running.close()

    running = await boot()
    const session = await running.agent.pool?.acquire(app.id)
    expect(session?.tools.map((tool) => tool.name).sort()).toEqual(['bash', 'edit', 'read', 'write'])

    // 光有工具对象不够：还要确认它在真跑的这条路上确实能被调用
    running.agent.model?.script([
      { tool: 'write', args: { path: 'after-restart.txt', content: 'ok' } },
      { text: '重启之后也写得动。' },
    ])
    await runTurn(app.id, 'old2')
    expect(await exists(join(repoOf(app.id), 'after-restart.txt'))).toBe(true)
  })
})
