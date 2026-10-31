/**
 * 运行时解析器：从被点中的 DOM 元素反查源码位置。
 * 这条逻辑最终会进 packages/runtime-sdk（注入到生成应用的 inspector）。
 */
export type LocTarget = {
  file: string
  line: number
  column: number
  /** usage = 用户写的那一行；component-impl = 组件库实现内部（改动影响全局）*/
  kind: 'usage' | 'element' | 'component-impl'
}

export type Resolution = {
  primary: LocTarget
  /** 同一节点上的另一层信息（callsite 命中时，附带组件实现位置）*/
  secondary?: LocTarget
  /** 命中的 DOM 节点标签 */
  tag: string
  /** 向上走了几层才找到 */
  hops: number
}

const LIBRARY_PREFIXES = ['src/components/ui/']

function parse(raw: string, kind: LocTarget['kind']): LocTarget | undefined {
  const parts = raw.split(':')
  if (parts.length < 3) return undefined
  const column = Number(parts.pop())
  const line = Number(parts.pop())
  const file = parts.join(':')
  if (!Number.isFinite(line) || !Number.isFinite(column)) return undefined
  return { file, line, column, kind }
}

export function resolveTarget(element: Element): Resolution | undefined {
  let hops = 0
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const callsite = node.getAttribute('data-tenon-callsite')
    const loc = node.getAttribute('data-tenon-loc')
    if (callsite !== null) {
      const primary = parse(callsite, 'usage')
      if (primary !== undefined) {
        const impl = loc === null ? undefined : parse(loc, 'component-impl')
        return { primary, secondary: impl, tag: node.tagName.toLowerCase(), hops }
      }
    }
    if (loc !== null) {
      const parsed = parse(loc, 'element')
      if (parsed !== undefined) {
        const isLibrary = LIBRARY_PREFIXES.some((p) => parsed.file.startsWith(p))
        return {
          primary: { ...parsed, kind: isLibrary ? 'component-impl' : 'element' },
          tag: node.tagName.toLowerCase(),
          hops,
        }
      }
    }
    hops += 1
  }
  return undefined
}
