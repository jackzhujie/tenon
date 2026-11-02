/**
 * 装配声明 `app.components.json` —— **应用里有哪几个组件**，写在应用仓库里（跟着 git 走）。
 *
 * 三个刻意的设计：
 *
 * 1. **写在应用仓库而不是产品库**。装了什么组件是这个应用的一部分，回滚代码要能连带回滚
 *    组件装配；换台机器 clone 下来也该是同一套组件。
 * 2. **`enabled: false` 是"关掉"不是"卸载"**。插件页的开关只改这个字段，声明还在 ——
 *    这样"关掉试试"之后能一键开回来，而卸载（删声明 + 删生成代码）另走一条路。
 * 3. **结构校验在这里，语义校验在 `plan.ts`**。`slot` 写成 `z.string()` 而不是枚举，
 *    是故意的：一个槽位写错只该让**那一个**组件装不上，不该让整份声明解析失败、把
 *    别的组件一起变成"全没了"。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { TenonError } from '@tenon/protocol'

export const ASSEMBLY_FILE = 'app.components.json'

/**
 * 一处挂载。
 *
 * `order` 小的先渲染（同插槽里的排序），默认 100 —— 让后装的组件默认排在后面，
 * 不用每次都想"我要放第几个"。
 *
 * `prefix` 只对 `app.api` 有意义（`/_c/assistant` 这种）。
 */
export const ComponentMountSpec = z.object({
  slot: z.string().min(1),
  order: z.number().int().default(100),
  prefix: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/, 'prefix 要以 / 开头，例如 /_c/assistant')
    .optional(),
})
export type ComponentMountSpec = z.infer<typeof ComponentMountSpec>

export const ComponentEntry = z.object({
  id: z.string().min(1),
  /** 版本区间（`^1.2.0` / `*`）。解析与判满足在 plan 里 */
  version: z.string().min(1).default('*'),
  /** Phase 3 的授权标识；M5/M6 恒为 `free` */
  license: z.string().min(1).default('free'),
  enabled: z.boolean().default(true),
  mount: z.array(ComponentMountSpec).default([]),
})
export type ComponentEntry = z.infer<typeof ComponentEntry>

export const ComponentAssembly = z.object({
  /** 声明格式版本。加字段时靠它分辨"老声明"——不给默认值就不能悄悄升级格式 */
  version: z.literal(1).default(1),
  components: z.array(ComponentEntry).default([]),
})
export type ComponentAssembly = z.infer<typeof ComponentAssembly>

export function assemblyFile(repoDir: string): string {
  return join(repoDir, ASSEMBLY_FILE)
}

export function emptyAssembly(): ComponentAssembly {
  return { version: 1, components: [] }
}

export type AssemblyRead =
  | {
      readonly kind: 'ok'
      readonly assembly: ComponentAssembly
      readonly file: string
      /** 文件不存在 = 还没装任何组件（新应用都是这个状态），不是错误 */
      readonly exists: boolean
    }
  | { readonly kind: 'invalid'; readonly file: string; readonly issues: readonly string[] }

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.join('.')
    return where === '' ? issue.message : `${where}：${issue.message}`
  })
}

export async function readAssembly(repoDir: string): Promise<AssemblyRead> {
  const file = assemblyFile(repoDir)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', assembly: emptyAssembly(), file, exists: false }
    }
    return {
      kind: 'invalid',
      file,
      issues: [`读不到装配声明：${error instanceof Error ? error.message : String(error)}`],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    return {
      kind: 'invalid',
      file,
      issues: [
        `${ASSEMBLY_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  const parsed = ComponentAssembly.safeParse(raw)
  if (!parsed.success) return { kind: 'invalid', file, issues: issuesOf(parsed.error) }
  return { kind: 'ok', assembly: parsed.data, file, exists: true }
}

/**
 * 原子写：先写同目录的临时文件再 rename。
 *
 * 直接 `writeFile` 覆盖的话，写到一半断电/被杀，应用就带着一份**被截断的 JSON**
 * 启动 —— 那会被读成"装配声明坏了"，所有组件一起消失。rename 在同一文件系统上是原子的。
 */
export async function writeAssembly(repoDir: string, assembly: ComponentAssembly): Promise<string> {
  const parsed = ComponentAssembly.safeParse(assembly)
  if (!parsed.success) {
    throw new TenonError('VALIDATION_FAILED', '装配声明不合法，拒绝写入', {
      issues: issuesOf(parsed.error),
    })
  }
  const file = assemblyFile(repoDir)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return file
}

/** 装/改一个组件。同 id 已存在时**整条替换**（装配声明只有一个事实来源，不做字段合并）*/
export function upsertComponent(
  assembly: ComponentAssembly,
  entry: ComponentEntry,
): ComponentAssembly {
  const index = assembly.components.findIndex((c) => c.id === entry.id)
  const components = [...assembly.components]
  if (index === -1) components.push(entry)
  else components[index] = entry
  return { ...assembly, components }
}

export function removeComponent(assembly: ComponentAssembly, id: string): ComponentAssembly {
  return { ...assembly, components: assembly.components.filter((c) => c.id !== id) }
}
