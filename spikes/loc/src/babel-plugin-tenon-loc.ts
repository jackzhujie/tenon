/**
 * tenon-inspector 的 Babel 插件（DESIGN §10.1）。
 *
 * 两条注入规则，解决「组合组件把定位带偏」的问题：
 *  1. 原生标签（div / button / span…）→ data-tenon-loc="file:line:col"，DOM 上真实存在
 *  2. 组合组件（<Button>、<Card>…）→ data-tenon-callsite="file:line:col"，靠组件的 {...props}
 *     透传到 DOM；点击时 callsite 优先于 loc（用户想改的是"我在这里用了它"，不是组件实现）
 *
 * 只处理 app 源码目录内的文件；node_modules / ui 库目录内的实现不注入 callsite。
 */
import { relative, sep } from 'node:path'
import type { NodePath, PluginAPI, PluginObject, PluginPass } from '@babel/core'
import type { JSXAttribute, JSXOpeningElement } from '@babel/types'

export type TenonLocOptions = {
  /** 应用源码根目录的绝对路径 */
  appRoot: string
  /** 视为"组件库实现"的相对目录前缀，命中时不注入 callsite */
  libraryDirs?: string[]
}

const SKIP_COMPONENTS = new Set([
  'Fragment',
  'Suspense',
  'StrictMode',
  'Profiler',
  'Provider',
  'Consumer',
  'TelemetryProvider',
])

function tagNameOf(node: JSXOpeningElement): string | undefined {
  const name = node.name
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXMemberExpression') {
    const obj = name.object.type === 'JSXIdentifier' ? name.object.name : ''
    return `${obj}.${name.property.name}`
  }
  return undefined
}

function hasAttr(node: JSXOpeningElement, name: string): boolean {
  return node.attributes.some(
    (a) => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name,
  )
}

function makeAttr(name: string, value: string): JSXAttribute {
  return {
    type: 'JSXAttribute',
    name: { type: 'JSXIdentifier', name },
    value: { type: 'StringLiteral', value },
  } as JSXAttribute
}

export default function tenonLoc(_api: PluginAPI, options: object): PluginObject {
  const { appRoot, libraryDirs = ['src/components/ui/'] } = options as TenonLocOptions

  // Babel 8 的 visitor 类型要求 `{ enter }` 形状，与常见写法不兼容；内部逻辑照常强类型，
  // 只在这一处把边界放宽，避免整个插件退化成 any。
  const visitor = {
      JSXOpeningElement(path: NodePath<JSXOpeningElement>, state: PluginPass) {
        const filename = state.filename
        if (filename === undefined) return
        const loc = path.node.loc
        if (loc === null || loc === undefined) return

        const rel = relative(appRoot, filename).split(sep).join('/')
        if (rel.startsWith('..') || rel.includes('node_modules')) return

        const tag = tagNameOf(path.node)
        if (tag === undefined) return
        if (SKIP_COMPONENTS.has(tag) || tag.endsWith('.Provider') || tag.endsWith('.Consumer')) return

        const isIntrinsic = tag === tag.toLowerCase() || tag.includes('-')
        const attrName = isIntrinsic ? 'data-tenon-loc' : 'data-tenon-callsite'
        if (hasAttr(path.node, attrName)) return

        // 组件库内部实现不标 callsite（它的调用点是别的组件/页面，标了反而更乱）
        if (!isIntrinsic && libraryDirs.some((d) => rel.startsWith(d))) return

        const value = `${rel}:${loc.start.line}:${loc.start.column + 1}`
        path.node.attributes.push(makeAttr(attrName, value))
      },
  }

  return { name: 'tenon-loc', visitor: visitor as PluginObject['visitor'] }
}
