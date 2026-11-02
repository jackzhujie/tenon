/**
 * 插件清单 `manifest.json` —— 一个组件对外的"身份证"。
 *
 * 字段在 M5 就定死（DESIGN §21.4）：Phase 1 全是 `source: "bundled"`、`signature: null`，
 * 但字段本身照填。这样 M6 上线 Hub、M7 开第三方时，加载器与界面不用改结构，
 * 只多一个校验步骤。
 *
 * 这里做的是**清单本身**的校验（字段、取值、路径合法性）。「装上能不能跑」——
 * 版本能不能解析、槽位有没有声明、宿主版本够不够 —— 在 `plan.ts`，因为那需要
 * 装配声明与磁盘上的真实文件。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ComponentPricing, ComponentSource } from '@tenon/protocol'
import { findSlot } from './slots.js'

/** 反向域名式的 id：`tenon.official.ai-assistant` */
export const COMPONENT_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 权限目录。**只认这几个** —— 清单里写一个我们不认识的权限，等于用户以为
 * "它只能读库"，而代码里它其实能随便联网。不认识就报错，不静默忽略。
 *
 * `net:fetch` 不限域名；`net:fetch:<host>` 限定单个域名（可带端口）。
 */
export const PERMISSIONS = ['fs:app', 'db:read', 'db:write', 'net:fetch'] as const

const NET_FETCH_HOST_RE = /^net:fetch:[a-z0-9.*-]+(?:\.[a-z0-9-]+)*(?::\d+)?$/i

export function isKnownPermission(permission: string): boolean {
  return (PERMISSIONS as readonly string[]).includes(permission) || NET_FETCH_HOST_RE.test(permission)
}

/** facet 入口文件（相对清单目录）。三个宿主位置各一个，都能没有，但不能全都 */
export const ComponentFacets = z.object({
  server: z.string().min(1).optional(),
  web: z.string().min(1).optional(),
  worker: z.string().min(1).optional(),
})
export type ComponentFacets = z.infer<typeof ComponentFacets>

export const ComponentManifest = z.object({
  id: z.string().regex(COMPONENT_ID_RE, 'id 要写成反向域名，例如 tenon.official.ai-assistant'),
  name: z.string().min(1),
  version: z.string().regex(SEMVER_RE, 'version 要写成 1.2.3'),
  description: z.string().min(1),
  /** 与所在根目录一致：bundled 根里只能有 `bundled`，hub 根里只能有 `hub`（plan 里查）*/
  source: ComponentSource,
  minTenonVersion: z.string().regex(SEMVER_RE, 'minTenonVersion 要写成 1.2.3'),
  /** Phase 1 恒为 null；hub 来源必须有（plan 里拦）*/
  signature: z.string().nullable().default(null),
  permissions: z.array(z.string().min(1)).default([]),
  /** 必填：安装时写进应用的 AGENTS.md，否则 Agent 会绕过或改坏组件 */
  agentHints: z.string().min(1),
  pricing: ComponentPricing.default({ type: 'free' }),
  facets: ComponentFacets,
  /** 允许被装在哪些插槽（装配声明挂了别的插槽 → plan 报 `slot-not-declared`）*/
  slots: z.array(z.string().min(1)).default([]),
  /** 组件之间的依赖：id → 版本区间。被依赖的组件必须先装配 */
  dependencies: z.record(z.string(), z.string()).default({}),
})
export type ComponentManifest = z.infer<typeof ComponentManifest>

export function manifestFile(dir: string): string {
  return join(dir, 'manifest.json')
}

/** 清单里的相对路径不能跑出插件目录 —— 否则一个清单就能让宿主读到任意文件 */
function isInsideRelative(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false
  return !path.split(/[\\/]/).some((segment) => segment === '..')
}

export interface ParsedManifest {
  readonly manifest: ComponentManifest | null
  readonly issues: readonly string[]
}

/**
 * 校验一份清单（已经是 JSON 反序列化后的对象）。
 *
 * 不抛异常：清单坏了不是崩溃，是一条要显示给用户的 problem（"这个组件装不上，因为…"）。
 */
export function parseManifest(raw: unknown): ParsedManifest {
  const parsed = ComponentManifest.safeParse(raw)
  if (!parsed.success) {
    return {
      manifest: null,
      issues: parsed.error.issues.map((issue) => {
        const where = issue.path.join('.')
        return where === '' ? issue.message : `${where}：${issue.message}`
      }),
    }
  }
  const manifest = parsed.data
  const issues: string[] = []

  for (const [host, path] of Object.entries(manifest.facets)) {
    if (path !== undefined && !isInsideRelative(path)) {
      issues.push(`facets.${host}：「${path}」必须是插件目录内的相对路径`)
    }
  }

  for (const permission of manifest.permissions) {
    if (!isKnownPermission(permission)) {
      issues.push(
        `permissions：「${permission}」不是已知权限（可用：${PERMISSIONS.join(' / ')} / net:fetch:<域名>）`,
      )
    }
  }

  if (manifest.permissions.length !== new Set(manifest.permissions).size) {
    issues.push('permissions：有重复项')
  }

  for (const slot of manifest.slots) {
    if (findSlot(slot) === undefined) {
      issues.push(`slots：「${slot}」不是已知插槽`)
    }
  }

  if (manifest.slots.length !== new Set(manifest.slots).size) {
    issues.push('slots：有重复项')
  }

  if (manifest.source === 'local' && manifest.signature !== null) {
    issues.push('local 来源的组件不该有 signature')
  }

  return { manifest: issues.length === 0 ? manifest : null, issues }
}

export type ManifestRead =
  | { readonly kind: 'ok'; readonly manifest: ComponentManifest; readonly file: string }
  | { readonly kind: 'missing'; readonly file: string }
  /** 文件在但读不出来/不合法。`issues` 直接给用户看 */
  | { readonly kind: 'invalid'; readonly file: string; readonly issues: readonly string[] }

export async function readManifest(dir: string): Promise<ManifestRead> {
  const file = manifestFile(dir)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', file }
    return {
      kind: 'invalid',
      file,
      issues: [`读不到清单：${error instanceof Error ? error.message : String(error)}`],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (error) {
    return {
      kind: 'invalid',
      file,
      issues: [`manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const { manifest, issues } = parseManifest(raw)
  if (manifest === null) return { kind: 'invalid', file, issues }
  return { kind: 'ok', manifest, file }
}
