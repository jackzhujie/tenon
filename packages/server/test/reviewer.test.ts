/**
 * Reviewer 子 Agent 的集成测试（M4 第 5 步）。
 *
 * 验的是**接线与判据**，不是模型的判断力（`faux` 不会推理）：
 * 1. 主角色改完代码 → 派活给 reviewer；
 * 2. reviewer 拿到 `git_diff` + `typecheck`（白名单里有，写工具一个都没有）；
 * 3. `git_diff` 真的看到了**还没提交**的改动（这是评审的关键时机，不是看上一版）；
 * 4. `typecheck` 在依赖没装时说"没跑成"，**不说 ✓**（评审里最坏的假绿就是这一条）；
 * 5. 风险清单原样回到父轮，这一轮照常提交。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentContext } from '@tenon/agent'
import type { NormalizedMessage, SseEvent } from '@tenon/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { boot as bootServer, openSse, rpc } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-reviewer-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

interface ToolResultRow {
  toolName?: string
  content?: { type: string; text?: string }[]
  isError?: boolean
}

/** 某个会话自己的工具结果（子会话的结论要到它自己的 transcript 里找） */
async function toolResultsOf(appId: string, conversationId?: string): Promise<ToolResultRow[]> {
  const session = await (running as RunningServer).agent.pool?.acquire(appId)
  if (session === undefined) return []
  const conversation =
    conversationId === undefined
      ? session.root
      : await session.harness.conversation(conversationId as never, agentContext)
  if (conversation === undefined) return []
  const view = await conversation.viewState(agentContext)
  try {
    const entries = view.value.entries as unknown as Array<{ kind: string; model?: ToolResultRow[] }>
    return entries.filter((entry) => entry.kind === 'pi.tool-result').flatMap((entry) => entry.model ?? [])
  } finally {
    await view.dispose?.()
  }
}

function textOf(row: ToolResultRow | undefined): string {
  return row?.content?.map((part) => part.text ?? '').join('') ?? ''
}

async function childConversationIds(appId: string): Promise<string[]> {
  const session = await (running as RunningServer).agent.pool?.acquire(appId)
  if (session === undefined) return []
  const page = await session.root.commit(async (tx) => (await tx.scanConversations({}, 20)).items, agentContext)
  return page.filter((record) => record.owner !== undefined).map((record) => String(record.id))
}

async function runTurn(appId: string, requestId: string): Promise<SseEvent[]> {
  const server = running as RunningServer
  const sse = openSse(server, appId)
  await sse.connected
  await rpc(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events) => events.some((event) => event.type === 'app.status' && event.status === 'idle'))
  sse.close()
  return sse.events
}

async function lastAssistantText(appId: string): Promise<string> {
  const { messages } = await rpc<{ messages: NormalizedMessage[] }>(running as RunningServer, 'chat.history', {
    appId,
  })
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  return (last?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

describe('reviewer 子 Agent', () => {
  it('★ 改完代码派活：git_diff 看到未提交的改动，typecheck 说"没跑成"而不是"通过"', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '评审' })
    const repoFile = join(dir, 'apps', app.id, 'repo', 'src', 'App.tsx')

    running.agent.model?.script([
      // 父轮：先改代码，再派活（评审的对象是"刚改的这几行"）
      {
        tool: 'write',
        args: {
          path: 'src/App.tsx',
          content: 'export default function App() {\n  return <main>待评审</main>\n}\n',
        },
      },
      { tool: 'subagent', args: { role: 'reviewer', task: '审一下这一轮的改动' } },
      { text: '收到风险清单，先不改。' },
      // 子轮：按角色的工作顺序，先 diff 再 typecheck
      { as: 'reviewer', tool: 'git_diff', args: {} },
      { as: 'reviewer', tool: 'typecheck', args: {} },
      { as: 'reviewer', text: '[nit] src/App.tsx:2 — 文案写死成"待评审" — 换成变量或删掉\n检查了 diff；类型检查没跑成（依赖未安装）。' },
    ])

    const events = await runTurn(app.id, 'r1')

    // 1. 派活这件事在事件流里，参数是 reviewer
    const started = events.find((event) => event.type === 'tool.start' && event.name === 'subagent')
    if (started?.type === 'tool.start') expect(started.args?.['role']).toBe('reviewer')

    // 2. 子会话拿到的工具：有判据工具，没有一个写工具
    const session = await running.agent.pool?.acquire(app.id)
    const childId = (await childConversationIds(app.id))[0]
    expect(childId).toBeDefined()
    const childAgent = await (
      await session!.harness.conversation(childId as never, agentContext)
    )?.agent(agentContext)
    const childTools = (childAgent?.tools ?? []).map((tool) => tool.name).sort()
    expect(childTools).toEqual(['git_diff', 'glob', 'grep', 'lint', 'ls', 'read', 'typecheck'])
    for (const forbidden of ['write', 'edit', 'bash', 'subagent']) expect(childTools).not.toContain(forbidden)

    // 3. ★ git_diff 看的是工作区：那一行改动还没提交，它就得看得见
    const childResults = await toolResultsOf(app.id, childId)
    const diff = childResults.find((row) => row.toolName === 'git_diff')
    const diffText = textOf(diff)
    expect(diff?.isError).toBeFalsy()
    expect(diffText).toContain('src/App.tsx')
    expect(diffText).toContain('+')
    expect(diffText).toContain('待评审')

    // 4. ★ 依赖没装时 typecheck 明确说"没跑成"，且绝不出现 ✓
    const typecheck = childResults.find((row) => row.toolName === 'typecheck')
    const typecheckText = textOf(typecheck)
    expect(typecheck?.isError).toBeFalsy()
    expect(typecheckText).toContain('Did not run')
    expect(typecheckText).not.toContain('✓')

    // 5. 清单回到父轮，父轮据此收尾
    expect(await lastAssistantText(app.id)).toContain('先不改')
    // 代码没被 reviewer 改掉（它读不到写工具）
    expect(await readFile(repoFile, 'utf8')).toContain('待评审')

    // 6. 一轮一 commit 的语义没变：改过文件，所以这一轮产生了一个提交
    const { commits } = await rpc<{ commits: unknown[] }>(running, 'git.log', { appId: app.id })
    expect(commits).toHaveLength(2)
  })

  it('没有改动时它不会编出风险：git_diff 说工作区是干净的', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '没改动' })

    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'reviewer', task: '审一下' } },
      { text: '没改动可审。' },
      { as: 'reviewer', tool: 'git_diff', args: {} },
      { as: 'reviewer', text: '工作区是干净的，没有可评审的改动。' },
    ])
    await runTurn(app.id, 'r2')

    const childId = (await childConversationIds(app.id))[0]
    const diff = (await toolResultsOf(app.id, childId)).find((row) => row.toolName === 'git_diff')
    expect(textOf(diff)).toContain('working tree is clean')
    // 干净的工作区不该被当成"看过一遍、没问题"
    expect(textOf(diff)).toContain('commit:"HEAD"')
  })
})
