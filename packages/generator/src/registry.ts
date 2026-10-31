/**
 * 模板仓库：`packages/generator/templates/<id>/`。
 *
 * 模板是**真实文件**而不是写在 TS 里的字符串常量。理由：
 * - 编辑器能直接给 `index.html` / `tsconfig.json` / `.tsx` 语法高亮与补全，写模板不用靠脑补
 * - 改模板就是改文件，diff 一眼看得懂；塞进字符串字面量之后，缩进和转义会成为新的 bug 源
 *
 * 代价是**发布时要带上这个目录**（Electron 打包的 extraResources）。所以留了
 * `TENON_TEMPLATES_DIR` 覆盖：打包版把模板放到 asar 外面，指过去即可。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TenonError } from '@tenon/protocol'

export interface TemplateManifest {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** 相对路径：预览默认打开哪个文件（`index.html`） */
  readonly entry?: string
  /** 需要调用方提供的变量名。缺一个就抛错，绝不让 `{{x}}` 漏进应用里 */
  readonly variables?: readonly string[]
  /** 给人看的说明（为什么不引 Tailwind 之类），也会进 `template.list` */
  readonly notes?: readonly string[]
  /** 额外的忽略名单（相对路径前缀） */
  readonly skip?: readonly string[]
}

export interface TemplateSummary {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly entry: string | null
  readonly variables: readonly string[]
  readonly notes: readonly string[]
  /** 模板会写进仓库的文件（相对路径，已排序） */
  readonly files: readonly string[]
}

/** 模板自身的东西，永远不写进应用 */
const ALWAYS_SKIP = new Set(['template.json', 'node_modules', 'dist', '.DS_Store', '.git'])

export function templatesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['TENON_TEMPLATES_DIR']
  if (override !== undefined && override !== '') return resolve(override)
  // src/registry.ts → ../templates（源目录布局；打包版走上面的覆盖）
  return resolve(fileURLToPath(new URL('../templates', import.meta.url)))
}

async function walk(root: string, rel: string, skip: (rel: string) => boolean): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (ALWAYS_SKIP.has(entry.name) || skip(childRel)) continue
    if (entry.isDirectory()) out.push(...(await walk(root, childRel, skip)))
    else if (entry.isFile()) out.push(childRel)
  }
  return out
}

async function readManifestAt(root: string, id: string): Promise<TemplateManifest> {
  const file = join(root, id, 'template.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new TenonError('TEMPLATE_UNKNOWN', `没有这个模板：${id}`, { templateId: id, file })
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TenonError('TEMPLATE_UNKNOWN', `模板清单不是对象：${file}`, { templateId: id })
  }
  const manifest = parsed as TemplateManifest
  if (manifest.id !== id) {
    throw new TenonError('TEMPLATE_UNKNOWN', `模板目录名与清单 id 不一致：${id} ≠ ${manifest.id}`, {
      templateId: id,
      manifestId: manifest.id,
    })
  }
  return manifest
}

/** 模板会写进应用的所有文件（相对路径，`/` 分隔，已排序） */
export async function collectFiles(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const root = templatesRoot(env)
  const manifest = await readManifestAt(root, id)
  const prefixes = manifest.skip ?? []
  const skip = (rel: string): boolean =>
    prefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))
  const files = await walk(join(root, id), '', skip)
  return files.sort()
}

export async function loadTemplate(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ manifest: TemplateManifest; files: string[]; root: string }> {
  const root = templatesRoot(env)
  const manifest = await readManifestAt(root, id)
  const files = await collectFiles(id, env)
  return { manifest, files, root: join(root, id) }
}

export async function listTemplates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TemplateSummary[]> {
  const root = templatesRoot(env)
  const entries = await readdir(root, { withFileTypes: true })
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const out: TemplateSummary[] = []
  for (const id of ids.sort()) {
    const { manifest, files } = await loadTemplate(id, env)
    out.push({
      id: manifest.id,
      label: manifest.label,
      description: manifest.description ?? '',
      entry: manifest.entry ?? null,
      variables: manifest.variables ?? [],
      notes: manifest.notes ?? [],
      files,
    })
  }
  return out
}
