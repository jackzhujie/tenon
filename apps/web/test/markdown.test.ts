/**
 * Markdown 解析的测试。
 *
 * 用例全部取自**真实的模型输出**（截图里那次"为什么 lint 失败"的回答就是原样搬过来的），
 * 而不是教科书里的语法样例 —— 要防的是"模型爱写什么、我们就得渲染什么"。
 */
import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, type Inline } from '../src/lib/markdown.js'

/** 把内联压成便于断言的字符串：粗体写成 [b]…[/b]，代码写成 `…` */
function inline(text: string): string {
  return parseInline(text)
    .map((part) => {
      switch (part.kind) {
        case 'text':
          return part.value
        case 'code':
          return `\`${part.value}\``
        case 'strong':
          return `[b]${inlineOf(part.value)}[/b]`
        case 'em':
          return `[i]${inlineOf(part.value)}[/i]`
        case 'del':
          return `[s]${inlineOf(part.value)}[/s]`
        case 'link':
          return `[a:${part.href}]${inlineOf(part.value)}[/a]`
      }
    })
    .join('')
}

function inlineOf(parts: Inline[]): string {
  return parts
    .map((part) => {
      if (part.kind === 'text') return part.value
      if (part.kind === 'code') return `\`${part.value}\``
      if (part.kind === 'strong') return `[b]${inlineOf(part.value)}[/b]`
      if (part.kind === 'em') return `[i]${inlineOf(part.value)}[/i]`
      if (part.kind === 'del') return `[s]${inlineOf(part.value)}[/s]`
      return `[a:${part.href}]${inlineOf(part.value)}[/a]`
    })
    .join('')
}

describe('内联', () => {
  it('粗体、行内代码、斜体各就各位', () => {
    expect(inline('是因为**问题出在你的 shell 环境**，不是仓库')).toBe('是因为[b]问题出在你的 shell 环境[/b]，不是仓库')
    expect(inline('它只认 PATH 上的 `node` —— 哪个都找不到')).toBe('它只认 PATH 上的 `node` —— 哪个都找不到')
    expect(inline('这句是*强调*的')).toBe('这句是[i]强调[/i]的')
  })

  it('粗体里套斜体（正则写法最容易坏在这里）', () => {
    expect(inline('**这条*很*重要**')).toBe('[b]这条[i]很[/i]重要[/b]')
  })

  it('代码里的星号不当粗体', () => {
    expect(inline('写成 `a**b` 就是字面量')).toBe('写成 `a**b` 就是字面量')
  })

  it('数学式的单个星号不该被吃掉', () => {
    expect(inline('2 * 3 * 4')).toBe('2 * 3 * 4')
  })

  it('链接与裸链接', () => {
    expect(inline('见[文档](https://example.com/x)')).toBe('见[a:https://example.com/x]文档[/a]')
    expect(inline('打开 https://example.com/a 看看')).toBe('打开 [a:https://example.com/a]https://example.com/a[/a] 看看')
  })

  it('删除线', () => {
    expect(inline('~~删掉这行~~')).toBe('[s]删掉这行[/s]')
  })

  it('反斜杠转义', () => {
    expect(inline('这里是 \\*字面星号\\*')).toBe('这里是 *字面星号*')
  })
})

describe('块', () => {
  it('标题层级与段落', () => {
    const blocks = parseMarkdown('## 真正的原因\n\n报错没变。')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[1]?.kind).toBe('paragraph')
  })

  it('表格（截图里那张"环境 / lint / typecheck / build"）', () => {
    const blocks = parseMarkdown(
      ['| 环境 | lint | typecheck | build |', '|---|---|---|---|', '| 无 node | ✗ | — | — |', '| node 22 | ✅ | ✅ | ✅ |'].join('\n'),
    )
    expect(blocks).toHaveLength(1)
    const table = blocks[0]
    if (table?.kind !== 'table') throw new Error('没解析成表格')
    expect(table.head).toHaveLength(4)
    expect(table.rows).toHaveLength(2)
    expect(table.align).toEqual(['left', 'left', 'left', 'left'])
  })

  it('对齐标记被读进 align', () => {
    const blocks = parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    const table = blocks[0]
    if (table?.kind !== 'table') throw new Error('没解析成表格')
    expect(table.align).toEqual(['left', 'center', 'right'])
  })

  it('无序列表 + 缩进层级 + 任务勾选', () => {
    const blocks = parseMarkdown(['- 先看依赖', '  - [x] 装了 eslint', '  - [ ] 没装别的', '- 再看配置'].join('\n'))
    const list = blocks[0]
    if (list?.kind !== 'list') throw new Error('没解析成列表')
    expect(list.ordered).toBe(false)
    expect(list.items.map((item) => item.depth)).toEqual([0, 1, 1, 0])
    expect(list.items[1]?.checked).toBe(true)
    expect(list.items[2]?.checked).toBe(false)
  })

  it('有序列表单独成块，不和有序混在一起', () => {
    const blocks = parseMarkdown('1. 第一步\n2. 第二步\n\n- 另一个列表')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true })
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false })
  })

  it('列表项的续行归到同一项，而不是变成新段落', () => {
    const blocks = parseMarkdown('- 这是一句很长的话\n  折了一行\n- 第二项')
    const list = blocks[0]
    if (list?.kind !== 'list') throw new Error('没解析成列表')
    expect(list.items).toHaveLength(2)
    expect(inlineOf(list.items[0]!.inlines)).toContain('折了一行')
  })

  it('引用块递归解析', () => {
    const blocks = parseMarkdown('> 注意：**别开 synchronize**')
    const quote = blocks[0]
    if (quote?.kind !== 'quote') throw new Error('没解析成引用')
    expect(quote.blocks[0]).toMatchObject({ kind: 'paragraph' })
  })

  it('围栏代码块（含语言）留在代码块里，不参与 markdown', () => {
    const blocks = parseMarkdown('看这里：\n```ts\nconst a = "**不是粗体**"\n```\n结束')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'code', 'paragraph'])
    const code = blocks[1]
    if (code?.kind !== 'code') throw new Error('没解析成代码块')
    expect(code.lang).toBe('ts')
    expect(code.value).toContain('**不是粗体**')
  })

  it('流式：未闭合的围栏仍然当代码块（不能闪成普通段落）', () => {
    const blocks = parseMarkdown('正在写：\n```tsx\nexport function App() {')
    const code = blocks[blocks.length - 1]
    expect(code?.kind).toBe('code')
  })

  it('分隔线', () => {
    expect(parseMarkdown('上面\n\n---\n\n下面').map((block) => block.kind)).toEqual([
      'paragraph',
      'hr',
      'paragraph',
    ])
  })

  it('空输入不产出块（否则气泡里会多一块空白）', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })
})
