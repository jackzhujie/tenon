/**
 * 子 Agent（M4 第 1 步）：`subagent` 工具真的派活给一个子会话。
 *
 * 用 faux 的**分道剧本**驱动（`script([{...} as explore])`）：父轮与子轮各走各的队列。
 * 这个能力是测试逼出来的 —— 最初一条队列时，父轮 `[tool subagent, text]` 里那句 text
 * 会被子会话先吃掉，父轮收尾直接撞 "No more faux responses queued"。
 *
 * 断言都落在"能看见的东西"上：SSE 事件、tool-result 条目、子会话的 `agent.tools`、会话数。
 * 不去 mock harness —— mock 掉之后"子会话到底有没有真的跑"就无人验证了。
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

const boot = (): Promise<RunningServer> => bootServer(dir)

interface ToolResultModel {
  toolName?: string
  content?: { type: string; text?: string }[]
  details?: { role?: string; conversationId?: string; reused?: boolean; tools?: string[] }
  isError?: boolean
}

/** 从根会话的 transcript 里挑出工具结果（`pi.tool-result` 的 `model[0]` 就是它） */
async function toolResults(appId: string): Promise<ToolResultModel[]> {
  const session = await (running as RunningServer).agent.pool?.acquire(appId)
  if (session === undefined) return []
  const view = await session.root.viewState(agentContext)
  try {
    const entries = view.value.entries as unknown as Array<{ kind: string; model?: ToolResultModel[] }>
    return entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .flatMap((entry) => entry.model ?? [])
  } finally {
    await view.dispose?.()
  }
}

interface ConversationRow {
  id: string
  /** 创建者边：子会话指向发起它的工具 task（根会话没有 owner） */
  owner?: { conversationId: string; taskId: string }
}

async function conversations(appId: string): Promise<ConversationRow[]> {
  const session = await (running as RunningServer).agent.pool?.acquire(appId)
  if (session === undefined) return []
  const page = await session.root.commit(async (tx) => (await tx.scanConversations({}, 20)).items, agentContext)
  return page.map((record) => ({
    id: String(record.id),
    ...(record.owner === undefined
      ? {}
      : { owner: { conversationId: String(record.owner.conversationId), taskId: String(record.owner.taskId) } }),
  }))
}

/** 子会话（owner 不为空的那个） */
async function childConversations(appId: string): Promise<ConversationRow[]> {
  return (await conversations(appId)).filter((record) => record.owner !== undefined)
}

/** 建应用 + 连 SSE + 跑一轮，等这轮真正落定（`app.status: idle`） */
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-subagent-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('subagent 工具', () => {
  it('真的建了子会话：父轮拿到 explore 的结论并正常收尾，仍然只产生一个 commit', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '派活' })
    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'explore', task: 'handle 定义在哪' } },
      { text: '父轮收尾：在 src/util.ts。' },
      { as: 'explore', text: 'handle 在 src/util.ts:1（一行导出）。' },
    ])

    const events = await runTurn(app.id, 's1')

    // 1. 父轮正常收尾（子任务不会把父轮的台词吃掉）
    expect(await lastAssistantText(app.id)).toContain('父轮收尾')

    // 2. 工具调用在事件流里，参数带 role
    const started = events.find((event) => event.type === 'tool.start' && event.name === 'subagent')
    expect(started?.type).toBe('tool.start')
    if (started?.type === 'tool.start') expect(started.args?.['role']).toBe('explore')

    // 3. 工具结果里带回子会话的结论与它的工具集
    const results = await toolResults(app.id)
    const subagentResult = results.find((result) => result.toolName === 'subagent')
    expect(subagentResult?.isError).toBe(false)
    expect(subagentResult?.content?.map((part) => part.text ?? '').join('')).toContain(
      'handle 在 src/util.ts:1',
    )
    expect(subagentResult?.details?.role).toBe('explore')
    expect([...(subagentResult?.details?.tools ?? [])].sort()).toEqual(['glob', 'grep', 'ls', 'read'])

    // 4. 两个会话：根 + 一个任务所有的子会话
    const list = await conversations(app.id)
    expect(list).toHaveLength(2)
    expect(await childConversations(app.id)).toHaveLength(1)

    // 5. 一轮一 commit 的语义没被打破：子 Agent 只读 → 这一轮没有文件变化 → **不产生空提交**，
    //    仓库里仍然只有建应用那一个 commit
    const { commits } = await rpc<{ commits: unknown[] }>(running, 'git.log', { appId: app.id })
    expect(commits).toHaveLength(1)
  })

  it('子会话拿不到写工具，也拿不到 subagent 自己（递归派活从工具集上就断了）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '只读' })
    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'explore', task: '看一眼前端结构' } },
      { text: '好，我知道了。' },
      { as: 'explore', text: '前端在 src/ 下。' },
    ])
    await runTurn(app.id, 's2')

    const session = await running.agent.pool?.acquire(app.id)
    const child = (await childConversations(app.id))[0]
    expect(child).toBeDefined()
    const childConversation = await session?.harness.conversation(child!.id as never, agentContext)
    const agent = await childConversation?.agent(agentContext)
    const names = (agent?.tools ?? []).map((tool) => tool.name).sort()
    expect(names).toEqual(['glob', 'grep', 'ls', 'read'])
    expect(names).not.toContain('subagent')
    expect(names).not.toContain('write')

    // 子会话在同一个仓库里工作（不然它读不到应用代码），但指令是角色自己的
    expect(agent?.cwd?.endsWith('repo')).toBe(true)
    expect(agent?.instructions).toContain('Your job: locate code')
  })

  it('派活给 builder：参数校验就拦住（role 是字面量枚举），这一轮照样结束且不建子会话', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '不许递归' })
    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'builder', task: '再派给自己' } },
      { text: '派不了，我自己来。' },
    ])
    await runTurn(app.id, 's3')

    const results = await toolResults(app.id)
    const rejected = results.find((result) => result.toolName === 'subagent')
    // 拦在 schema 层（role 只有五个字面量）—— 比拦在执行里更早，模型看得到它错在哪
    expect(rejected?.isError).toBe(true)
    expect(rejected?.content?.map((part) => part.text ?? '').join('')).toContain('Validation failed')
    // 没有偷偷建子会话
    expect(await conversations(app.id)).toHaveLength(1)
    expect(await lastAssistantText(app.id)).toContain('我自己来')
  })

  /*
   * 这里以前有一条「还没接好的角色（codeact）回一句"还没接"」。M4 第 6 步把 codeact 接上之后，
   * 表里**一个 `planned` 都没有了**，这条集成就没入口了。
   * 分支本身留着（下一个角色会用到），文案改由 `roles.test.ts` 的 `plannedRejection` 单测钉住 ——
   * 比放在这里更稳：不用为了测一句话先造一个假角色。
   */

  it('同一轮派两次活 = 两个子会话（ownerTaskId 是工具调用的 task，不是根会话）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '派两次' })
    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'explore', task: '前端在哪' } },
      { tool: 'subagent', args: { role: 'librarian', task: '这个项目有什么约定' } },
      { text: '两个都问到了。' },
      { as: 'explore', text: '前端在 src/。' },
      { as: 'librarian', text: '约定见 AGENTS.md。' },
    ])
    await runTurn(app.id, 's5')

    const results = (await toolResults(app.id)).filter((result) => result.toolName === 'subagent')
    expect(results).toHaveLength(2)
    const ids = results.map((result) => result.details?.conversationId)
    expect(new Set(ids).size).toBe(2)
    expect(results.map((result) => result.details?.role)).toEqual(['explore', 'librarian'])
    // 根 + 两个子会话
    expect(await conversations(app.id)).toHaveLength(3)
    expect(await lastAssistantText(app.id)).toContain('两个都问到了')
  })

  it('子 Agent 的回答里带子会话编号（出了问题能顺着编号去查）', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '编号' })
    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'explore', task: '看一眼' } },
      { text: '收到。' },
      { as: 'explore', text: '看完了。' },
    ])
    await runTurn(app.id, 's6')

    const result = (await toolResults(app.id)).find((item) => item.toolName === 'subagent')
    const conversationId = result?.details?.conversationId ?? ''
    expect(conversationId).not.toBe('')
    expect(result?.content?.map((part) => part.text ?? '').join('')).toContain(`#${conversationId}`)
  })

  it('子 Agent 不动工作区：它做完之后仓库内容与建应用时一致', async () => {
    running = await boot()
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '只读不写' })
    const pkgBefore = await readFile(join(dir, 'apps', app.id, 'repo', 'package.json'), 'utf8')
    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'explore', task: '看 package.json' } },
      { text: '好。' },
      { as: 'explore', text: '是个 Vite 应用。' },
    ])
    await runTurn(app.id, 's7')

    const pkgAfter = await readFile(join(dir, 'apps', app.id, 'repo', 'package.json'), 'utf8')
    expect(pkgAfter).toBe(pkgBefore)
  })
})
