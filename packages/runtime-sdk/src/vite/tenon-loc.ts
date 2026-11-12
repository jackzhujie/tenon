/**
 * 编译期源码定位注入（Babel 插件，DESIGN §10.1）—— 让 inspector 能把「用户点中的那个 DOM」
 * 反查回「源码里的哪一行」。
 *
 * 两条注入规则，解决「组合组件把定位带偏」：
 *  1. 原生标签（`div` / `button` / `span`…）→ `data-tenon-loc="src/App.tsx:12:5"`，DOM 上真实存在
 *  2. 组合组件（`<Button>` / `<Card>`…）→ `data-tenon-callsite="src/pages/a.tsx:13:9"`，
 *     靠组件自己的 `{...props}` 透传到最终 DOM。点击时 **callsite 优先** —— 用户想改的是
 *     "我在这一页这样用了它"，不是组件库的实现文件（`loc` 作为 secondary 一并交给 Agent）。
 *
 * 为什么这个文件**零依赖**：它由 `sync-templates.mjs` 拷进生成应用（源码分发），
 * 而 `@vitejs/plugin-react` 自带 Babel、应用里并没有 `@babel/core` 的类型定义。
 * 所以 AST 形状在本地声明 + 运行时校验，一个 babel 包都不 import。
 *
 * 决策逻辑单独抽成 `decideInjection()`：不依赖 Babel 就能测（`test/loc-plugin.test.ts`），
 * 真正的接线由 `pnpm e2e:preview` 断言「Vite 吐出来的 JS 里有这个属性」来证。
 */
import { relative, sep } from 'node:path'

export type TenonLocOptions = {
  /** 应用根目录的绝对路径；传 `import.meta.dirname`（vite.config 所在目录） */
  appRoot: string
  /** 视为「组件库实现」的相对目录前缀：命中时不标 callsite（标了只会把用户引去实现文件） */
  libraryDirs?: readonly string[]
}

export type LocInjection = {
  attribute: 'data-tenon-loc' | 'data-tenon-callsite'
  value: string
}

export type LocDecisionInput = {
  filename: string
  appRoot: string
  /** JSX 标签名，成员表达式形如 `Card.Header` */
  tag: string
  /** 1 起（Babel 的 `loc.start.line` 本身就是 1 起） */
  line: number
  /** 1 起（调用方负责把 Babel 的 0 起列号 +1） */
  column: number
  /** 已存在的属性名，用来避开重复注入 */
  existing?: readonly string[]
  libraryDirs?: readonly string[]
}

/** 不是"用户写的那一行"的组件：它们自己不渲染宿主元素，标了也没意义 */
const SKIP_TAGS = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler', 'Provider', 'Consumer'])

export const DEFAULT_LIBRARY_DIRS: readonly string[] = ['src/components/ui/']

/** 纯逻辑：给定一个 JSX 开标签，算出该加哪个属性；返回 `undefined` 表示不注入 */
export function decideInjection(input: LocDecisionInput): LocInjection | undefined {
  const file = relativeToAppRoot(input.appRoot, input.filename)
  if (file === undefined) return undefined

  const { tag } = input
  if (tag === '') return undefined
  if (SKIP_TAGS.has(tag) || tag.endsWith('.Provider') || tag.endsWith('.Consumer')) return undefined

  // 小写首字母或带横杠 = 原生标签 / 自定义元素；其余按组件处理
  const isIntrinsic = tag === tag.toLowerCase() || tag.includes('-')
  const attribute = isIntrinsic ? 'data-tenon-loc' : 'data-tenon-callsite'
  if (input.existing?.includes(attribute) === true) return undefined

  const libraryDirs = input.libraryDirs ?? DEFAULT_LIBRARY_DIRS
  if (!isIntrinsic && libraryDirs.some((dir) => file.startsWith(dir))) return undefined

  return { attribute, value: `${file}:${input.line}:${input.column}` }
}

/** 相对路径按 `/` 归一（Windows 上 `relative()` 给的是 `\`）；不在 appRoot 内返回 undefined */
export function relativeToAppRoot(appRoot: string, filename: string): string | undefined {
  // Vite 的模块 id 偶尔带 `?v=xxx` 查询串（真实文件不会有 '?'），不带进来否则定位值会污染
  const withoutQuery = filename.split('?')[0] ?? filename
  const rel = relative(appRoot, withoutQuery).split(sep).join('/')
  if (rel === '' || rel.startsWith('..') || rel.includes('node_modules')) return undefined
  return rel
}

/** 校验插件选项：漏传 appRoot 会静默不注入，表现得像"插件没生效"，所以这里直接抛 */
export function readOptions(options: unknown): Required<TenonLocOptions> {
  const raw: Partial<TenonLocOptions> =
    typeof options === 'object' && options !== null ? (options as Partial<TenonLocOptions>) : {}
  if (typeof raw.appRoot !== 'string' || raw.appRoot === '') {
    throw new Error(
      'tenon-loc: the appRoot option is required. In vite.config.ts use { appRoot: import.meta.dirname }',
    )
  }
  return { appRoot: raw.appRoot, libraryDirs: raw.libraryDirs ?? DEFAULT_LIBRARY_DIRS }
}

export type TenonLocPlugin = {
  name: string
  visitor: Record<string, (path: unknown, state: unknown) => void>
}

/**
 * Babel 插件工厂。签名是 `(api, options)` —— 不是"接收选项的单参函数"，
 * 所以模板里写成 `[[tenonLoc, { appRoot }]]`（元组形式），别写成 `tenonLoc({ appRoot })`。
 */
export default function tenonLoc(_api: unknown, options: unknown): TenonLocPlugin {
  const config = readOptions(options)

  return {
    name: 'tenon-loc',
    visitor: {
      JSXOpeningElement(path: unknown, state: unknown): void {
        const filename = filenameOf(state)
        if (filename === undefined) return

        const node = field(path, 'node')
        const tag = tagNameOf(field(node, 'name'))
        if (tag === undefined) return
        const start = locStart(field(node, 'loc'))
        if (start === undefined) return

        const attributes = field(node, 'attributes')
        const decision = decideInjection({
          filename,
          appRoot: config.appRoot,
          tag,
          line: start.line,
          column: start.column + 1,
          existing: attributeNames(attributes),
          libraryDirs: config.libraryDirs,
        })
        if (decision === undefined) return
        if (!Array.isArray(attributes)) return

        attributes.push(jsxStringAttribute(decision.attribute, decision.value))
      },
    },
  }
}

function filenameOf(state: unknown): string | undefined {
  const filename = field(state, 'filename')
  return typeof filename === 'string' && filename !== '' ? filename : undefined
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function tagNameOf(name: unknown): string | undefined {
  const type = field(name, 'type')
  if (type === 'JSXIdentifier') {
    const value = field(name, 'name')
    return typeof value === 'string' ? value : undefined
  }
  if (type === 'JSXMemberExpression') {
    const object = field(field(name, 'object'), 'name')
    const property = field(field(name, 'property'), 'name')
    if (typeof object !== 'string' || typeof property !== 'string') return undefined
    return `${object}.${property}`
  }
  // JSXNamespacedName（`<svg:rect>`）不处理：生成的应用里不会出现
  return undefined
}

function locStart(loc: unknown): { line: number; column: number } | undefined {
  const start = field(loc, 'start')
  const line = field(start, 'line')
  const column = field(start, 'column')
  if (typeof line !== 'number' || typeof column !== 'number') return undefined
  return { line, column }
}

function attributeNames(attributes: unknown): string[] {
  if (!Array.isArray(attributes)) return []
  const names: string[] = []
  for (const attribute of attributes) {
    if (field(attribute, 'type') !== 'JSXAttribute') continue
    const name = field(field(attribute, 'name'), 'name')
    if (typeof name === 'string') names.push(name)
  }
  return names
}

/** 直接拼节点对象即可：Babel 接受"手工构造的普通对象"，无需 @babel/types */
function jsxStringAttribute(name: string, value: string): Record<string, unknown> {
  return {
    type: 'JSXAttribute',
    name: { type: 'JSXIdentifier', name },
    value: { type: 'StringLiteral', value },
  }
}
