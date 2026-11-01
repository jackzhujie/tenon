/**
 * 点选上下文的文本编解码往返。
 *
 * 这两个函数跨了三个进程（渲染器 → server → agent），任何一端单独改都会让
 * 用户要么看到机器文本、要么让 Agent 收不到定位。所以用恒等律锁住。
 */
import { describe, expect, it } from 'vitest'
import {
  composeWithSelection,
  readSelectionBlock,
  SELECTION_MARKER,
  stripSelectionBlock,
} from '../src/selection-text.js'
import type { SelectionSummary } from '../src/selection-text.js'

const element: SelectionSummary = {
  kind: 'element',
  route: '/',
  loc: { file: 'src/App.tsx', line: 25, column: 5, kind: 'element' },
  selector: 'main > h1',
  rect: { x: 0, y: 0, width: 320, height: 40 },
  text: '价格',
}

describe('composeWithSelection / stripSelectionBlock', () => {
  it('往返恒等', () => {
    const text = '字号太小，改大一号'
    expect(stripSelectionBlock(composeWithSelection(text, element))).toBe(text)
  })

  it('没有 selection 时原样返回（不留下空块）', () => {
    expect(composeWithSelection('改大', null)).toBe('改大')
    expect(composeWithSelection('改大', undefined)).toBe('改大')
  })

  it('标记块永远在第一行、且只有一行', () => {
    const composed = composeWithSelection('改大', element)
    const firstLine = composed.split('\n')[0] ?? ''
    expect(firstLine.startsWith(SELECTION_MARKER)).toBe(true)
    expect(firstLine.split('\n')).toHaveLength(1)
  })

  it('多段正文（含空行）不丢内容', () => {
    const text = '第一段\n\n第二段'
    expect(stripSelectionBlock(composeWithSelection(text, element))).toBe(text)
  })

  it('用户自己在正文里写标记不会被剥（只认第一行）', () => {
    const text = `说明一下 ${SELECTION_MARKER} 是什么`
    expect(stripSelectionBlock(text)).toBe(text)
  })

  it('手工拼出来的畸形块不会抛异常', () => {
    expect(stripSelectionBlock(`${SELECTION_MARKER}\n\n正文`)).toBe('正文')
    expect(stripSelectionBlock(`${SELECTION_MARKER} not-json\n\n正文`)).toBe('正文')
    expect(stripSelectionBlock(`${SELECTION_MARKER} 无换行`)).toBe('')
  })
})

describe('readSelectionBlock', () => {
  it('能把结构化内容读回来（调试/排查用）', () => {
    const composed = composeWithSelection('改大', element)
    expect(readSelectionBlock(composed)).toEqual(element)
  })

  it('没有块 / 坏 JSON 都返回 undefined，不抛', () => {
    expect(readSelectionBlock('普通消息')).toBeUndefined()
    expect(readSelectionBlock(`${SELECTION_MARKER} {oops`)).toBeUndefined()
  })
})
