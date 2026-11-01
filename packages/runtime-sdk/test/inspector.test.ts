/**
 * inspector 的纯逻辑部分。DOM 的真实交互由 `pnpm e2e:inspector` 在真 Chromium 里跑
 * （这个环境没有 jsdom，也不该为它引一个 —— `elementFromPoint` 之类的东西 jsdom 本来就没有）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSelector,
  clampText,
  installTenonInspector,
  intersects,
  readTokenFromHash,
} from '../src/browser/tenon-inspector.js'
import type { SelectorNode } from '../src/browser/tenon-inspector.js'

function node(tagName: string, classes = '', parent: SelectorNode | null = null, id = ''): SelectorNode {
  return { tagName, className: classes, id, parentElement: parent }
}

describe('buildSelector', () => {
  it('带上最近两层祖先，用 ` > ` 连', () => {
    const leaf = node('h1', 'title', node('main', 'page', node('body')))
    expect(buildSelector(leaf)).toBe('body > main.page > h1.title')
  })

  it('有 id 就到此为止（id 已经够唯一了）', () => {
    const leaf = node('span', '', node('section', '', node('body'), 'hero'))
    expect(buildSelector(leaf)).toBe('section#hero > span')
  })

  it('类名最多取两个：Tailwind 的类名一长串，全带上反而看不清', () => {
    const leaf = node('div', 'flex items-center gap-2 p-3 text-sm')
    expect(buildSelector(leaf)).toBe('div.flex.items-center')
  })

  it('className 不是字符串（SVG 的 SVGAnimatedString）不炸', () => {
    const leaf = node('svg', { baseVal: 'icon' } as unknown as string)
    expect(buildSelector(leaf)).toBe('svg')
  })
})

describe('clampText', () => {
  it('换行折叠成空格并去首尾空白', () => {
    expect(clampText('  点了 3\n  次  ')).toBe('点了 3 次')
  })

  it('超长截断并加省略号', () => {
    const text = clampText('字'.repeat(600))
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBe(501)
  })
})

describe('intersects', () => {
  const region = { x: 10, y: 10, width: 100, height: 100 }

  it('相交 / 相离 / 相切', () => {
    expect(intersects({ x: 50, y: 50, width: 10, height: 10 }, region)).toBe(true)
    expect(intersects({ x: 200, y: 200, width: 10, height: 10 }, region)).toBe(false)
    // 只碰到边不算相交：贴着边界的那一行元素不该被框进来
    expect(intersects({ x: 110, y: 10, width: 10, height: 10 }, region)).toBe(false)
  })

  it('包住整个区域也算相交（大容器不该被排除在"相交"之外）', () => {
    expect(intersects({ x: 0, y: 0, width: 400, height: 400 }, region)).toBe(true)
  })
})

describe('readTokenFromHash', () => {
  it('读 #tenon-inspector=<token>', () => {
    expect(readTokenFromHash('#tenon-inspector=abc123')).toBe('abc123')
  })

  it('和其它 hash 段混在一起也能挑出来', () => {
    expect(readTokenFromHash('#a=1&tenon-inspector=xyz&b=2')).toBe('xyz')
  })

  it('编码过的值会解码', () => {
    expect(readTokenFromHash('#tenon-inspector=a%2Fb')).toBe('a/b')
  })

  it('没有就返回空串（调用方据此决定不装 inspector）', () => {
    expect(readTokenFromHash('')).toBe('')
    expect(readTokenFromHash('#something-else')).toBe('')
  })
})

describe('installTenonInspector 的环境守卫', () => {
  it('在 Node（没有 window/document）里返回一个 no-op，而不是抛', () => {
    const uninstall = installTenonInspector()
    expect(typeof uninstall).toBe('function')
    expect(() => uninstall()).not.toThrow()
  })
})
