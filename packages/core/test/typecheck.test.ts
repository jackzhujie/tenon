import { describe, expect, it } from 'vitest'
import { formatTscReport, parseTscOutput } from '../src/index.js'

/**
 * `tsc --pretty false` 的真实输出形状。这些用例盯的不是"正则写没写对"，
 * 而是**别把真错误吞掉、别把没跑成报成通过** —— 评审里假绿比红更贵。
 */
describe('tsc 输出解析（Reviewer 用）', () => {
  it('解析出文件、行列、错误码与消息', () => {
    const result = parseTscOutput(
      "src/App.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    )
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toEqual({
      file: 'src/App.tsx',
      line: 12,
      column: 5,
      code: 'TS2322',
      message: "Type 'string' is not assignable to type 'number'.",
    })
    expect(result.other).toEqual([])
  })

  it('多条错误按出现顺序全留下，不合并', () => {
    const result = parseTscOutput(
      [
        'src/a.ts(1,1): error TS2304: Cannot find name "x".',
        "src/b.ts(7,3): error TS2554: Expected 2 arguments, but got 1.",
        'api/main.ts(3,10): error TS7006: Parameter "e" implicitly has an "any" type.',
      ].join('\n'),
    )
    expect(result.diagnostics.map((item) => item.code)).toEqual(['TS2304', 'TS2554', 'TS7006'])
  })

  it('缩进的续行并进上一条，不单独成条', () => {
    const result = parseTscOutput(
      'src/App.tsx(3,1): error TS2345: Argument of type \'{ a: string; }\' is not assignable.\n' +
        '  Types of property \'a\' are incompatible.',
    )
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.message).toContain("Types of property 'a' are incompatible")
  })

  it('没有文件位置的报错进 other（例如 tsconfig 写错）—— 它是"没跑成"，不是"没问题"', () => {
    const result = parseTscOutput('error TS5023: Unknown compiler option \'strictNullCheck\'.')
    expect(result.diagnostics).toEqual([])
    expect(result.other).toEqual(["error TS5023: Unknown compiler option 'strictNullCheck'."])
  })

  it('stderr 里的内容也一起解析（tsc 偶尔把致命错误写到 stderr）', () => {
    const result = parseTscOutput('', "src/x.ts(1,1): error TS1005: ';' expected.")
    expect(result.diagnostics).toHaveLength(1)
  })

  it('空输出 = 没有诊断（通过与否由退出码决定，不由这里决定）', () => {
    const result = parseTscOutput('')
    expect(result.diagnostics).toEqual([])
    expect(result.other).toEqual([])
  })
})

describe('tsc 摘要文案', () => {
  it('通过时一句话，且 ok 只由调用方给的那个布尔决定', () => {
    const report = formatTscReport({ diagnostics: [], other: [] }, true, {
      config: 'tsconfig.json',
      elapsedMs: 3200,
    })
    expect(report.ok).toBe(true)
    expect(report.text).toBe('✓ Typecheck passed (tsconfig.json, 3.2s)')
  })

  it('失败时带文件行列与错误码，最多 12 条', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      file: 'src/a.ts',
      line: index + 1,
      column: 1,
      code: 'TS2322',
      message: 'bad',
    }))
    const report = formatTscReport({ diagnostics: many, other: [] }, false, { elapsedMs: 1500 })
    expect(report.ok).toBe(false)
    expect(report.errorCount).toBe(20)
    expect(report.text).toContain('✗ Typecheck failed: 20 errors')
    expect(report.text).toContain('src/a.ts:1:1  TS2322  bad')
    expect(report.text).toContain('8 more not listed')
  })

  it('★ 没有诊断但退出码非 0：报"没跑成"，绝不报通过', () => {
    const report = formatTscReport({ diagnostics: [], other: ['error TS5023: 配置有问题'] }, false, {
      exitCode: 1,
    })
    expect(report.ok).toBe(false)
    expect(report.text).toContain('did not run')
    expect(report.text).toContain('error TS5023')
    expect(report.text).not.toContain('✓')
  })

  it('被超时杀掉（exitCode 为 undefined）也要说出来', () => {
    const report = formatTscReport({ diagnostics: [], other: [] }, false, {})
    expect(report.text).toContain('timeout/killed')
  })
})
