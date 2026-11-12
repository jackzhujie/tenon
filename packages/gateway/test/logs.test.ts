/**
 * 日志缓冲的测试。
 *
 * 这里验的四件事都在"出错时才暴露"的那一侧：
 *
 * 1. **去重**：不同步合并的话，一个无限重渲染的应用能在两秒内推几千条上来，
 *    面板与 SSE 一起垮。合并之后界面上是 `×N`，不是 N 行。
 * 2. **ANSI 剥离**：Vite 的输出带颜色，原样进界面就是 `[2m` 这类垃圾；用户复制去搜也搜不到。
 * 3. **容量上限按应用算**：全局一个上限时，一个刷屏的应用会把别的应用的日志挤掉。
 * 4. **外部输入要防御性解析**：上报体来自生成应用的源码，可能是坏的。
 */
import { describe, expect, it } from 'vitest'
import { classifyLine, isStackLine, LogStore, parseClientLog, stripAnsi } from '../src/logs.js'

const APP_ID = 'app_logs_test'

describe('stripAnsi', () => {
  it('去掉颜色与光标控制序列（Vite 的输出来源）', () => {
    expect(stripAnsi('\u001B[32m✓ built in 120ms\u001B[39m')).toBe('✓ built in 120ms')
    // 一行里多个序列、且和正文交错：Vite 的 `[vite] xxx` 前缀就是这样
    expect(stripAnsi('\u001B[2m[\u001B[32mvite\u001B[39m]\u001B[22m ready')).toBe('[vite] ready')
  })

  it('普通的方括号文本不受影响', () => {
    expect(stripAnsi('[vite] connecting...')).toBe('[vite] connecting...')
  })
})

describe('classifyLine', () => {
  it('强信号优先：stdout 里的 error 也算 error', () => {
    expect(classifyLine('Error: Cannot find module "x"', 'stdout')).toBe('error')
    expect(classifyLine('✘ [ERROR] Expected ";"', 'stdout')).toBe('error')
    expect(classifyLine('Uncaught exception in worker', 'stdout')).toBe('error')
  })

  it('warn 认得出常见写法', () => {
    expect(classifyLine('warning: something deprecated', 'stdout')).toBe('warn')
    expect(classifyLine('[warn] port in use', 'stderr')).toBe('warn')
  })

  it('没有强信号时按流兜底：stderr 记 error（Vite 把正经提示也写 stderr，但宁可偏高）', () => {
    expect(classifyLine('正在启动…', 'stderr')).toBe('error')
    expect(classifyLine('VITE v7.3.7 ready in 312 ms', 'stdout')).toBe('info')
  })
})

describe('LogStore', () => {
  it('同一句在窗口内合并成一条，id 不变、repeat++', () => {
    const store = new LogStore()
    const first = store.add(APP_ID, { source: 'web', level: 'error', message: 'x is not a function' }, 1000)
    const second = store.add(APP_ID, { source: 'web', level: 'error', message: 'x is not a function' }, 1300)

    expect(second.id).toBe(first.id)
    expect(second.repeat).toBe(2)
    expect(store.list(APP_ID)).toHaveLength(1)
    // 时间戳留在第一次发生的那一刻：合并后位置不该跳来跳去
    expect(store.list(APP_ID)[0]?.at).toBe(1000)
  })

  it('超出窗口 / 换了来源 / 换了级别都算新条目', () => {
    const store = new LogStore()
    store.add(APP_ID, { source: 'web', level: 'error', message: 'same' }, 1000)
    store.add(APP_ID, { source: 'web', level: 'error', message: 'same' }, 5000)
    store.add(APP_ID, { source: 'api', level: 'error', message: 'same' }, 5100)
    store.add(APP_ID, { source: 'api', level: 'warn', message: 'same' }, 5200)

    expect(store.list(APP_ID)).toHaveLength(4)
  })

  it('容量上限按应用算，挤掉的是最老的', () => {
    const store = new LogStore(3)
    for (let index = 0; index < 5; index += 1) {
      store.add(APP_ID, { source: 'vite', level: 'info', message: `line ${index}` }, 1000 + index * 2000)
    }
    const entries = store.list(APP_ID)
    expect(entries.map((entry) => entry.message)).toEqual(['line 2', 'line 3', 'line 4'])

    // 另一个应用完全不受影响
    store.add('other', { source: 'vite', level: 'info', message: '别人的日志' }, 20_000)
    expect(store.list(APP_ID)).toHaveLength(3)
    expect(store.list('other')).toHaveLength(1)
  })

  it('list 支持来源与级别过滤，limit 从最新往回数', () => {
    const store = new LogStore()
    store.add(APP_ID, { source: 'vite', level: 'info', message: 'a' }, 1000)
    store.add(APP_ID, { source: 'web', level: 'error', message: 'b' }, 5000)
    store.add(APP_ID, { source: 'api', level: 'warn', message: 'c' }, 9000)

    expect(store.list(APP_ID, { sources: ['web'] }).map((entry) => entry.message)).toEqual(['b'])
    expect(store.list(APP_ID, { minLevel: 'warn' }).map((entry) => entry.message)).toEqual(['b', 'c'])
    expect(store.list(APP_ID, { limit: 2 }).map((entry) => entry.message)).toEqual(['b', 'c'])
  })

  it('clear 报出清掉了多少条；drop 连键一起丢掉', () => {
    const store = new LogStore()
    store.add(APP_ID, { source: 'tenon', level: 'info', message: 'a' }, 1000)
    store.add(APP_ID, { source: 'tenon', level: 'info', message: 'b' }, 5000)

    expect(store.clear(APP_ID)).toBe(2)
    expect(store.list(APP_ID)).toEqual([])

    store.add(APP_ID, { source: 'tenon', level: 'info', message: 'c' }, 9000)
    store.drop(APP_ID)
    expect(store.snapshot()).toEqual({})
  })

  it('写进缓冲的正文已经剥过 ANSI、且超长会截断', () => {
    const store = new LogStore()
    const entry = store.add(APP_ID, {
      source: 'vite',
      level: 'info',
      message: '\u001B[31m红字\u001B[39m',
    })
    expect(entry.message).toBe('红字')

    const long = store.add(APP_ID, { source: 'vite', level: 'info', message: 'x'.repeat(5000) }, 9999)
    expect(long.message.length).toBeLessThan(2100)
    expect(long.message).toContain('truncated')
  })
})

describe('parseClientLog', () => {
  it('正常体原样收下，缺省补 web/error', () => {
    expect(parseClientLog({ message: 'boom' })).toEqual({
      source: 'web',
      level: 'error',
      message: 'boom',
      detail: null,
    })
  })

  it('不认识的值退回缺省，而不是整条丢掉', () => {
    const parsed = parseClientLog({ message: 'x', source: 'hacker', level: 'fatal' })
    expect(parsed).toMatchObject({ source: 'web', level: 'error' })
  })

  it('没有 message / 不是对象 → null（上报通道坏了不能反过来影响应用）', () => {
    expect(parseClientLog(null)).toBeNull()
    expect(parseClientLog('字符串')).toBeNull()
    expect(parseClientLog({})).toBeNull()
    expect(parseClientLog({ message: '   ' })).toBeNull()
  })

  it('detail 是对象时序列化成字符串，界面才好显示', () => {
    const parsed = parseClientLog({ message: 'x', detail: { a: 1 } })
    expect(parsed?.detail).toBe('{"a":1}')
  })
})

describe('addLine：堆栈续行并进上一条', () => {
  it('isStackLine 只认带缩进的 at 行（去 trim 后就认不出来了）', () => {
    expect(isStackLine('    at ItemsController.create (/repo/x.js:12:34)')).toBe(true)
    expect(isStackLine('\u001B[2m    at async Module._compile (x.js:1:1)\u001B[22m')).toBe(true)
    // 没有缩进的 `at` 只是一句普通日志（比如写给人看的说明）
    expect(isStackLine('at the end of the day')).toBe(false)
    // 缩进但不是堆栈
    expect(isStackLine('    - 提示：这是普通的多行输出')).toBe(false)
  })

  it('摘要行 + 三帧堆栈 = 一条日志，detail 里能看全', () => {
    const store = new LogStore()
    const first = store.addLine(APP_ID, 'api', 'error', '5xx GET /api/items → TypeError: boom')

    let last = first
    for (const frame of ['    at a (x.js:1:1)', '    at b (y.js:2:2)', '    at c (z.js:3:3)']) {
      last = store.addLine(APP_ID, 'api', 'info', frame)
    }

    const entries = store.list(APP_ID)
    expect(entries).toHaveLength(1)
    // id 不变：前端按 id upsert，界面上还是一条
    expect(last.id).toBe(first.id)
    expect(entries[0]?.detail?.split('\n')).toHaveLength(3)
    expect(entries[0]?.detail).toContain('at c (z.js:3:3)')
    expect(entries[0]?.message).toContain('TypeError: boom')
  })

  it('上一行不是 warn/error 时不并（否则普通缩进输出会被吞掉）', () => {
    const store = new LogStore()
    store.addLine(APP_ID, 'vite', 'info', '  VITE v7.1.0  ready in 210 ms')
    store.addLine(APP_ID, 'vite', 'info', '    at something (x.js:1:1)')
    expect(store.list(APP_ID)).toHaveLength(2)
  })

  it('跨来源不并：vite 的 at 行不会跑到 api 那条的 detail 里', () => {
    const store = new LogStore()
    store.addLine(APP_ID, 'api', 'error', '5xx GET /api/items → Error: boom')
    store.addLine(APP_ID, 'vite', 'info', '    at hmr (client.js:1:1)')
    const entries = store.list(APP_ID)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.detail).toBeNull()
  })

  it('超出时间窗口的 at 行算新的一条（避免把十分钟后的堆栈接到旧错误上）', () => {
    const store = new LogStore()
    const t0 = 1_000_000
    store.addLine(APP_ID, 'api', 'error', '5xx → Error: boom', t0)
    store.addLine(APP_ID, 'api', 'info', '    at late (x.js:1:1)', t0 + 60_000)
    expect(store.list(APP_ID)).toHaveLength(2)
  })
})
