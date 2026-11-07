/**
 * 日志 → 提示词的拼装（`lib/log-prompt.ts`）。
 *
 * 这些断言看着琐碎，但每一条都对应一个真实的"发过去也没用"：
 * 没有上下文、上下文串到目标之后、堆栈把输入框撑爆、重复次数没写。
 */
import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@tenon/protocol'
import { buildLogPrompt } from '../src/lib/log-prompt.js'

let seq = 0
function entry(patch: Partial<LogEntry> & Pick<LogEntry, 'message'>): LogEntry {
  seq += 1
  return {
    id: `log_${seq}`,
    appId: 'app_1',
    // 固定时间：断言里不该出现随机器时区变化的东西，所以只比"存在"的部分
    at: new Date(2026, 10, 7, 10, 12, 3).getTime(),
    source: 'vite',
    level: 'info',
    detail: null,
    repeat: 1,
    ...patch,
  }
}

describe('buildLogPrompt', () => {
  it('目标行写清级别 / 来源 / 时间 / 正文', () => {
    const target = entry({
      level: 'error',
      source: 'api',
      message: 'Failed to load url /src/db.ts',
    })
    const text = buildLogPrompt([target], target)
    expect(text).toContain('[error] 后端 10:12:03  Failed to load url /src/db.ts')
    expect(text).toContain('先读相关代码再改')
    expect(text).toContain('改完告诉我：改了哪个文件')
  })

  it('有 detail 就放进代码块（Agent 才看得到真实堆栈）', () => {
    const target = entry({ level: 'error', message: 'TypeError', detail: 'at foo (src/a.ts:3:1)' })
    const text = buildLogPrompt([target], target)
    expect(text).toContain('```')
    expect(text).toContain('at foo (src/a.ts:3:1)')
  })

  it('没有 detail 就不出现空代码块', () => {
    const target = entry({ level: 'error', message: '没堆栈' })
    expect(buildLogPrompt([target], target)).not.toContain('```')
  })

  it('★ 带的是**目标之前**的几行，不能把之后的日志也串进来', () => {
    const before = [entry({ message: '第一行' }), entry({ message: '第二行' })]
    const target = entry({ level: 'error', message: '炸了' })
    const after = entry({ message: '之后才出现的' })
    const text = buildLogPrompt([...before, target, after], target)
    expect(text).toContain('第一行')
    expect(text).toContain('第二行')
    expect(text).not.toContain('之后才出现的')
  })

  it('上下文只取最近 N 行（默认 4），更早的不塞', () => {
    const olds = [1, 2, 3, 4, 5, 6].map((n) => entry({ message: `旧日志${n}` }))
    const target = entry({ level: 'error', message: '炸了' })
    const text = buildLogPrompt([...olds, target], target)
    expect(text).not.toContain('旧日志1')
    expect(text).not.toContain('旧日志2')
    expect(text).toContain('旧日志3')
    expect(text).toContain('旧日志6')
  })

  it('重复多次要说出来（否则 Agent 以为是偶发）', () => {
    const target = entry({ level: 'error', message: '同一个错', repeat: 12 })
    expect(buildLogPrompt([target], target)).toContain('（重复 12 次）')
  })

  it('超长堆栈截断并标注', () => {
    const target = entry({ level: 'error', message: '长', detail: 'x'.repeat(5000) })
    const text = buildLogPrompt([target], target)
    expect(text).toContain('…（截断）')
    expect(text.length).toBeLessThan(4000)
  })

  it('目标不在列表里也不炸（面板刚清空时的竞态）', () => {
    const target = entry({ level: 'error', message: '孤儿日志' })
    const text = buildLogPrompt([], target)
    expect(text).toContain('孤儿日志')
    expect(text).not.toContain('前面几行日志')
  })
})
