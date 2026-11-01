/**
 * 编译期注入的决策逻辑（不依赖 Babel）。
 * 接线对不对由 `pnpm e2e:preview` 断言「Vite 吐出来的 JS 里带这个属性」来证 —— 这里只测规则。
 */
import { describe, expect, it } from 'vitest'
import tenonLoc, { decideInjection, readOptions } from '../src/vite/tenon-loc.js'

const APP = '/tmp/app'
const base = { appRoot: APP, line: 12, column: 5 }

describe('decideInjection', () => {
  it('原生标签注入 data-tenon-loc，值形如 file:line:column', () => {
    expect(decideInjection({ ...base, filename: `${APP}/src/App.tsx`, tag: 'div' })).toEqual({
      attribute: 'data-tenon-loc',
      value: 'src/App.tsx:12:5',
    })
  })

  it('组合组件注入 data-tenon-callsite（用户写的那一行，不是组件实现）', () => {
    expect(decideInjection({ ...base, filename: `${APP}/src/pages/a.tsx`, tag: 'Button' })).toEqual({
      attribute: 'data-tenon-callsite',
      value: 'src/pages/a.tsx:12:5',
    })
  })

  it('自定义元素（带横杠）按原生标签处理', () => {
    expect(decideInjection({ ...base, filename: `${APP}/src/a.tsx`, tag: 'my-card' })?.attribute).toBe(
      'data-tenon-loc',
    )
  })

  it('成员表达式组件也标 callsite', () => {
    expect(decideInjection({ ...base, filename: `${APP}/src/a.tsx`, tag: 'Card.Header' })).toEqual({
      attribute: 'data-tenon-callsite',
      value: 'src/a.tsx:12:5',
    })
  })

  it('组件库实现内部不标 callsite（标了只会把用户引去实现文件）', () => {
    expect(
      decideInjection({ ...base, filename: `${APP}/src/components/ui/button.tsx`, tag: 'Button' }),
    ).toBeUndefined()
  })

  it('组件库内部的原生标签照样标 loc', () => {
    expect(
      decideInjection({ ...base, filename: `${APP}/src/components/ui/button.tsx`, tag: 'button' }),
    ).toEqual({ attribute: 'data-tenon-loc', value: 'src/components/ui/button.tsx:12:5' })
  })

  it('不渲染宿主元素的组件跳过', () => {
    for (const tag of ['Fragment', 'Suspense', 'StrictMode', 'Provider', 'Theme.Provider']) {
      expect(decideInjection({ ...base, filename: `${APP}/src/a.tsx`, tag })).toBeUndefined()
    }
  })

  it('appRoot 之外的文件不注入（node_modules / 上级目录）', () => {
    expect(decideInjection({ ...base, filename: '/other/x.tsx', tag: 'div' })).toBeUndefined()
    expect(decideInjection({ ...base, filename: `${APP}/node_modules/x/a.tsx`, tag: 'div' })).toBeUndefined()
  })

  it('已经手动写过同名属性就不再重复注入（但另一层的属性照加）', () => {
    expect(
      decideInjection({ ...base, filename: `${APP}/src/a.tsx`, tag: 'div', existing: ['data-tenon-loc'] }),
    ).toBeUndefined()
    expect(
      decideInjection({
        ...base,
        filename: `${APP}/src/a.tsx`,
        tag: 'Button',
        existing: ['data-tenon-loc'],
      })?.attribute,
    ).toBe('data-tenon-callsite')
  })
})

describe('readOptions', () => {
  it('缺 appRoot 直接抛，而不是静默不注入', () => {
    expect(() => readOptions({})).toThrow(/appRoot/)
    expect(() => readOptions(undefined)).toThrow(/appRoot/)
  })

  it('默认把 src/components/ui/ 当组件库', () => {
    expect(readOptions({ appRoot: APP }).libraryDirs).toEqual(['src/components/ui/'])
  })
})

describe('插件接线', () => {
  it('Babel 插件工厂是 (api, options) 形状，visitor 里挂 JSXOpeningElement', () => {
    const plugin = tenonLoc(undefined, { appRoot: APP })
    expect(plugin.name).toBe('tenon-loc')
    expect(typeof plugin.visitor['JSXOpeningElement']).toBe('function')
  })

  it('手工构造的 AST 节点能被注入（模拟 Babel 的最小结形状）', () => {
    const plugin = tenonLoc(undefined, { appRoot: APP })
    const attributes: unknown[] = []
    const node = {
      name: { type: 'JSXIdentifier', name: 'div' },
      attributes,
      loc: { start: { line: 3, column: 4 } },
    }
    plugin.visitor['JSXOpeningElement']?.({ node }, { filename: `${APP}/src/App.tsx` })

    expect(attributes).toEqual([
      {
        type: 'JSXAttribute',
        name: { type: 'JSXIdentifier', name: 'data-tenon-loc' },
        value: { type: 'StringLiteral', value: 'src/App.tsx:3:5' },
      },
    ])
  })

  it('Babel 的列号是 0 起，注入值必须 +1（否则跳一格）', () => {
    const plugin = tenonLoc(undefined, { appRoot: APP })
    const attributes: unknown[] = []
    plugin.visitor['JSXOpeningElement']?.(
      {
        node: {
          name: { type: 'JSXIdentifier', name: 'div' },
          attributes,
          loc: { start: { line: 1, column: 0 } },
        },
      },
      { filename: `${APP}/src/App.tsx` },
    )
    expect(attributes[0]).toMatchObject({ value: { value: 'src/App.tsx:1:1' } })
  })

  it('形状不对的节点不抛异常（Babel 版本漂移时的兜底）', () => {
    const plugin = tenonLoc(undefined, { appRoot: APP })
    const visit = plugin.visitor['JSXOpeningElement']
    expect(() => visit?.({}, { filename: `${APP}/src/App.tsx` })).not.toThrow()
    expect(() => visit?.(undefined, undefined)).not.toThrow()
  })
})
