/**
 * 预览工具（M4 第 4 步）。
 *
 * 用假 `PageDriver` 验**语义**，不起浏览器：
 * - 断言失败必须是"信息"而不是工具错误（否则模型会去重试工具，而它该回去改代码）；
 * - 参数错要在发命令**之前**就拦住（发出去也没人懂）；
 * - 没有页面时要说人话（"让用户点预览"），不能抛一个栈；
 * - 主角色拿不到这些工具（给了它就会绕过"改代码"去做"点页面"）。
 *
 * 真浏览器那条在 `scripts/e2e-e2e-agent.ts`。
 */
import { describe, expect, it } from 'vitest'
import { ROLES, toolsForRole } from '../src/roles.js'
import {
  createPreviewTools,
  previewExtension,
  type PageCommandName,
  type PageCommandResult,
  type PageDriver,
} from '../src/tools/preview.js'

interface Call {
  name: PageCommandName
  args: Record<string, unknown>
  timeoutMs?: number
}

function fakeDriver(reply: PageCommandResult = { ok: true }): { driver: PageDriver; calls: Call[] } {
  const calls: Call[] = []
  const driver: PageDriver = {
    info: { path: '/', title: '首页' },
    async run(name, args = {}, options = {}) {
      calls.push({ name, args, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
      return reply
    },
    async navigate(path) {
      calls.push({ name: 'navigate', args: { path } })
      return { path, title: '清单' }
    },
  }
  return { driver, calls }
}

function toolOf(name: string, driver: PageDriver | undefined): (args: unknown) => Promise<{
  isError?: boolean
  output: { type: string; text: string }[]
}> {
  const tools = createPreviewTools({ appId: 'app_1', getDriver: () => driver })
  const tool = tools.find((item) => item.name === name)
  if (tool === undefined) throw new Error(`没有这个工具：${name}`)
  return async (args: unknown) => (await tool.execute(args as never, {} as never, {} as never)) as never
}

const textOf = (result: { output: { text: string }[] }): string => result.output.map((item) => item.text).join('\n')

describe('预览工具', () => {
  it('五个工具都在，名字与角色白名单一致', () => {
    const names = createPreviewTools({ appId: 'app_1', getDriver: () => undefined }).map((tool) => tool.name)
    expect(names.sort()).toEqual(
      ['preview_assert', 'preview_click', 'preview_open', 'preview_read', 'preview_type'].sort(),
    )
    expect([...ROLES.e2e.tools].sort()).toEqual(names.sort())
  })

  it('没有预览时把话说清楚，不抛栈', async () => {
    const read = toolOf('preview_read', undefined)
    const result = await read({})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no preview running')
  })

  it('read 带回页面正文与页面自己的报错', async () => {
    const { driver } = fakeDriver({
      ok: true,
      value: { title: '报销单', path: '/', text: '合计 120 元' },
      errors: ['console.error: TypeError: x is undefined'],
    })
    const result = await toolOf('preview_read', driver)({})
    expect(textOf(result)).toContain('报销单')
    expect(textOf(result)).toContain('合计 120 元')
    expect(textOf(result)).toContain('TypeError')
  })

  it('★ 断言失败是"信息"，不是工具错误', async () => {
    const { driver } = await fakeDriver({
      ok: true,
      value: { pass: false, seen: { text: '提交中', contains: false } },
    })
    const result = await toolOf('preview_assert', driver)({ text: '提交' })
    // 关键：isError 不为 true —— 否则模型会重试工具，而它该回去改代码
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('✗')
    expect(textOf(result)).toContain('提交中')
    expect(textOf(result)).toContain('the tool itself worked')
  })

  it('断言通过时说清"验的是什么"', async () => {
    const { driver } = await fakeDriver({ ok: true, value: { pass: true, seen: { contains: true } } })
    const result = await toolOf('preview_assert', driver)({ text: '合计', timeoutMs: 500 })
    expect(textOf(result)).toContain('✓')
    expect(textOf(result)).toContain('contains the text "合计"')
  })

  it('参数不合法在发命令之前就拦住', async () => {
    const { driver, calls } = fakeDriver()
    const assert = toolOf('preview_assert', driver)
    for (const args of [{}, { value: 'x' }, { count: 2 }]) {
      const result = await assert(args)
      expect(result.isError).toBe(true)
    }
    expect(calls).toHaveLength(0)
  })

  it('断言的重试窗口会传给页面，命令超时比它宽', async () => {
    const { driver, calls } = fakeDriver({ ok: true, value: { pass: true, seen: {} } })
    await toolOf('preview_assert', driver)({ selector: '#total', timeoutMs: 9000 })
    expect(calls[0]?.args['timeoutMs']).toBe(9000)
    // 页面自己会重试到 9s，命令超时若等于 9s，我们会先掐线
    expect(calls[0]?.timeoutMs).toBeGreaterThan(9000)
  })

  it('超长的重试窗口会被夹到 15 秒（别让一次断言挂住一整轮）', async () => {
    const { driver, calls } = fakeDriver({ ok: true, value: { pass: true, seen: {} } })
    await toolOf('preview_assert', driver)({ text: 'x', timeoutMs: 600_000 })
    expect(calls[0]?.args['timeoutMs']).toBe(15_000)
  })

  it('点不到元素是工具错误（选择器写错了，得让模型知道）', async () => {
    const { driver } = fakeDriver({ ok: false, error: '没找到第 1 个「#buy」（一共 0 个）' })
    const result = await toolOf('preview_click', driver)({ selector: '#buy' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('没找到')
  })

  it('type 会把 submit 传下去，并回显当前值', async () => {
    const { driver, calls } = fakeDriver({ ok: true, value: { value: '120', typed: 'input「」' } })
    const result = await toolOf('preview_type', driver)({ selector: 'input', value: '120', submit: true })
    expect(calls[0]?.args).toMatchObject({ selector: 'input', value: '120', submit: true })
    expect(textOf(result)).toContain('it now holds "120"')
  })

  it('open 会补上开头的斜杠，并等到新页面报到', async () => {
    const { driver, calls } = fakeDriver()
    const result = await toolOf('preview_open', driver)({ path: 'items' })
    expect(calls[0]?.args['path']).toBe('/items')
    expect(textOf(result)).toContain('/items')
  })

  it('扩展只装工具，不带 section（否则主角色会看到 e2e 的说明却调不到工具）', () => {
    const extension = previewExtension({ appId: 'app_1', getDriver: () => undefined })
    expect(extension.sections ?? []).toHaveLength(0)
  })

  it('★ 主角色拿不到预览工具：要验页面就派活给 e2e', () => {
    const all = createPreviewTools({ appId: 'app_1', getDriver: () => undefined })
    const builderTools = toolsForRole(ROLES.builder, all)
    expect(builderTools).toHaveLength(0)
    const e2eTools = toolsForRole(ROLES.e2e, all)
    expect(e2eTools.map((tool) => tool.name).sort()).toEqual(all.map((tool) => tool.name).sort())
  })
})
