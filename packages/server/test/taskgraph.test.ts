/**
 * 任务图（M4 第 2 步）：派活的时候，界面上看得见"现在有几个任务在跑、跑在哪"。
 *
 * 断言落在两处：
 * - **事件流**：一次派活应该推出十几帧，其中必须有 `scope: 'delegated'` 的节点 ——
 *   那是"子会话真的在跑"的唯一直接证据（不看 tool 卡片，那只是父轮的一次调用）
 * - **静止即空**：跑完再查是空数组。这条是刻意固化的认知，防止有人拿它当派活历史
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SseEvent, TaskGraph } from '@tenon/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { boot as bootServer, openSse, rpc } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-taskgraph-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

/** 派活的剧本：父轮一次工具调用 + 收尾，子轮一句结论（按角色分道） */
function delegationScript(server: RunningServer): void {
  server.agent.model?.script([
    { tool: 'subagent', args: { role: 'explore', task: 'handle 定义在哪' } },
    { text: '父轮收尾。' },
    { as: 'explore', text: '在 src/util.ts:1' },
  ])
}

async function runTurn(appId: string, requestId: string): Promise<SseEvent[]> {
  const server = running as RunningServer
  const sse = openSse(server, appId)
  await sse.connected
  await rpc(server, 'chat.submit', { appId, content: '查一下', requestId })
  await sse.waitFor((events) => events.some((event) => event.type === 'app.status' && event.status === 'idle'))
  sse.close()
  return sse.events
}

function frames(events: readonly SseEvent[]): TaskGraph[] {
  return events.flatMap((event) => (event.type === 'taskgraph.update' ? [event.graph] : []))
}

describe('taskgraph', () => {
  it('空应用返回空图，但根会话 id 是真的（前端靠它区分主对话与子会话）', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '图' })
    const { graph } = await rpc<{ graph: TaskGraph }>(running, 'taskgraph.get', { appId: app.id })
    expect(graph.nodes).toEqual([])
    expect(graph.rootConversationId).not.toBe('')
  })

  it('派活时图里出现子会话节点：role=explore，挂在那个 subagent 工具 task 下面', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '派活' })
    delegationScript(running)

    const events = await runTurn(app.id, 't1')
    const all = frames(events)

    // 一次派活十几帧：少了说明 watch 挂晚了或事件没接上
    expect(all.length).toBeGreaterThan(3)

    const withDelegated = all.filter((graph) => graph.nodes.some((node) => node.scope === 'delegated'))
    expect(withDelegated.length).toBeGreaterThan(0)

    const flat = withDelegated.flatMap((graph) => graph.nodes)
    const child = flat.find((node) => node.scope === 'delegated' && node.kind === 'generation')
    expect(child).toBeDefined()
    // ★ 角色不是图里自带的：从工具 task 的 checkpoint.arguments 读出来再继承下去
    expect(child?.role).toBe('explore')

    const tool = flat.find((node) => node.kind === 'tool')
    expect(tool?.spawned).toContain(child?.conversationId)
    // 会话树接进任务树：子会话节点显示上挂在那个工具 task 下面
    expect(child?.parentId).toBe(tool?.id)
    // 主对话的 task 是 root，子会话的不是
    expect(flat.some((node) => node.scope === 'root')).toBe(true)
  })

  it('跑完就空了 —— 节点被回收，别拿它当派活历史', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '跑完就空' })
    delegationScript(running)

    const events = await runTurn(app.id, 't2')
    // 最后一帧必须是空图：面板据此收起自己
    const last = frames(events).at(-1)
    expect(last?.nodes).toEqual([])

    const { graph } = await rpc<{ graph: TaskGraph }>(running, 'taskgraph.get', { appId: app.id })
    expect(graph.nodes).toEqual([])
  })

  it('没有派活的一轮也有帧：主对话自己在跑也算任务', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '单任务' })
    running.agent.model?.script([{ text: '就一句话。' }])
    const events = await runTurn(app.id, 't3')

    const all = frames(events)
    expect(all.length).toBeGreaterThan(0)
    // 至少一帧里有一个 root 的 generation 节点，且没有 delegated
    expect(all.some((graph) => graph.nodes.some((node) => node.kind === 'generation' && node.scope === 'root'))).toBe(
      true,
    )
    expect(all.every((graph) => graph.nodes.every((node) => node.scope === 'root'))).toBe(true)
  })
})
