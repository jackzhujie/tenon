/**
 * 点选上下文的**文本编解码**（DESIGN §10.2 / §10.3）。
 *
 * 为什么需要它：`pi-durable` 的 `submit()` 只吃一段纯文本，没有"结构化附件"这种入口。
 * 而用户气泡里不该出现这坨机器看得懂的东西。所以约定：
 *
 *   composeWithSelection('字号改大', sel)  →  "[TENON-SELECTION] {...}\n\n字号改大"   （发给 harness）
 *   stripSelectionBlock(...)               →  "字号改大"                            （渲染给用户）
 *
 * 两个函数必须**成对**使用，任何一端单独改都会让用户看到机器文本（或者 Agent 收不到定位）。
 * 往返恒等在 `packages/protocol/test/selection-text.test.ts` 里锁住。
 *
 * 本文件**零运行时依赖**：浏览器侧（渲染消息）也要 import 它，不能把 zod 拖进前端产物。
 */

/** 行首标记。挑一个用户几乎不会打出来的形状，且**必须在第一行**才认 */
export const SELECTION_MARKER = '[TENON-SELECTION]'

export type LocSummary = {
  file: string
  line: number
  column: number
  kind?: 'usage' | 'element' | 'component-impl'
}

/** 结构化参数（结构性类型，`SelectionContext` 天然满足；这里不引 zod 是为了零依赖） */
export type SelectionSummary = {
  kind: 'element' | 'region' | 'error'
  route?: string
  loc?: LocSummary
  /** callsite 命中时组件的实现位置 */
  impl?: { file: string; line: number; column: number }
  selector?: string
  rect?: { x: number; y: number; width: number; height: number }
  text?: string
  elements?: Array<{ selector: string; loc?: LocSummary }>
}

/** 一行 JSON：Agent 解析得动，人也勉强能读；压缩成一行是为了"剥离"能按行做 */
export function selectionBlock(selection: SelectionSummary): string {
  return `${SELECTION_MARKER} ${JSON.stringify(selection)}`
}

export function composeWithSelection(
  text: string,
  selection: SelectionSummary | null | undefined,
): string {
  if (selection === undefined || selection === null) return text
  return `${selectionBlock(selection)}\n\n${text}`
}

/** 只剥**第一行**的标记块；用户自己在正文里写出这个标记也不会被吞掉 */
export function stripSelectionBlock(text: string): string {
  if (!text.startsWith(SELECTION_MARKER)) return text
  const end = text.indexOf('\n\n')
  if (end === -1) return ''
  return text.slice(end + 2)
}

/** 调试/测试用：把标记块读回来；没有则 undefined */
export function readSelectionBlock(text: string): SelectionSummary | undefined {
  if (!text.startsWith(SELECTION_MARKER)) return undefined
  const end = text.indexOf('\n\n')
  const line = end === -1 ? text : text.slice(0, end)
  const json = line.slice(SELECTION_MARKER.length).trim()
  if (json === '') return undefined
  try {
    return JSON.parse(json) as SelectionSummary
  } catch {
    return undefined
  }
}
