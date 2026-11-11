/**
 * 主子 Agent 层级整理的测试。
 *
 * 最要紧的两条都不是"能分组"，而是：
 * 1. **深度要在会话内部算** —— 直接用 `parentId` 算会让子会话第一层缩进两层
 * 2. **主对话的节点不能混进子会话的树** —— 混进去就会出现"Explore 下面挂着主对话"
 */
import { describe, expect, it } from 'vitest'
import { makeT } from '../src/lib/i18n.js'
import type { TaskGraph, TaskGraphNode } from '@tenon/protocol'
import { buildConversationTrees, rootActivity } from '../src/lib/task-tree.js'

function node(partial: Partial<TaskGraphNode> & Pick<TaskGraphNode, 'id' | 'conversationId' | 'scope'>): TaskGraphNode {
  return {
    kind: 'generation',
    ownerId: null,
    parentId: null,
    status: 'running',
    phase: null,
    waitingOn: [],
    spawned: [],
    role: null,
    ...partial,
  }
}

function graph(nodes: TaskGraphNode[], rootConversationId = '1'): TaskGraph {
  return { rootConversationId, nodes }
}

const zh = makeT('zh')

describe('子会话的树', () => {
  it('按会话分组：一个子会话一张卡片，主对话的节点不进来', () => {
    const trees = buildConversationTrees(
      graph([
        node({ id: 'a', conversationId: '1', scope: 'root', kind: 'generation' }),
        node({ id: 'b', conversationId: '1', scope: 'root', kind: 'tool', role: 'explore', spawned: ['7'] }),
        node({ id: 'c', conversationId: '7', scope: 'delegated', parentId: 'b', role: 'explore' }),
        node({ id: 'd', conversationId: '7', scope: 'delegated', kind: 'tool', parentId: 'c', role: 'explore' }),
        node({ id: 'e', conversationId: '9', scope: 'delegated', role: 'librarian' }),
      ]),
    )
    expect(trees.map((tree) => tree.conversationId)).toEqual(['7', '9'])
    expect(trees[0]?.role).toBe('explore')
    expect(trees[0]?.rows.map((row) => row.node.id)).toEqual(['c', 'd'])
    expect(trees[1]?.role).toBe('librarian')
  })

  it('深度在会话内部重算：父节点在别的会话时不算一层', () => {
    const trees = buildConversationTrees(
      graph([
        node({ id: 'tool', conversationId: '1', scope: 'root', kind: 'tool', spawned: ['7'] }),
        // 子会话的第一层：父是父会话里的工具任务 → depth 必须是 0
        node({ id: 'gen', conversationId: '7', scope: 'delegated', parentId: 'tool' }),
        // 子会话里的工具调用：父在同一会话 → depth 1
        node({ id: 'step', conversationId: '7', scope: 'delegated', kind: 'tool', parentId: 'gen' }),
      ]),
    )
    expect(trees[0]?.rows.map((row) => row.depth)).toEqual([0, 1])
  })

  it('环不致命（畸形数据不该让界面白屏）', () => {
    const trees = buildConversationTrees(
      graph([
        node({ id: 'x', conversationId: '7', scope: 'delegated', parentId: 'y' }),
        node({ id: 'y', conversationId: '7', scope: 'delegated', parentId: 'x' }),
      ]),
    )
    expect(trees[0]?.rows).toHaveLength(2)
    expect(trees[0]?.rows.every((row) => Number.isFinite(row.depth))).toBe(true)
  })

  it('active：还有节点在排队/运行/等重试就是 true；全收尾了是 false', () => {
    const running = buildConversationTrees(
      graph([node({ id: 'a', conversationId: '7', scope: 'delegated', status: 'waiting' })]),
    )
    expect(running[0]?.active).toBe(true)

    const done = buildConversationTrees(
      graph([node({ id: 'a', conversationId: '7', scope: 'delegated', status: 'completing' })]),
    )
    expect(done[0]?.active).toBe(false)
  })

  it('空图 / 只有主对话 → 没有树（不该渲染空卡片）', () => {
    expect(buildConversationTrees(null)).toEqual([])
    expect(buildConversationTrees(graph([]))).toEqual([])
    expect(
      buildConversationTrees(graph([node({ id: 'a', conversationId: '1', scope: 'root' })])),
    ).toEqual([])
  })
})

describe('主对话活动', () => {
  it('把 pi 的 phase 说成人话', () => {
    expect(
      rootActivity(
        graph([node({ id: 'a', conversationId: '1', scope: 'root', phase: 'request' })]),
        zh,
      ),
    ).toBe('等模型回复')
    expect(
      rootActivity(
        graph([node({ id: 'a', conversationId: '1', scope: 'root', phase: 'tools' })]),
        zh,
      ),
    ).toBe('还在串工具')
  })

  it('没在跑就返回 null（不要一句常驻的废话）', () => {
    expect(rootActivity(graph([]), zh)).toBeNull()
    expect(
      rootActivity(
        graph([node({ id: 'a', conversationId: '1', scope: 'root', status: 'completing' })]),
        zh,
      ),
    ).toBeNull()
  })

  it('不认识的新 phase 不显示（别把宿主枚举抛给用户）', () => {
    expect(
      rootActivity(
        graph([node({ id: 'a', conversationId: '1', scope: 'root', phase: 'future-phase' })]),
        zh,
      ),
    ).toBeNull()
  })
})
