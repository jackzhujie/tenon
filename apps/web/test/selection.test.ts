/**
 * 父窗口侧的校验。这里的每一条负样例都对应一个真实攻击面 ——
 * `context` 是**生成应用的页面**发来的，用户和 Agent 都能改那份代码。
 */
import { describe, expect, it } from 'vitest'
import { makeT } from '../src/lib/i18n.js'
import {
  harvestInspectorMessage,
  INSPECTOR_SOURCE,
  originOf,
  selectionLabel,
} from '../src/lib/selection.js'

const ORIGIN = 'http://127.0.0.1:63081'
const TOKEN = 'tok-abc'

const goodContext = {
  kind: 'element',
  route: '/',
  loc: { file: 'src/App.tsx', line: 25, column: 5, kind: 'element' },
  impl: { file: 'src/components/ui/button.tsx', line: 8, column: 3 },
  selector: 'main > h1',
  rect: { x: 1, y: 2, width: 30, height: 40 },
  text: '价格',
  styles: { 'font-size': '14px' },
  viewport: { width: 1200, height: 800, dpr: 2 },
}

function harvest(patch: Record<string, unknown> = {}): ReturnType<typeof harvestInspectorMessage> {
  const { data, eventOrigin, expectedOrigin, expectedToken } = {
    data: { source: INSPECTOR_SOURCE, token: TOKEN, context: goodContext },
    eventOrigin: ORIGIN,
    expectedOrigin: ORIGIN,
    expectedToken: TOKEN,
    ...patch,
  } as {
    data: unknown
    eventOrigin: string
    expectedOrigin: string | null
    expectedToken: string | null
  }
  return harvestInspectorMessage({ data, eventOrigin, expectedOrigin, expectedToken })
}

const zh = makeT('zh')

describe('harvestInspectorMessage', () => {
  it('三道都过就收下，并把字段搬到协议形状上', () => {
    const context = harvest()
    expect(context?.kind).toBe('element')
    expect(context?.loc).toEqual({ file: 'src/App.tsx', line: 25, column: 5, kind: 'element' })
    expect(context?.impl?.file).toBe('src/components/ui/button.tsx')
    expect(context?.text).toBe('价格')
  })

  it('来源不对（别的页面发来的）一律丢', () => {
    expect(harvest({ eventOrigin: 'http://evil.example' })).toBeUndefined()
  })

  it('token 不对就丢（iframe 换过一次、旧页面还在发）', () => {
    expect(
      harvest({ data: { source: INSPECTOR_SOURCE, token: 'old', context: goodContext } }),
    ).toBeUndefined()
    expect(harvest({ expectedToken: null })).toBeUndefined()
    expect(harvest({ expectedToken: '' })).toBeUndefined()
  })

  it('没有预览时（expectedOrigin=null）什么都不收', () => {
    expect(harvest({ expectedOrigin: null })).toBeUndefined()
  })

  it('source 不对就丢（页面上别的脚本也能 postMessage）', () => {
    expect(harvest({ data: { source: 'other', token: TOKEN, context: goodContext } })).toBeUndefined()
  })

  it('**loc.file 只接受应用内相对路径** —— 这是防注入的关键一条', () => {
    for (const file of ['../../tenon.db', '/etc/passwd', 'C:/Users/x', 'src/../db', '', '~/.ssh/id']) {
      const context = harvest({
        data: {
          source: INSPECTOR_SOURCE,
          token: TOKEN,
          context: { ...goodContext, loc: { file, line: 1, column: 1 } },
        },
      })
      expect(context?.loc, `file=${file}`).toBeUndefined()
    }
  })

  it('行号列号必须是正整数，kind 不认识就退回 element', () => {
    const context = harvest({
      data: {
        source: INSPECTOR_SOURCE,
        token: TOKEN,
        context: {
          ...goodContext,
          loc: { file: 'src/App.tsx', line: 0, column: 1 },
          impl: { file: 'src/a.tsx', line: 3, column: 2 },
        },
      },
    })
    expect(context?.loc).toBeUndefined()

    const fallback = harvest({
      data: {
        source: INSPECTOR_SOURCE,
        token: TOKEN,
        context: { ...goodContext, loc: { file: 'src/App.tsx', line: 1, column: 1, kind: 'weird' } },
      },
    })
    expect(fallback?.loc?.kind).toBe('element')
  })

  it('kind 不认识就整条丢（不让前端收到"未知形状"）', () => {
    expect(
      harvest({
        data: { source: INSPECTOR_SOURCE, token: TOKEN, context: { kind: 'nope' } },
      }),
    ).toBeUndefined()
  })

  it('框选：元素列表最多 50 条，坏的条目跳过而不是整条失败', () => {
    const elements = Array.from({ length: 60 }, (_, index) => ({
      selector: `div:nth-child(${String(index)})`,
    }))
    const context = harvest({
      data: {
        source: INSPECTOR_SOURCE,
        token: TOKEN,
        context: { kind: 'region', elements: [{ nope: 1 }, ...elements] },
      },
    })
    expect(context?.kind).toBe('region')
    expect(context?.elements?.length).toBe(50)
  })

  it('data 形状不对（字符串 / 数组 / null）都不抛', () => {
    expect(harvest({ data: 'hello' })).toBeUndefined()
    expect(harvest({ data: [] })).toBeUndefined()
    expect(harvest({ data: null })).toBeUndefined()
  })
})

describe('originOf', () => {
  it('取源，去掉路径', () => {
    expect(originOf('http://127.0.0.1:63081/src/App.tsx')).toBe('http://127.0.0.1:63081')
  })

  it('空 / 非法地址返回 null（宁可收不到，也不要收错）', () => {
    expect(originOf(null)).toBeNull()
    expect(originOf('')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })
})

describe('selectionLabel', () => {
  it('元素给 文件名:行', () => {
    expect(selectionLabel({ kind: 'element', loc: { file: 'src/pages/a.tsx', line: 12, column: 3 } }, zh)).toBe(
      'a.tsx:12',
    )
  })

  it('组件库实现要标出来（改动影响全局）', () => {
    expect(
      selectionLabel({
        kind: 'element',
        loc: { file: 'src/components/ui/button.tsx', line: 8, column: 3, kind: 'component-impl' },
      }, zh),
    ).toBe('button.tsx:8 · 组件库')
  })

  it('框选给数量', () => {
    expect(selectionLabel({ kind: 'region', elements: [{ selector: 'a' }, { selector: 'b' }] }, zh)).toBe(
      '已框选 2 个元素',
    )
  })

  it('没有 loc 时退回 selector，再退到兜底文案', () => {
    expect(selectionLabel({ kind: 'element', selector: 'main > h1' }, zh)).toBe('main > h1')
    expect(selectionLabel({ kind: 'element' }, zh)).toBe('已选中元素')
    expect(selectionLabel(null, zh)).toBe('')
  })
})
