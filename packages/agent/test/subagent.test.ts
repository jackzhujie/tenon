/**
 * `subagent` 工具的守卫（不跑真 harness）。
 *
 * 集成测试里这些分支大多够不着 —— `role` 是字面量枚举，模型填错在 schema 层就被拒了。
 * 但工具自己的判断必须单独钉住：重放老输入、我们改了枚举、或者哪天换成 `Type.String` 时，
 * 这些提示是模型唯一能看到的线索。
 */
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { createSubagentTool } from '../src/tools/subagent.js'

const read: ToolRegistration = {
  name: 'read',
  description: 'read',
  parameters: { type: 'object' } as never,
  replay: 'safe',
  async execute() {
    return { output: [{ type: 'text' as const, text: '' }] }
  },
}

const call = async (
  args: Record<string, unknown>,
  options: { harness?: unknown; tools?: readonly ToolRegistration[] } = {},
): Promise<{ text: string; isError: boolean }> => {
  const tool = createSubagentTool({
    getHarness: () => options.harness as never,
    getTools: () => options.tools ?? [read],
  })
  const result = (await tool.execute(args as never, {} as never, {} as never)) as {
    output?: { type: string; text?: string }[]
    isError?: boolean
  }
  return {
    text: (result.output ?? []).map((part) => part.text ?? '').join(''),
    isError: result.isError === true,
  }
}

describe('subagent 守卫', () => {
  it('空 task 直接拒（子 Agent 拿到空问题只会瞎逛）', async () => {
    const result = await call({ role: 'explore', task: '   ' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('task')
  })

  it('builder / 未知角色一律拒，并列出可用角色', async () => {
    for (const role of ['builder', 'nobody']) {
      const result = await call({ role, task: '干活' })
      expect(result.isError, role).toBe(true)
      expect(result.text).toContain('No such role')
      expect(result.text).toContain('Explore')
    }
  })

  /*
   * 「没接好的角色说清楚缺什么」以前在这里用 codeact 当样例。M4 第 6 步把它接上之后表里一个
   * `planned` 都没有了 —— 这条分支改由 `roles.test.ts` 的 `plannedRejection` 单测钉住。
   */

  it('白名单过滤后一个工具都没有时报错，不去建空会话', async () => {
    const result = await call({ role: 'explore', task: '找工作' }, { tools: [] })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('has none of its tools registered')
  })

  it('harness 还没就绪时给可重试的提示，不抛异常', async () => {
    const result = await call({ role: 'explore', task: '找工作' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('is not ready yet')
  })
})
