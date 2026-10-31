/**
 * 围栏代码块的切分。放在 lib 下（而不是跟组件一起）是为了能被**纯逻辑测试**覆盖 ——
 * 它唯一的坑在「流式过程中围栏还没闭合」，那是最容易写错、又最难在界面上复现的地方。
 */
export interface Segment {
  kind: 'text' | 'code'
  lang: string
  value: string
}

/** 未闭合的围栏按代码块处理：流式过程中 ``` 会先到，不能让它闪一下再变 */
const FENCE = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g

export function splitFences(input: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  FENCE.lastIndex = 0
  let match: RegExpExecArray | null = FENCE.exec(input)
  while (match !== null) {
    if (match.index > last) {
      segments.push({ kind: 'text', lang: '', value: input.slice(last, match.index) })
    }
    segments.push({ kind: 'code', lang: match[1] ?? '', value: match[2] ?? '' })
    last = FENCE.lastIndex
    match = FENCE.exec(input)
  }
  if (last < input.length) {
    segments.push({ kind: 'text', lang: '', value: input.slice(last) })
  }
  return trimFenceGaps(segments)
}

/**
 * 紧贴围栏的那个换行要去掉。
 *
 * 围栏在界面上是块级元素，它自己就换行了；文本段又是 `whitespace-pre-wrap` 渲染的，
 * 于是 ` ```\n再说一句 ` 里那个 `\n` 会额外顶出一行空白 —— 代码块上方/下方凭空多一条缝。
 * 只在「邻居是代码块」的那一侧各削一个换行，段落内部的换行一律保留。
 */
function trimFenceGaps(segments: Segment[]): Segment[] {
  const result: Segment[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) continue
    if (segment.kind === 'code') {
      result.push(segment)
      continue
    }
    let value = segment.value
    if (segments[index - 1]?.kind === 'code') value = value.replace(/^\r?\n/, '')
    if (segments[index + 1]?.kind === 'code') value = value.replace(/\r?\n$/, '')
    if (value === '') continue
    result.push({ ...segment, value })
  }
  return result
}
