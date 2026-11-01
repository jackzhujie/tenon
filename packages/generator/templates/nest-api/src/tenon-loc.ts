/**
 * 运行时解析器：从被点中的 DOM 元素反查源码位置（DESIGN §10.2）。
 *
 * 与编译期注入（`src/vite/tenon-loc.ts`）配对：那边写属性，这边读属性。
 * 只用到 `getAttribute` / `parentElement` / `tagName` 三样东西，所以
 * **测试不需要 jsdom**，构造几个假元素就够（`test/loc-resolve.test.ts`）。
 */

export type LocKind =
  /** 用户自己写的那一行（callsite 命中） */
  | 'usage'
  /** 页面里的原生标签 */
  | 'element'
  /** 组件库实现内部 —— 改动会影响全局，UI 上要提示 */
  | 'component-impl'

export type LocTarget = { file: string; line: number; column: number; kind: LocKind }

export type Resolution = {
  primary: LocTarget
  /** callsite 命中时附带组件实现位置，一起交给 Agent 判断影响面 */
  secondary?: LocTarget
  /** 命中的 DOM 标签（小写） */
  tag: string
  /** 向上走了几层才找到：0 = 点中的元素自己就带属性 */
  hops: number
}

/** `Element` 的结构子集：真实的 `Element` 天然满足，测试里用普通对象即可 */
export type ElementLike = {
  tagName: string
  getAttribute(name: string): string | null
  parentElement: ElementLike | null
}

export const LIBRARY_DIRS: readonly string[] = ['src/components/ui/']

/** `src/App.tsx:12:5` → `{ file, line, column }`；Windows 盘符里的冒号按"最后两段"切 */
export function parseLoc(raw: string, kind: LocKind): LocTarget | undefined {
  const parts = raw.split(':')
  if (parts.length < 3) return undefined
  const column = Number(parts.pop())
  const line = Number(parts.pop())
  const file = parts.join(':')
  if (file === '' || !Number.isInteger(line) || !Number.isInteger(column)) return undefined
  if (line <= 0 || column <= 0) return undefined
  return { file, line, column, kind }
}

export function resolveTarget(
  element: ElementLike,
  options: { libraryDirs?: readonly string[] } = {},
): Resolution | undefined {
  const libraryDirs = options.libraryDirs ?? LIBRARY_DIRS
  let hops = 0

  for (let node: ElementLike | null = element; node !== null; node = node.parentElement) {
    const tag = node.tagName.toLowerCase()

    const callsite = parseLoc(node.getAttribute('data-tenon-callsite') ?? '', 'usage')
    if (callsite !== undefined) {
      const impl = parseLoc(node.getAttribute('data-tenon-loc') ?? '', 'component-impl')
      return { primary: callsite, secondary: impl, tag, hops }
    }

    const loc = parseLoc(node.getAttribute('data-tenon-loc') ?? '', 'element')
    if (loc !== undefined) {
      const inLibrary = libraryDirs.some((dir) => loc.file.startsWith(dir))
      return { primary: { ...loc, kind: inLibrary ? 'component-impl' : 'element' }, tag, hops }
    }

    hops += 1
  }

  return undefined
}
