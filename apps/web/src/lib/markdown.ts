/**
 * 极简 Markdown 解析（AI 回答真正会用到的那一小撮语法）。
 *
 * 为什么不用 `react-markdown` / `marked`：
 * 1. 它们加起来 100KB+，而这里要渲染的只是"标题 / 粗体 / 行内代码 / 列表 / 表格 / 引用"。
 * 2. 走 HTML 就得 `dangerouslySetInnerHTML`，而模型输出是不可信内容 —— 要么加 sanitizer（又一个依赖），
 *    要么默认关掉 HTML（那库的收益又少一半）。这里**只产出数据结构**，交给 React 渲染成节点，
 *    天然没有注入面。
 * 3. 流式渲染有一条特殊要求：**未闭合的围栏要当代码块**（否则回答到一半时界面会闪）。
 *    那条逻辑已经在 `lib/fences.ts` 里被 8 个测试钉住了，这里直接复用它。
 *
 * 明确不支持的（写下来是为了别有人以为漏了）：
 * - 原始 HTML（模型偶尔会写 `<br>`，会原样显示 —— 这是刻意的）
 * - 引用式链接 `[x][1]`、脚注、数学公式
 * - 嵌套超过两层的内联强调（`***x***` 会退化成 `**` + `*` 的字面组合）
 * - 列表项里的多段/多级代码块（`- 步骤\n  ```sh\n  ...` 里的代码块会独立成块）
 */
import { splitFences } from './fences.js'

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; value: Inline[] }
  | { kind: 'em'; value: Inline[] }
  | { kind: 'del'; value: Inline[] }
  | { kind: 'link'; href: string; value: Inline[] }

export interface ListItem {
  /** 缩进层级（0 起）。用 `depth` 而不是递归结构：渲染时缩进就够了，不必造树 */
  depth: number
  inlines: Inline[]
  /** 任务列表：`- [ ]` / `- [x]` */
  checked?: boolean
}

export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'code'; lang: string; value: string }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'table'; head: Inline[][]; align: Array<'left' | 'center' | 'right'>; rows: Inline[][][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'hr' }

// ---------------------------------------------------------------- 内联

const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '[', ']', '(', ')', '#', '-', '+', '|'])

/**
 * 扫描式解析内联（不是正则替换）。
 *
 * 正则会栽在 `**a *b* c**` 这种嵌套上，而模型很爱写"粗体里带一句斜体"。
 * 扫描式遇到闭合符就递归处理里面，嵌套自然就对了；找不到闭合符时把那几个字符
 * 当普通文本消费掉（否则 `2 * 3 * 4` 会被吃掉一个星号）。
 */
export function parseInline(input: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => {
    if (text !== '') {
      out.push({ kind: 'text', value: text })
      text = ''
    }
  }

  let index = 0
  while (index < input.length) {
    const rest = input.slice(index)
    const char = input[index] ?? ''

    // 反斜杠转义
    if (char === '\\' && ESCAPABLE.has(input[index + 1] ?? '')) {
      text += input[index + 1] ?? ''
      index += 2
      continue
    }

    // 行内代码：里面的一切都是字面量
    if (char === '`') {
      const close = input.indexOf('`', index + 1)
      if (close !== -1) {
        flush()
        out.push({ kind: 'code', value: input.slice(index + 1, close) })
        index = close + 1
        continue
      }
    }

    // 粗体 / 斜体 / 删除线
    const marks: Array<{ mark: string; kind: 'strong' | 'em' | 'del' }> = [
      { mark: '**', kind: 'strong' },
      { mark: '__', kind: 'strong' },
      { mark: '~~', kind: 'del' },
      { mark: '*', kind: 'em' },
      { mark: '_', kind: 'em' },
    ]
    let matched = false
    for (const { mark, kind } of marks) {
      if (!rest.startsWith(mark)) continue
      /*
       * `2 * 3 * 4` 里的星号不是强调 —— CommonMark 的判据是"左边界前面/后面不能是空白"：
       * 开符后紧跟空白、闭符前是空白，都不成立。少了这条，算术式会被渲染成斜体。
       */
      if (/\s/.test(input[index + mark.length] ?? '')) continue
      const close = findClosing(input, index + mark.length, mark)
      if (close === -1) continue
      const inner = input.slice(index + mark.length, close)
      if (inner.trim() === '') continue
      flush()
      out.push({ kind, value: parseInline(inner) })
      index = close + mark.length
      matched = true
      break
    }
    if (matched) continue

    // 链接 `[text](href)`
    if (char === '[') {
      const closeBracket = input.indexOf(']', index + 1)
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        const closeParen = input.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const href = input.slice(closeBracket + 2, closeParen).trim()
          flush()
          out.push({
            kind: 'link',
            href,
            value: parseInline(input.slice(index + 1, closeBracket)),
          })
          index = closeParen + 1
          continue
        }
      }
    }

    // 裸链接
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      const match = /^https?:\/\/[^\s<>()（）"'，。；]+/.exec(rest)
      if (match !== null) {
        flush()
        out.push({ kind: 'link', href: match[0], value: [{ kind: 'text', value: match[0] }] })
        index += match[0].length
        continue
      }
    }

    text += char
    index += 1
  }
  flush()
  return out
}

/**
 * 找配对的结束标记；跳过反斜杠转义。
 *
 * 两条不明显的规则：
 * - `**` 的闭合不能再是 `***` 的开头（否则 `**a**` 会被吃成 `**a*` + `*`）
 * - 闭符**前面不能是空白**：`2 * 3 * 4` 里的第二个星号前面是空格，不算闭合，
 *   继续往后找；找不到就整对当字面量
 */
function findClosing(input: string, from: number, mark: string): number {
  let index = from
  while (index < input.length) {
    if (input[index] === '\\') {
      index += 2
      continue
    }
    if (input.startsWith(mark, index)) {
      // 单字符标记（`*` / `_`）紧跟在同类字符后面时不算闭合（那是 `**` 的开头）
      if (mark.length === 1 && input[index + 1] === mark) {
        index += 2
        continue
      }
      if (/\s/.test(input[index - 1] ?? '')) {
        index += mark.length
        continue
      }
      return index
    }
    index += 1
  }
  return -1
}

// ---------------------------------------------------------------- 块

const HEADING = /^(#{1,6})\s+(.*)$/
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const UL_ITEM = /^(\s*)([-*+])\s+(.*)$/
const OL_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const TASK = /^\[( |x|X)\]\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim() !== ''
}

function cellsOf(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

function alignOf(separator: string): Array<'left' | 'center' | 'right'> {
  return cellsOf(separator).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * 把一段纯文本切成块。
 *
 * `splitFences` 已经把代码块摘出去了，所以这里只管"非代码"的那部分 ——
 * 也正是它让流式过程中未闭合的围栏仍然显示成代码块。
 */
export function parseBlocks(input: string): Block[] {
  const lines = input.split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index += 1
      continue
    }

    // 标题
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        inlines: parseInline(heading[2] ?? ''),
      })
      index += 1
      continue
    }

    // 分隔线
    if (HR.test(line)) {
      blocks.push({ kind: 'hr' })
      index += 1
      continue
    }

    // 引用：连续 `>` 行整体递归解析
    if (/^\s*>/.test(line)) {
      const inner: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        inner.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n')) })
      continue
    }

    // 表格：本行有 `|`，下一行是分隔行
    if (isTableRow(line) && TABLE_SEP.test(lines[index + 1] ?? '')) {
      const head = cellsOf(line).map(parseInline)
      const align = alignOf(lines[index + 1] ?? '')
      const rows: Inline[][][] = []
      index += 2
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        rows.push(cellsOf(lines[index] ?? '').map(parseInline))
        index += 1
      }
      blocks.push({ kind: 'table', head, align, rows })
      continue
    }

    // 列表（有序 / 无序，支持缩进层级与任务勾选）
    const ul = UL_ITEM.exec(line)
    const ol = OL_ITEM.exec(line)
    if (ul !== null || ol !== null) {
      const ordered = ol !== null
      const items: ListItem[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        // 有序与无序混排时按"新开一个列表"处理，别把两种揉进一个 <ul>
        const currentUl = UL_ITEM.exec(current)
        const currentOl = OL_ITEM.exec(current)
        if (currentUl === null && currentOl === null) break
        if ((currentOl !== null) !== ordered) break
        const indent = (currentUl?.[1] ?? currentOl?.[1] ?? '').replace(/\t/g, '  ').length
        let body = currentUl?.[3] ?? currentOl?.[3] ?? ''
        /*
         * 续行：下一行不是列表项、也没有空行时，属于这一项的正文。
         * 不处理它的话，模型把一句长话折成两行就会变成两个独立段落。
         */
        index += 1
        while (index < lines.length) {
          const next = lines[index] ?? ''
          if (next.trim() === '' || UL_ITEM.test(next) || OL_ITEM.test(next) || HEADING.test(next)) break
          body += `\n${next.trim()}`
          index += 1
        }
        const task = TASK.exec(body)
        items.push({
          depth: Math.min(3, Math.floor(indent / 2)),
          inlines: parseInline(task === null ? body : (task[2] ?? '')),
          ...(task === null ? {} : { checked: (task[1] ?? ' ').toLowerCase() === 'x' }),
        })
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // 段落：一直到空行或另一个块的开始
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '') break
      if (
        HEADING.test(current) ||
        HR.test(current) ||
        /^\s*>/.test(current) ||
        UL_ITEM.test(current) ||
        OL_ITEM.test(current) ||
        (isTableRow(current) && TABLE_SEP.test(lines[index + 1] ?? ''))
      ) {
        break
      }
      paragraph.push(current)
      index += 1
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
  }

  return blocks
}

/** 入口：先按围栏切（复用流式友好的那份逻辑），再逐段解析块 */
export function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = []
  for (const segment of splitFences(input)) {
    if (segment.kind === 'code') {
      blocks.push({ kind: 'code', lang: segment.lang, value: segment.value })
    } else {
      blocks.push(...parseBlocks(segment.value))
    }
  }
  return blocks
}
