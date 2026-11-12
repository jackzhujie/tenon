/**
 * 脚本头的上限（M4 第 6 步的缺口，M6 收口后补）。
 *
 * 要守的是一件很朴素的事：**我们说"一次脚本最多跑 60 秒"就得真是 60 秒。**
 * 上游语义是 `timeoutMs: options.timeoutMs ?? this.timeoutMs` —— 脚本自己写在第一行的
 * `// @options: {"timeout_ms": …}` 会**覆盖**我们设的值。不夹的话上限只是一句注释，
 * 而后果不是"慢"，是派活的主角色一直等在这条调用上、界面看起来卡死。
 *
 * 用例分两层：
 * 1. `checkScriptOptions` 是纯函数（快，覆盖各种边界）
 * 2. 守卫**真的挂在工具入口**（否则函数写对了没人调用，等于没写）
 */
import { describe, expect, it } from 'vitest'
import {
  checkScriptOptions,
  codeactExtension,
  CODEACT_TOOL,
  DEFAULT_SCRIPT_LIMITS,
  withScriptLimits,
} from '../src/tools/codeact.js'

/** 从工具结果里取第一段文本（形状同 `ToolExecutionResult.output`） */
function textOf(result: unknown): string {
  const output = (result as { output?: { type: string; text?: string }[] }).output ?? []
  return output.map((part) => part.text ?? '').join('')
}

describe('checkScriptOptions', () => {
  it('没有 @options 的脚本放行（绝大多数脚本都不写它）', () => {
    expect(checkScriptOptions('const x = await tools.read({ path: "a" })\ntext(x)')).toBeNull()
  })

  it('在上限内的超时放行（批量任务确实需要多跑一会儿）', () => {
    expect(checkScriptOptions('// @options: {"timeout_ms": 120000}\ntext(1)')).toBeNull()
  })

  it('超过上限就拒，并说清上限是多少（不是静默改成上限）', () => {
    const refusal = checkScriptOptions('// @options: {"timeout_ms": 3600000}\ntext(1)')
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('3600000')
    expect(refusal).toContain(String(DEFAULT_SCRIPT_LIMITS.maxTimeoutMs))
    // 拒绝的话要给出路，否则模型只会重试同一个脚本
    expect(refusal).toContain('Split the work')
  })

  it('输出预算也夹：那是唯一回到父会话上下文的东西', () => {
    const refusal = checkScriptOptions('// @options: {"max_output_tokens": 100000}\ntext(1)')
    expect(refusal).not.toBeNull()
    expect(refusal).toContain(String(DEFAULT_SCRIPT_LIMITS.maxOutputTokens))
    // 合理的输出预算放行
    expect(checkScriptOptions('// @options: {"max_output_tokens": 2000}\ntext(1)')).toBeNull()
  })

  it('语法坏的脚本不在这里报（交上游报，它的消息更准）', () => {
    expect(checkScriptOptions('// @options: {oops}\ntext(1)')).toBeNull()
    // 不支持的字段同样交给上游：我们只判"合法但过分"
    expect(checkScriptOptions('// @options: {"foo": 1}\ntext(1)')).toBeNull()
  })

  it('上限可以按调用方收紧（这是纯函数，测试不必起沙箱）', () => {
    expect(
      checkScriptOptions('// @options: {"timeout_ms": 2000}\ntext(1)', { maxTimeoutMs: 1000, maxOutputTokens: 100 }),
    ).toContain('1000')
  })

  it('@options 空对象 = 用默认值，不算越界', () => {
    expect(checkScriptOptions('// @options: {}\ntext(1)')).toBeNull()
  })
})

describe('守卫挂在工具入口上', () => {
  it('越界脚本被拒，而且**原 execute 一次都没被调用**（不是先跑再拒）', async () => {
    const calls: string[] = []
    const fake = {
      name: CODEACT_TOOL,
      description: '假的 codemode',
      parameters: {},
      execute: async (args: { code: string }) => {
        calls.push(args.code)
        return { output: [{ type: 'text', text: 'ran' }] }
      },
    } as unknown as Parameters<typeof withScriptLimits>[0]

    const guarded = withScriptLimits(fake, DEFAULT_SCRIPT_LIMITS)
    const refused = (await guarded.execute(
      { code: '// @options: {"timeout_ms": 7200000}\ntext(1)' } as never,
      {} as never,
      {} as never,
    )) as { isError?: boolean }
    expect(refused.isError).toBe(true)
    expect(calls).toEqual([])

    // 正常脚本原样转发，结果也就是原工具的结果
    const passed = await guarded.execute({ code: 'text(1 + 1)' } as never, {} as never, {} as never)
    expect(calls).toEqual(['text(1 + 1)'])
    expect(textOf(passed)).toBe('ran')
  })

  it('扩展里的工具与返回给调用方的工具是同一批（不会有一边没守卫）', () => {
    const codeact = codeactExtension()
    const fromExtension = codeact.extension.tools?.find((item) => item.name === CODEACT_TOOL)
    const fromList = codeact.tools.find((item) => item.name === CODEACT_TOOL)
    expect(fromExtension).toBe(fromList)
    expect(fromExtension).toBeDefined()
    void codeact.close()
  })

  it('`codemode` 工具在扩展里只出现一次（别把守卫和原工具都注册进去）', () => {
    const codeact = codeactExtension()
    const same = (codeact.extension.tools ?? []).filter((item) => item.name === CODEACT_TOOL)
    expect(same).toHaveLength(1)
    void codeact.close()
  })
})
