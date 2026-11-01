/**
 * 任务图归一化的单测。
 *
 * 数据全部照抄一次**真实派活**抓下来的图（spike 输出），不是手捏的理想形状 ——
 * 这样"会话树和任务树不是一个形状"这类坑才会被真的覆盖到。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeTaskGraph,
  stripKind,
  tasksNeedingRole,
  type RawTaskGraph,
  type RawTaskNode,
} from '../src/taskgraph.js'

function node(overrides: Partial<RawTaskNode> & Pick<RawTaskNode, 'id' | 'kind'>): RawTaskNode {
  return {
    conversationId: 1,
    background: false,
    state: { status: 'running', phase: 'request' },
    conversations: [],
    ...overrides,
  }
}

/** 派活那一刻真实抓到的三节点图：主对话生成 → 工具调用 → 子会话生成 */
function delegationGraph(): RawTaskGraph {
  return {
    tasks: {
      '9': node({
        id: 9,
        kind: 'pi.generation',
        state: { status: 'waiting', phase: 'tools', on: [12] },
      }),
      '12': node({
        id: 12,
        kind: 'pi.tool',
        owner: 9,
        state: { status: 'running', phase: 'execute' },
        conversations: [13],
      }),
      '21': node({
        id: 21,
        kind: 'pi.generation',
        conversationId: 13,
        state: { status: 'pending', phase: 'prepare' },
      }),
    },
  }
}

describe('normalizeTaskGraph', () => {
  it('把任务树与会话树接成一条链：工具 task 是子会话节点的父', () => {
    const graph = normalizeTaskGraph(delegationGraph(), { rootConversationId: '1' })
    expect(graph.nodes.map((item) => item.id)).toEqual(['9', '12', '21'])

    const tool = graph.nodes[1]
    expect(tool?.parentId).toBe('9')
    expect(tool?.spawned).toEqual(['13'])

    // ★ 子会话的 generation 在 pi 眼里没有 owner，但显示上要挂在工具 task 下面
    const child = graph.nodes[2]
    expect(child?.ownerId).toBeNull()
    expect(child?.parentId).toBe('12')
    expect(child?.conversationId).toBe('13')
    expect(child?.scope).toBe('delegated')
    expect(graph.nodes[0]?.scope).toBe('root')
  })

  it('角色从工具 task 继承给子会话；kind 去掉宿主前缀', () => {
    const graph = normalizeTaskGraph(delegationGraph(), {
      rootConversationId: '1',
      roles: { '12': 'explore' },
    })
    expect(graph.nodes.map((item) => item.role)).toEqual([null, 'explore', 'explore'])
    expect(graph.nodes.map((item) => item.kind)).toEqual(['generation', 'tool', 'generation'])
  })

  it('不认识的 kind 原样保留（宿主升级加了新任务类型也不该显示成空白）', () => {
    const graph = normalizeTaskGraph(
      { tasks: { '1': node({ id: 1, kind: 'pi.compaction' }) } },
      { rootConversationId: '1' },
    )
    expect(graph.nodes[0]?.kind).toBe('compaction')
    expect(stripKind('tenon.custom')).toBe('tenon.custom')
  })

  it('父节点一定排在子节点前面，同层按数值序（不是字典序）', () => {
    // 字典序下 '10' < '9'，这里必须按 9 → 10
    const graph = normalizeTaskGraph(
      {
        tasks: {
          '10': node({ id: 10, kind: 'pi.tool', owner: 9, state: { status: 'running', phase: 'call' } }),
          '9': node({ id: 9, kind: 'pi.generation', state: { status: 'waiting', phase: 'tools', on: [10] } }),
        },
      },
      { rootConversationId: '1' },
    )
    expect(graph.nodes.map((item) => item.id)).toEqual(['9', '10'])
  })

  it('静止之后是空数组 —— 这不是缺失实现', () => {
    const graph = normalizeTaskGraph({ tasks: {} }, { rootConversationId: '1' })
    expect(graph.nodes).toEqual([])
  })

  it('等待关系与阶段只有该状态下才有', () => {
    const graph = normalizeTaskGraph(
      {
        tasks: {
          '1': node({ id: 1, kind: 'pi.generation', state: { status: 'waiting', phase: 'tools', on: [2, 3] } }),
          '2': node({ id: 2, kind: 'pi.tool', owner: 1, state: { status: 'completing', outcome: 'done' } }),
          '3': node({ id: 3, kind: 'pi.tool', owner: 1, state: { status: 'sleeping', phase: 'backoff', on: [] } }),
        },
      },
      { rootConversationId: '1' },
    )
    expect(graph.nodes[0]?.waitingOn).toEqual(['2', '3'])
    const completing = graph.nodes.find((item) => item.id === '2')
    // completing 没有 phase，只有 outcome —— 面板显示"收尾"而不是硬塞一个阶段名
    expect(completing?.phase).toBeNull()
    expect(completing?.status).toBe('completing')
  })

  it('自己拥有自己的畸形节点不会让排序递归到栈溢出', () => {
    const graph = normalizeTaskGraph(
      { tasks: { '5': node({ id: 5, kind: 'pi.tool', owner: 5 }) } },
      { rootConversationId: '1' },
    )
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.parentId).toBeNull()
  })
})

describe('tasksNeedingRole', () => {
  it('只挑「工具 task 且已经拥有会话」的那些', () => {
    expect(tasksNeedingRole(delegationGraph())).toEqual(['12'])
  })

  it('还没建子会话的工具不需要查（查了也只有一半的 checkpoint）', () => {
    const graph: RawTaskGraph = {
      tasks: { '12': node({ id: 12, kind: 'pi.tool', owner: 9, state: { status: 'running', phase: 'call' } }) },
    }
    expect(tasksNeedingRole(graph)).toEqual([])
  })
})
