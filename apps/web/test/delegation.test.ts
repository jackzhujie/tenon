/**
 * 派活卡片与子会话步骤树的配对（v1.2.29）。
 *
 * 这几个用例都来自真实场景：并行派两个同角色子 Agent、跑完卡片带 id 但树已被回收、
 * 历史截断导致树找不到卡片。配对错了不会崩，但会让用户看到"步骤挂错了人"。
 */
import { describe, expect, it } from 'vitest'
import { planDelegations, type DelegationSource } from '../src/lib/delegation.js'
import type { ConversationTree } from '../src/lib/task-tree.js'

function tree(conversationId: string, role: string | null): ConversationTree {
  return { conversationId, role, rows: [], active: true }
}

function card(over: Partial<DelegationSource> & { toolCallId: string }): DelegationSource {
  return {
    name: 'subagent',
    args: { role: 'explore', task: '找入口' },
    status: 'running',
    ...over,
  }
}

describe('派活配对', () => {
  it('落定后按 childConversationId 精确配（这是唯一不会错的依据）', () => {
    const plan = planDelegations(
      [card({ toolCallId: 'c1', status: 'ok', childConversationId: '2654' })],
      [tree('2654', 'explore')],
    )
    expect(plan.byToolCall.get('c1')?.conversationId).toBe('2654')
    expect(plan.orphans).toHaveLength(0)
  })

  it('运行中的卡片：按角色认领剩下的树（同时派同角色时按先后）', () => {
    const plan = planDelegations(
      [card({ toolCallId: 'c1', args: { role: 'explore', task: 'a' } }), card({ toolCallId: 'c2', args: { role: 'explore', task: 'b' } })],
      [tree('1', 'explore'), tree('2', 'explore')],
    )
    expect(plan.byToolCall.get('c1')?.conversationId).toBe('1')
    expect(plan.byToolCall.get('c2')?.conversationId).toBe('2')
  })

  it('角色不同时不会串（这是加 role 约束的理由）', () => {
    // 树是 librarian 先出现，但卡片是先 explore 后 librarian
    const plan = planDelegations(
      [card({ toolCallId: 'c1', args: { role: 'explore', task: 'a' } }), card({ toolCallId: 'c2', args: { role: 'librarian', task: 'b' } })],
      [tree('7', 'librarian'), tree('8', 'explore')],
    )
    expect(plan.byToolCall.get('c1')?.conversationId).toBe('8')
    expect(plan.byToolCall.get('c2')?.conversationId).toBe('7')
  })

  it('树里查不到角色（role 为 null）时仍然能配 —— 宁可挂错也不该不显示', () => {
    const plan = planDelegations([card({ toolCallId: 'c1' })], [tree('3', null)])
    expect(plan.byToolCall.get('c1')?.conversationId).toBe('3')
  })

  it('★ 配不上的树是孤儿，必须返回而不是丢掉', () => {
    // 历史截断：卡片没了，树还在
    const plan = planDelegations([], [tree('9', 'explore')])
    expect(plan.orphans.map((item) => item.conversationId)).toEqual(['9'])
  })

  it('卡片没带 id、树也没有（跑完已被回收）：不产生任何配对，也不报错', () => {
    const plan = planDelegations([card({ toolCallId: 'c1', status: 'ok' })], [])
    expect(plan.byToolCall.size).toBe(0)
    expect(plan.orphans).toHaveLength(0)
  })

  it('已完成但没 id 的卡片不参与角色配对（那是历史数据缺字段，不该抢别人的树）', () => {
    const plan = planDelegations([card({ toolCallId: 'c1', status: 'ok' })], [tree('4', 'explore')])
    expect(plan.byToolCall.size).toBe(0)
    expect(plan.orphans).toHaveLength(1)
  })

  it('其它工具不参与配对（只有 subagent 有子会话）', () => {
    const plan = planDelegations([card({ toolCallId: 'c1', name: 'bash', status: 'running' })], [tree('5', 'explore')])
    expect(plan.byToolCall.size).toBe(0)
    expect(plan.orphans).toHaveLength(1)
  })
})
