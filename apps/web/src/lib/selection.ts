/**
 * 父窗口侧：校验并接收 inspector 发回来的点选上下文（DESIGN §10.2）。
 *
 * 生成应用的页面在**网关源**上，和平台页面不同源 —— `postMessage` 是我们之间唯一的通道。
 * 这条通道暴露给"任何一个能往本窗口发消息的页面"，所以必须卡三道：
 *
 * 1. `event.origin === 预览网关的源`（别的页面发来的直接丢）
 * 2. `data.source === 'tenon-inspector'`（不是我们塞给应用的那个脚本发的）
 * 3. `data.token === 当前 iframe 的 token`（token 走 hash，只在 iframe src 里出现，
 *    不进访问日志，也不进生成应用的任何持久化位置）
 *
 * 三道都过才收。**这里的 `context` 来自生成应用的页面，必须当成不可信输入逐字段校验** ——
 * 用户（或 Agent 写坏的代码）完全可以伪造一个 `{loc:{file:'../../tenon.db'}}` 塞给平台。
 * 校验逻辑做成纯函数是为了能单测（`apps/web/test/selection.test.ts`），
 * 真链路由 `pnpm e2e:inspector` 在真 Chromium 里跑。
 */
import type { SelectionContext, SelectionLoc } from '@tenon/protocol'

/** 必须与 `packages/runtime-sdk/src/browser/tenon-inspector.ts` 的 `MESSAGE_SOURCE` 一致 */
export const INSPECTOR_SOURCE = 'tenon-inspector'
/** 必须与 runtime-sdk 的 `HASH_KEY` 一致；不一致的表现是"点了没反应" */
export const INSPECTOR_HASH_KEY = 'tenon-inspector'

const LOC_KINDS = new Set(['usage', 'element', 'component-impl'])
/** 抓到的文件路径必须是应用内的相对路径：绝对路径与 `..` 一律不认 */
const MAX_TEXT = 500

export type InspectorMessageInput = {
  data: unknown
  /** `MessageEvent.origin` */
  eventOrigin: string
  /** 预览网关的源（`new URL(previewUrl).origin`）；还没有预览时传 null */
  expectedOrigin: string | null
  /** 当前 iframe 的 token；还没发过时传 null */
  expectedToken: string | null
}

export function harvestInspectorMessage(input: InspectorMessageInput): SelectionContext | undefined {
  const { expectedOrigin, expectedToken } = input
  if (expectedOrigin === null || expectedToken === null || expectedToken === '') return undefined
  if (input.eventOrigin !== expectedOrigin) return undefined

  const data = asRecord(input.data)
  if (data === undefined) return undefined
  if (data['source'] !== INSPECTOR_SOURCE) return undefined
  if (data['token'] !== expectedToken) return undefined

  return parseContext(data['context'])
}

/** 预览地址的源；地址还不存在 / 不合法时 null */
export function originOf(previewUrl: string | null | undefined): string | null {
  if (previewUrl === null || previewUrl === undefined || previewUrl === '') return null
  try {
    return new URL(previewUrl).origin
  } catch {
    return null
  }
}

function parseContext(value: unknown): SelectionContext | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const kind = raw['kind']
  if (kind !== 'element' && kind !== 'region' && kind !== 'error') return undefined

  const context: SelectionContext = { kind }

  const route = raw['route']
  if (typeof route === 'string' && route !== '') context.route = route.slice(0, 300)

  const loc = parseLoc(raw['loc'])
  if (loc !== undefined) context.loc = loc

  const impl = parsePoint(raw['impl'])
  if (impl !== undefined) context.impl = impl

  const selector = raw['selector']
  if (typeof selector === 'string' && selector !== '') context.selector = selector.slice(0, 300)

  const rect = parseRect(raw['rect'])
  if (rect !== undefined) context.rect = rect

  const text = raw['text']
  if (typeof text === 'string') context.text = text.slice(0, MAX_TEXT)

  const styles = parseStringRecord(raw['styles'])
  if (styles !== undefined) context.styles = styles

  const viewport = parseViewport(raw['viewport'])
  if (viewport !== undefined) context.viewport = viewport

  const elements = parseElements(raw['elements'])
  if (elements !== undefined) context.elements = elements

  return context
}

function parseLoc(value: unknown): SelectionLoc | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const file = safeFile(raw['file'])
  const point = parsePoint(raw)
  if (file === undefined || point === undefined) return undefined
  const kind = raw['kind']
  return {
    file,
    line: point.line,
    column: point.column,
    kind: typeof kind === 'string' && LOC_KINDS.has(kind) ? (kind as SelectionLoc['kind']) : 'element',
  }
}

function parsePoint(value: unknown): { file: string; line: number; column: number } | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const file = safeFile(raw['file'])
  const line = raw['line']
  const column = raw['column']
  if (file === undefined) return undefined
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) return undefined
  if (typeof column !== 'number' || !Number.isInteger(column) || column <= 0) return undefined
  return { file, line, column }
}

/**
 * 文件路径只接受应用内的相对路径。
 * 这不是洁癖：`loc` 会被原样塞进 Agent 的上下文，`file: '../../../tenon.db'`
 * 就是一条"去读平台库"的指令注入。
 */
function safeFile(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const file = value.trim()
  if (file === '' || file.length > 300) return undefined
  if (file.startsWith('/') || file.startsWith('~')) return undefined
  if (file.includes('..') || file.includes('\\') || file.includes(':')) return undefined
  if (file.includes('\u0000')) return undefined
  return file
}

function parseRect(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const numbers = ['x', 'y', 'width', 'height'] as const
  const out: Record<string, number> = {}
  for (const key of numbers) {
    const n = raw[key]
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
    out[key] = n
  }
  return {
    x: out['x'] as number,
    y: out['y'] as number,
    width: out['width'] as number,
    height: out['height'] as number,
  }
}

function parseViewport(
  value: unknown,
): { width: number; height: number; dpr: number } | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const { width, height, dpr } = raw
  if (typeof width !== 'number' || typeof height !== 'number' || typeof dpr !== 'number') {
    return undefined
  }
  return { width, height, dpr }
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === 'string') out[key.slice(0, 60)] = item.slice(0, 200)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function parseElements(
  value: unknown,
): Array<{ selector: string; loc?: SelectionLoc }> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Array<{ selector: string; loc?: SelectionLoc }> = []
  for (const item of value) {
    const raw = asRecord(item)
    if (raw === undefined) continue
    const selector = raw['selector']
    if (typeof selector !== 'string' || selector === '') continue
    const loc = parseLoc(raw['loc'])
    out.push(loc === undefined ? { selector } : { selector, loc })
    // 上限是"有效条数"的上限：先过滤再截断，否则塞几条垃圾进去就能把真元素挤掉
    if (out.length >= 50) break
  }
  return out.length === 0 ? undefined : out
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 对话输入框上方那个上下文 chip 的文字 */
export function selectionLabel(selection: SelectionContext | null): string {
  if (selection === null) return ''
  if (selection.kind === 'region') {
    const count = selection.elements?.length ?? 0
    return count === 0 ? '已框选区域' : `已框选 ${String(count)} 个元素`
  }
  if (selection.loc !== undefined) {
    const tail = selection.loc.file.split('/').pop() ?? selection.loc.file
    const hint = selection.loc.kind === 'component-impl' ? ' · 组件库' : ''
    return `${tail}:${String(selection.loc.line)}${hint}`
  }
  return selection.selector ?? '已选中元素'
}
