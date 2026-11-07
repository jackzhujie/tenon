/**
 * 跨消息合并的测试。
 *
 * 这组的由来是一次**真跑才发现**的错误：第一版在"一条消息的 parts 内部"做合并，
 * 而 pi 的历史是**每个工具调用一条 assistant 消息** —— 于是永远只看到 1 个工具，
 * 合并完全没发生，界面上那七八行一条没少。
 *
 * 所以用例直接照着真实历史形状写：连续的 `[tool]` 消息 + 一条 `[text]` 消息。
 */
import { describe, expect, it } from 'vitest'
import type { MessagePart, NormalizedMessage } from '@tenon/protocol'
import { groupMessages, isToolOnlyMessage } from '../src/lib/message-groups.js'

function message(id: string, parts: MessagePart[], role: NormalizedMessage['role'] = 'assistant'): NormalizedMessage {
  return { id, role, at: '2026-11-07T00:00:00.000Z', parts } as NormalizedMessage
}

function tool(toolCallId: string, name: string, args: Record<string, unknown>): MessagePart {
  return { type: 'tool', toolCallId, name, args, status: 'ok', output: '' }
}

const toActivity = (part: Extract<MessagePart, { type: 'tool' }>): { toolCallId: string; name: string } => ({
  toolCallId: part.toolCallId,
  name: part.name,
})

describe('isToolOnlyMessage', () => {
  it('纯工具消息是，带正文的不是', () => {
    expect(isToolOnlyMessage(message('a', [tool('1', 'bash', { command: 'ls' })]))).toBe(true)
    expect(isToolOnlyMessage(message('b', [tool('1', 'bash', { command: 'ls' }), { type: 'text', text: '好了' }]))).toBe(false)
    expect(isToolOnlyMessage(message('c', [{ type: 'text', text: '只有正文' }]))).toBe(false)
  })

  it('用户消息永远不算（那是轮的边界）', () => {
    expect(isToolOnlyMessage(message('u', [tool('1', 'bash', { command: 'ls' })], 'user'))).toBe(false)
  })

  it('空消息不算', () => {
    expect(isToolOnlyMessage(message('e', []))).toBe(false)
  })
})

describe('groupMessages', () => {
  it('连续三条纯工具消息并成一项（真实历史形状）', () => {
    const items = groupMessages(
      [
        message('m1', [tool('c1', 'bash', { command: 'ls -la' })]),
        message('m2', [tool('c2', 'read', { path: 'package.json' })]),
        message('m3', [tool('c3', 'bash', { command: 'cat src/App.tsx' })]),
        message('m4', [{ type: 'text', text: '排查结论…' }]),
      ],
      toActivity,
    )
    expect(items.map((item) => item.kind)).toEqual(['tools', 'message'])
    const tools = items[0]
    if (tools?.kind !== 'tools') throw new Error('没并起来')
    expect(tools.activities.map((activity) => activity.toolCallId)).toEqual(['c1', 'c2', 'c3'])
  })

  it('中间夹一条正文就断开（结论两边不该被并到一起）', () => {
    const items = groupMessages(
      [
        message('m1', [tool('c1', 'bash', { command: 'ls' })]),
        message('m2', [{ type: 'text', text: '先看看' }]),
        message('m3', [tool('c2', 'bash', { command: 'pwd' })]),
      ],
      toActivity,
    )
    expect(items.map((item) => item.kind)).toEqual(['tools', 'message', 'tools'])
  })

  it('用户消息断开两轮', () => {
    const items = groupMessages(
      [
        message('m1', [tool('c1', 'read', { path: 'a' })]),
        message('u1', [{ type: 'text', text: '继续' }], 'user'),
        message('m2', [tool('c2', 'read', { path: 'b' })]),
      ],
      toActivity,
    )
    expect(items.map((item) => item.kind)).toEqual(['tools', 'message', 'tools'])
  })

  it('一条消息里多个工具时也算进来（实时/未来形状都能吃）', () => {
    const items = groupMessages(
      [message('m1', [tool('c1', 'read', { path: 'a' }), tool('c2', 'read', { path: 'b' })])],
      toActivity,
    )
    expect(items).toHaveLength(1)
    const tools = items[0]
    if (tools?.kind !== 'tools') throw new Error('没并起来')
    expect(tools.activities).toHaveLength(2)
  })

  it('空列表不产出项', () => {
    expect(groupMessages([], toActivity)).toEqual([])
  })
})
