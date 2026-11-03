/**
 * 工具结果的回填 —— 两条"失败会变成假绿"的规则。
 *
 * 1. 工具**失败**时，消息里的那一条必须是 `error`。早先这里写死 `status: 'ok'`：
 *    路径越界、命令非零退出、组件装不上，在界面上与成功一模一样。
 *    这类"看起来都绿"的 bug 比直接报错危险得多 —— 用户不会去查，模型也会以为自己做成了。
 * 2. 工具**输出**要能看见。模型的下一步判断（"我写成功了吗"）就靠它；
 *    而工具结果原本被整条丢弃（只在注释里写着"挂在工具调用上渲染"，实际上从没挂）。
 *
 * 判定依据全在 pi 的 entry 上，不需要 harness。
 */
import { describe, expect, it } from 'vitest'
import { normalizeEntries, type RawEntry } from '../src/normalize.js'

/** 一条 assistant 消息，内容是若干块 */
function assistant(id: string, blocks: unknown[]): RawEntry {
  return { id, kind: 'pi.assistant', model: [{ role: 'assistant', content: blocks as never }] }
}

/** 一条工具结果 */
function toolResult(
  id: string,
  callId: string,
  text: string,
  options: { isError?: boolean } = {},
): RawEntry {
  return {
    id,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'tool',
        toolCallId: callId,
        toolName: 'write',
        isError: options.isError === true,
        content: [{ type: 'text', text }],
      } as never,
    ],
  }
}

describe('工具结果回填', () => {
  it('成功：状态 ok，输出能读到', () => {
    const messages = normalizeEntries([
      assistant('1', [{ type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'a.ts' } }]),
      toolResult('2', 'c1', 'Successfully wrote to a.ts'),
    ])
    const part = messages[0]?.parts[0]
    expect(part).toMatchObject({ type: 'tool', name: 'write', status: 'ok', output: 'Successfully wrote to a.ts' })
  })

  it('失败：状态是 error，而不是 ok', () => {
    const messages = normalizeEntries([
      assistant('1', [{ type: 'toolCall', id: 'c1', name: 'write', arguments: { path: '../x' } }]),
      toolResult('2', 'c1', '拒绝访问工作区之外的路径：../x', { isError: true }),
    ])
    expect(messages[0]?.parts[0]).toMatchObject({ status: 'error', output: '拒绝访问工作区之外的路径：../x' })
  })

  it('结果还没来（跑到一半）：保持 ok，不编一个 output', () => {
    const messages = normalizeEntries([
      assistant('1', [{ type: 'toolCall', id: 'c1', name: 'write', arguments: {} }]),
    ])
    const part = messages[0]?.parts[0] as { status: string; output?: string }
    expect(part.status).toBe('ok')
    expect(part.output).toBeUndefined()
  })

  it('一次消息里两个调用：各回各的，不串', () => {
    const messages = normalizeEntries([
      assistant('1', [
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } },
        { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'b' } },
      ]),
      toolResult('2', 'c1', 'A', { isError: true }),
      toolResult('3', 'c2', 'B'),
    ])
    const parts = messages[0]?.parts as { status: string; output?: string }[]
    expect(parts.map((part) => [part.status, part.output])).toEqual([
      ['error', 'A'],
      ['ok', 'B'],
    ])
  })

  it('工具结果本身不出气泡（它属于发起调用的那条消息）', () => {
    const messages = normalizeEntries([
      assistant('1', [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }]),
      toolResult('2', 'c1', 'done'),
    ])
    expect(messages).toHaveLength(1)
  })
})
