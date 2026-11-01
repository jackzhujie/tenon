/**
 * 注入到生成应用里的 inspector（DESIGN §10.1 / §10.2）。
 *
 * 交互（对齐主流设计工具的习惯，不占用常用快捷键）：
 * - **按住 Alt** 进入检查模式：光标变十字、鼠标下的元素描边 + 跟随标签（标签 · file:line）
 * - **Alt + 单击** 选中元素 → 组上下文 → `postMessage` 给父窗口
 * - **Alt + 拖拽** 框选区域 → 收集矩形内**最内层**的元素（最多 50 个）
 * - **ESC** 退出检查模式
 *
 * 三条硬约束（踩过的）：
 * 1. **overlay 必须 `pointer-events: none`** —— 否则鼠标永远命中高亮层，`event.target`
 *    永远是 overlay，什么都选不中。这不是样式细节，是功能前提。
 * 2. **选中那一下要在 capture 阶段吃掉** —— 生成的应用自己绑了 click（按钮会提交表单、
 *    链接会跳走），不 `preventDefault + stopPropagation` 就变成"点一下页面乱跳"。
 * 3. **只走 `event.target`，不用 `document.elementFromPoint`** —— 后者在 jsdom 里没有实现，
 *    而 target 是浏览器和测试环境都有的东西。
 *
 * 与 `tenon-loc-plugin.ts` 配对：那边编译期写 `data-tenon-loc`，这边运行时读。
 * 本文件与 `tenon-loc.ts` 都是**源码分发**进模板的，所以同样不 import 任何平台包。
 */
import { resolveTarget } from './tenon-loc.js'
import type { ElementLike } from './tenon-loc.js'

export type LocPayload = {
  file: string
  line: number
  column: number
  kind: 'usage' | 'element' | 'component-impl'
}

export type SelectionPayload = {
  kind: 'element' | 'region'
  route: string
  loc?: LocPayload
  /** callsite 命中时组件实现的位置 */
  impl?: { file: string; line: number; column: number }
  selector?: string
  rect?: { x: number; y: number; width: number; height: number }
  text?: string
  styles?: Record<string, string>
  elements?: Array<{ selector: string; loc?: LocPayload }>
  viewport?: { width: number; height: number; dpr: number }
}

export type InspectorOptions = {
  /** 父窗口发来的一次性 token（默认从 `location.hash` 读）；没有就不发消息 */
  token?: string
  /** 选中回调（自测/调试用） */
  onSelect?: (context: SelectionPayload) => void
}

/** 消息信封：父窗口靠 `source` + `token` 双重确认，`origin` 由父窗口自己比 */
export type InspectorMessage = {
  source: 'tenon-inspector'
  token: string
  context: SelectionPayload
}

export const MESSAGE_SOURCE = 'tenon-inspector'
export const HASH_KEY = 'tenon-inspector'
const OVERLAY_ATTR = 'data-tenon-inspector'
const MAX_TEXT = 500
const MAX_REGION_ELEMENTS = 50
/** 拖拽超过这个距离才算"框选"，否则当单击（手抖 2px 不该变成框选） */
const DRAG_THRESHOLD = 6

const Z = '2147483647'

type Rect = { x: number; y: number; width: number; height: number }

/** 只比与父级**不同**的那几个关键样式：整份 computed style 是几百个键，纯噪声 */
const STYLE_KEYS = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'padding',
  'margin',
  'border-radius',
  'display',
  'gap',
  'text-align',
] as const

/**
 * 幂等守卫：重复调用不会再叠一层 overlay 与监听器。
 * 会出现这种情况的场景是热更新（模块被重新求值）和调试时手动再装一次 ——
 * 叠了的表现是"点一下发两条消息"，很费解。
 */
const installed = new WeakSet<Window>()

export function installTenonInspector(options: InspectorOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  // 独立标签页打开（`window.parent === window`）时没有父窗口，装了也没人收消息
  if (window.parent === window) return () => {}
  if (installed.has(window)) return () => {}

  const token = options.token ?? readTokenFromHash()
  if (token === '') return () => {}

  const overlay = createOverlay()
  let active = false
  let dragging = false
  let suppressClick = false
  let dragStart: { x: number; y: number } | null = null

  const body = document.body
  const previousCursor = body.style.cursor

  function setActive(next: boolean): void {
    active = next
    body.style.cursor = next ? 'crosshair' : previousCursor
    if (!next) {
      overlay.hide()
      dragging = false
      dragStart = null
    }
  }

  function elementOf(event: Event): Element | null {
    const target = event.target
    if (!(target instanceof Element)) return null
    // overlay 自身（理论上 pointer-events:none 挡掉了，这里再兜一道）
    if (target.closest(`[${OVERLAY_ATTR}]`) !== null) return null
    return target
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Alt') setActive(true)
    if (event.key === 'Escape' && active) {
      setActive(false)
      event.preventDefault()
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Alt' && !dragging) setActive(false)
  }

  function onPointerDown(event: PointerEvent): void {
    if (!active || !event.altKey) return
    dragging = false
    dragStart = { x: event.clientX, y: event.clientY }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!active) return

    if (dragStart !== null) {
      const moved =
        Math.abs(event.clientX - dragStart.x) > DRAG_THRESHOLD ||
        Math.abs(event.clientY - dragStart.y) > DRAG_THRESHOLD
      if (moved) {
        dragging = true
        overlay.showBand(bandRect(dragStart, { x: event.clientX, y: event.clientY }))
      }
    }

    if (dragging) return

    const element = elementOf(event)
    if (element === null) {
      overlay.hide()
      return
    }
    overlay.showElement(element, labelOf(element))
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragStart === null) return
    const start = dragStart
    dragStart = null

    if (!dragging) return
    dragging = false
    // 拖完浏览器还会补一个 click，必须吃掉，否则"框选完页面自己点了一下"
    suppressClick = true
    setTimeout(() => {
      suppressClick = false
    }, 0)

    const region = bandRect(start, { x: event.clientX, y: event.clientY })
    overlay.hide()
    const context = buildRegionContext(region)
    if (context !== undefined) emit(context)
  }

  function onClick(event: MouseEvent): void {
    if (!active) return
    if (suppressClick) {
      swallow(event)
      return
    }
    const element = elementOf(event)
    if (element === null) return
    swallow(event)
    emit(buildElementContext(element))
  }

  function swallow(event: Event): void {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  function emit(context: SelectionPayload): void {
    const message: InspectorMessage = { source: MESSAGE_SOURCE, token, context }
    // targetOrigin 只能是 `*`：子页面在网关源上，父窗口在平台源上，跨源且子不知道父是谁。
    // 防的是"别人伪造"，所以父窗口侧必须校验 origin + token（见 apps/web/src/lib/selection.ts）
    window.parent.postMessage(message, '*')
    options.onSelect?.(context)
  }

  installed.add(window)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('click', onClick, true)

  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('click', onClick, true)
    setActive(false)
    overlay.destroy()
    installed.delete(window)
  }
}

/** `#tenon-inspector=<token>`；父窗口用 iframe 的 hash 传，不走 query（query 会进访问日志） */
export function readTokenFromHash(hash = window.location.hash): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw === '') return ''
  for (const pair of raw.split('&')) {
    const [key, value = ''] = pair.split('=')
    if (key === HASH_KEY) return decodeURIComponent(value)
  }
  return ''
}

// ---------------------------------------------------------------- 上下文组装

export function buildElementContext(element: Element): SelectionPayload {
  const resolution = resolveTarget(element as unknown as ElementLike)
  const rect = element.getBoundingClientRect()
  return {
    kind: 'element',
    route: routeOf(),
    loc: resolution?.primary,
    impl: resolution?.secondary,
    selector: buildSelector(element),
    rect: roundRect(rect),
    text: clampText(element.textContent ?? ''),
    styles: styleDiff(element),
    viewport: viewportOf(),
  }
}

export function buildRegionContext(region: Rect): SelectionPayload | undefined {
  const picked = pickRegionElements(region)
  if (picked.length === 0) return undefined
  return {
    kind: 'region',
    route: routeOf(),
    rect: roundRect(region),
    elements: picked.map((element) => {
      const resolution = resolveTarget(element as unknown as ElementLike)
      return {
        selector: buildSelector(element),
        ...(resolution === undefined ? {} : { loc: resolution.primary }),
      }
    }),
    viewport: viewportOf(),
  }
}

/**
 * 框选里"该给 Agent 看"的元素：只留最内层。
 * 留下 `<main>` 这种容器没有意义 —— Agent 拿到 20 个祖先链只会把改动面搞得更大。
 */
export function pickRegionElements(
  region: Rect,
  root: ParentNode = document,
): Element[] {
  const candidates: Element[] = []
  for (const element of Array.from(root.querySelectorAll('body *'))) {
    if (element.closest(`[${OVERLAY_ATTR}]`) !== null) continue
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    if (!intersects(rect, region)) continue
    candidates.push(element)
  }

  const innermost = candidates.filter(
    (element) => !candidates.some((other) => other !== element && element.contains(other)),
  )
  return innermost.slice(0, MAX_REGION_ELEMENTS)
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

function bandRect(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function routeOf(): string {
  return `${window.location.pathname}${window.location.hash}`
}

function viewportOf(): { width: number; height: number; dpr: number } {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }
}

function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export function clampText(raw: string, max = MAX_TEXT): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}

export function styleDiff(element: Element): Record<string, string> {
  const view = element.ownerDocument.defaultView
  if (view === null) return {}
  const own = view.getComputedStyle(element)
  const parent = element.parentElement
  const parentStyle = parent === null ? null : view.getComputedStyle(parent)
  const diff: Record<string, string> = {}
  for (const key of STYLE_KEYS) {
    const value = own.getPropertyValue(key)
    if (value === '' || value === parentStyle?.getPropertyValue(key)) continue
    diff[key] = value
  }
  return diff
}

/** 选择器只是给人看的线索，**权威定位永远是 `loc`**（Tailwind 类名会变、会被 Agent 改） */
export type SelectorNode = {
  tagName: string
  id?: string
  className?: unknown
  parentElement: SelectorNode | null
}

export function buildSelector(node: SelectorNode, depth = 3): string {
  const parts: string[] = []
  let current: SelectorNode | null = node
  let level = 0
  while (current !== null && level < depth) {
    const tag = current.tagName.toLowerCase()
    const id = typeof current.id === 'string' ? current.id : ''
    if (id !== '') {
      parts.unshift(`${tag}#${id}`)
      break
    }
    const classes = classesOf(current)
    parts.unshift(classes.length === 0 ? tag : `${tag}.${classes.join('.')}`)
    current = current.parentElement
    level += 1
  }
  return parts.join(' > ')
}

function classesOf(node: SelectorNode): string[] {
  const raw = node.className
  const text = typeof raw === 'string' ? raw : ''
  return text
    .split(/\s+/)
    .filter((name) => name !== '')
    .slice(0, 2)
}

function labelOf(element: Element): string {
  const resolution = resolveTarget(element as unknown as ElementLike)
  const tag = element.tagName.toLowerCase()
  if (resolution === undefined) return tag
  return `${tag} · ${resolution.primary.file}:${resolution.primary.line}`
}

// ---------------------------------------------------------------- overlay

function createOverlay(): {
  showElement(element: Element, label: string): void
  showBand(rect: Rect): void
  hide(): void
  destroy(): void
} {
  const box = document.createElement('div')
  const label = document.createElement('div')
  const band = document.createElement('div')

  applyStyle(box, {
    position: 'fixed',
    border: '2px solid #ff7a45',
    background: 'rgba(255, 122, 69, 0.12)',
    // ★ 这一行是功能前提：没有它，鼠标永远命中 overlay 自己
    pointerEvents: 'none',
    zIndex: Z,
    boxSizing: 'border-box',
    transition: 'all 40ms linear',
    display: 'none',
  })
  applyStyle(label, {
    position: 'fixed',
    padding: '2px 6px',
    borderRadius: '4px',
    background: '#1d1b19',
    color: '#ffb08a',
    font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
    pointerEvents: 'none',
    zIndex: Z,
    whiteSpace: 'nowrap',
    display: 'none',
  })
  applyStyle(band, {
    position: 'fixed',
    border: '1px dashed #ff7a45',
    background: 'rgba(255, 122, 69, 0.08)',
    pointerEvents: 'none',
    zIndex: Z,
    boxSizing: 'border-box',
    display: 'none',
  })

  for (const node of [box, label, band]) {
    node.setAttribute(OVERLAY_ATTR, '')
    document.body.appendChild(node)
  }

  const hide = (): void => {
    box.style.display = 'none'
    label.style.display = 'none'
    band.style.display = 'none'
  }

  return {
    showElement(element, text) {
      const rect = element.getBoundingClientRect()
      band.style.display = 'none'
      place(box, rect)
      place(label, { x: rect.x, y: rect.y - 20, width: rect.width, height: 16 })
      label.textContent = text
      label.style.display = 'block'
    },
    showBand(rect) {
      box.style.display = 'none'
      label.style.display = 'none'
      place(band, rect)
    },
    hide,
    destroy() {
      for (const node of [box, label, band]) node.remove()
    },
  }

  function place(node: HTMLElement, rect: Rect): void {
    node.style.display = 'block'
    node.style.left = `${String(rect.x)}px`
    node.style.top = `${String(rect.y)}px`
    node.style.width = `${String(rect.width)}px`
    node.style.height = `${String(rect.height)}px`
  }
}

function applyStyle(node: HTMLElement, style: Record<string, string>): void {
  // `CSSStyleDeclaration` 是只读接口，逐键赋值的类型守卫在这儿没有收益
  const target = node.style as unknown as Record<string, string>
  for (const [key, value] of Object.entries(style)) target[key] = value
}
