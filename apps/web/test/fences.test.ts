import { describe, expect, it } from 'vitest'
import { splitFences } from '../src/lib/fences.js'

describe('围栏切分（对话气泡里的代码块）', () => {
  it('没有围栏时是一整段文本', () => {
    const segments = splitFences('我来改一下 App.tsx。')
    expect(segments).toEqual([{ kind: 'text', lang: '', value: '我来改一下 App.tsx。' }])
  })

  it('围栏前后的文本都保留，顺序不乱', () => {
    const segments = splitFences('先说一句：\n```ts\nconst a = 1\n```\n再说一句。')
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'code', 'text'])
    expect(segments[1]).toEqual({ kind: 'code', lang: 'ts', value: 'const a = 1\n' })
    expect(segments[2]?.value).toBe('再说一句。')
  })

  it('多块代码各自成段', () => {
    const segments = splitFences('```js\na\n```\n中间\n```css\nb{color:red}\n```')
    expect(segments.filter((segment) => segment.kind === 'code')).toHaveLength(2)
    expect(segments.filter((segment) => segment.kind === 'text').map((segment) => segment.value)).toContain(
      '中间',
    )
  })

  /**
   * 围栏是块级元素、自己就会换行；文本段又按 `whitespace-pre-wrap` 渲染。
   * 不削掉紧贴围栏的换行，界面会在代码块上下各多出一条空白缝。
   */
  it('紧贴围栏的换行被削掉，段落内部的换行保留', () => {
    const segments = splitFences('一\n二\n```ts\nx\n```\n三\n四')
    expect(segments[0]?.value).toBe('一\n二')
    expect(segments[2]?.value).toBe('三\n四')
  })

  /**
   * 这是这个函数存在的唯一理由：流式输出时 ` ``` ` 先到、结尾的还没来。
   * 如果按「必须闭合才算代码块」写，界面会先把它渲染成普通段落、几十毫秒后再跳成代码块 ——
   * 那种闪烁比不渲染更难忍。
   */
  it('未闭合的围栏按代码块处理（流式过程中的常态）', () => {
    const segments = splitFences('看这里：\n```tsx\nexport function App() {\n  return <div/>')
    expect(segments).toHaveLength(2)
    expect(segments[1]?.kind).toBe('code')
    expect(segments[1]?.lang).toBe('tsx')
    expect(segments[1]?.value).toContain('return <div/>')
  })

  it('开头就是围栏时不会产生空文本段', () => {
    const segments = splitFences('```\nx\n```')
    expect(segments).toHaveLength(1)
    expect(segments[0]?.kind).toBe('code')
  })

  it('连续调用不会因为正则的 lastIndex 串味', () => {
    const first = splitFences('```a\n1\n```')
    const second = splitFences('```b\n2\n```')
    expect(first[0]?.value).toContain('1')
    expect(second[0]?.value).toContain('2')
  })
})
