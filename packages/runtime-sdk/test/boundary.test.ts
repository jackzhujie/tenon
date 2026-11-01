/**
 * 错误边界的三件事：兜住、上报、给一个能重试的界面。
 *
 * 不挂 DOM：`render()` 的返回值直接交给 `renderToStaticMarkup`，
 * 这样测试不需要 jsdom，也不会因为 React 版本升级而反复调环境。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createElement } from 'react'

const { reported } = vi.hoisted(() => ({
  reported: [] as Array<{ level?: string; message: string; detail?: string | null }>,
}))

vi.mock('../src/browser/tenon-log', () => ({
  reportLog: (payload: { level?: string; message: string; detail?: string | null }) => {
    reported.push(payload)
  },
  installTenonLog: () => undefined,
}))

const { TenonErrorBoundary } = await import('../src/browser/tenon-boundary')

/** 把 element 渲成静态 HTML（不挂载、不跑副作用） */
function html(node: ReactNode): string {
  return renderToStaticMarkup(createElement('div', null, node))
}

describe('TenonErrorBoundary', () => {
  beforeEach(() => {
    reported.length = 0
  })

  it('没出错时原样渲染 children', () => {
    const markup = html(
      createElement(TenonErrorBoundary, null, createElement('h1', null, '正常内容')),
    )
    expect(markup).toContain('正常内容')
    expect(markup).not.toContain('页面出错了')
  })

  it('有错误时渲染降级界面：消息、提示、重试按钮都在', () => {
    const boundary = new TenonErrorBoundary({ children: null })
    boundary.state = { error: new Error('items.map is not a function') }
    const markup = html(boundary.render())

    expect(markup).toContain('页面出错了')
    expect(markup).toContain('items.map is not a function')
    expect(markup).toContain('重试渲染')
    // 降级 UI 不依赖任何模板的 css 类名（两个模板共用同一份代码，靠 inline style）
    expect(markup).not.toContain('class=')
  })

  it('getDerivedStateFromError 把错误放进 state', () => {
    const error = new Error('boom')
    expect(TenonErrorBoundary.getDerivedStateFromError(error)).toEqual({ error })
  })

  it('componentDidCatch 上报一条带组件栈的日志', () => {
    const boundary = new TenonErrorBoundary({ children: null })
    boundary.componentDidCatch(new Error('渲染炸了'), {
      componentStack: '\n    at App\n    at Root',
    } as never)

    expect(reported).toHaveLength(1)
    const entry = reported[0]
    expect(entry?.level).toBe('error')
    expect(entry?.message).toBe('渲染出错：渲染炸了')
    expect(entry?.detail).toContain('渲染炸了')
    expect(entry?.detail).toContain('组件栈：')
    expect(entry?.detail).toContain('at App')
  })
})
