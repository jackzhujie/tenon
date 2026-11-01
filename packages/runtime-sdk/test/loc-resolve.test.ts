/**
 * 反查解析器。用假元素测（真 `Element` 只需满足 getAttribute / parentElement / tagName 三样），
 * 免去 jsdom 这类重依赖。
 */
import { describe, expect, it } from 'vitest'
import { parseLoc, resolveTarget } from '../src/browser/tenon-loc.js'
import type { ElementLike } from '../src/browser/tenon-loc.js'

function el(tagName: string, attrs: Record<string, string> = {}, parent: ElementLike | null = null): ElementLike {
  return {
    tagName,
    parentElement: parent,
    getAttribute: (name) => attrs[name] ?? null,
  }
}

describe('parseLoc', () => {
  it('解析 file:line:column', () => {
    expect(parseLoc('src/App.tsx:42:7', 'element')).toEqual({
      file: 'src/App.tsx',
      line: 42,
      column: 7,
      kind: 'element',
    })
  })

  it('文件名里带冒号也不切错（Windows 盘符）', () => {
    expect(parseLoc('C:/app/src/App.tsx:1:2', 'usage')).toMatchObject({
      file: 'C:/app/src/App.tsx',
      line: 1,
      column: 2,
    })
  })

  it('畸形值一律 undefined，不猜', () => {
    for (const raw of ['', 'src/App.tsx', 'src/App.tsx:1', 'src/App.tsx:x:y', 'src/App.tsx:0:0', ':1:2']) {
      expect(parseLoc(raw, 'element')).toBeUndefined()
    }
  })
})

describe('resolveTarget', () => {
  it('callsite 优先，loc 作为 secondary（组件实现位置）', () => {
    const node = el('button', {
      'data-tenon-callsite': 'src/pages/a.tsx:13:9',
      'data-tenon-loc': 'src/components/ui/button.tsx:8:3',
    })
    expect(resolveTarget(node)).toEqual({
      primary: { file: 'src/pages/a.tsx', line: 13, column: 9, kind: 'usage' },
      secondary: { file: 'src/components/ui/button.tsx', line: 8, column: 3, kind: 'component-impl' },
      tag: 'button',
      hops: 0,
    })
  })

  it('只有 loc 且在组件库目录内 → component-impl（UI 要提示"改动影响全局"）', () => {
    const node = el('button', { 'data-tenon-loc': 'src/components/ui/button.tsx:8:3' })
    expect(resolveTarget(node)?.primary.kind).toBe('component-impl')
  })

  it('只有 loc 且是业务代码 → element', () => {
    const node = el('div', { 'data-tenon-loc': 'src/App.tsx:12:5' })
    expect(resolveTarget(node)).toMatchObject({
      primary: { file: 'src/App.tsx', kind: 'element' },
      hops: 0,
    })
  })

  it('自己没属性就往上找，hops 记层数', () => {
    const inner = el('span', {}, el('div', { 'data-tenon-loc': 'src/App.tsx:3:1' }, null))
    const resolved = resolveTarget(inner)
    expect(resolved?.hops).toBe(1)
    expect(resolved?.primary.file).toBe('src/App.tsx')
  })

  it('一路到根都没有属性 → undefined（不编造位置）', () => {
    expect(resolveTarget(el('span', {}, el('div')))).toBeUndefined()
  })

  it('属性值畸形时不算命中，继续往上走', () => {
    const inner = el('span', { 'data-tenon-loc': 'oops' }, el('div', { 'data-tenon-loc': 'src/App.tsx:3:1' }))
    expect(resolveTarget(inner)?.hops).toBe(1)
  })
})
