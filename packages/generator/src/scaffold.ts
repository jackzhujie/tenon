/**
 * 把模板铺进应用仓库。
 *
 * 调用时机在 `AppStore.create` 里：目录已建、`.gitignore` 已写、**还没 initRepo**。
 * 所以铺模板和首次提交是同一个动作，应用从第一个 commit 起就是完整可跑的，
 * 不会出现"先有一条空提交、再有一条模板提交"这种让人以为改坏了的历史。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TenonError } from '@tenon/protocol'
import { renderTemplate } from './render.js'
import { loadTemplate } from './registry.js'

export interface ScaffoldInput {
  /** 应用仓库目录（`apps/<id>/repo`） */
  readonly repoDir: string
  readonly appId: string
  readonly appName: string
  readonly appSlug: string
  readonly templateId?: string
  readonly env?: NodeJS.ProcessEnv
  /** 已经铺过模板时是否覆盖。默认 false —— 重铺会把用户/Agent 的改动冲掉 */
  readonly force?: boolean
}

export interface ScaffoldResult {
  readonly templateId: string
  /** 相对路径（`/` 分隔） */
  readonly files: readonly string[]
  /** 预览默认打开的相对路径 */
  readonly entry: string | null
}

export const DEFAULT_TEMPLATE = 'react-vite'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function scaffoldApp(input: ScaffoldInput): Promise<ScaffoldResult> {
  const templateId = input.templateId ?? DEFAULT_TEMPLATE
  const env = input.env ?? process.env
  const { manifest, files, root } = await loadTemplate(templateId, env)

  if (files.length === 0) {
    return { templateId, files: [], entry: manifest.entry ?? null }
  }

  // 只认 package.json 作为"已经铺过"的标记：空目录、只有 README 的目录都还能铺
  if (input.force !== true && (await exists(join(input.repoDir, 'package.json')))) {
    throw new TenonError(
      'TEMPLATE_DIR_NOT_EMPTY',
      `这个工作区已经有 package.json 了（模板 ${templateId}）：${input.repoDir}`,
      { repoDir: input.repoDir, templateId },
    )
  }

  const vars = new Map<string, string>([
    ['appId', input.appId],
    ['appName', input.appName],
    ['appSlug', input.appSlug],
  ])
  const missing = (manifest.variables ?? []).filter((name) => !vars.has(name))
  if (missing.length > 0) {
    throw new TenonError('TEMPLATE_VAR_MISSING', `模板 ${templateId} 声明的变量没有值：${missing.join(', ')}`, {
      templateId,
      variables: missing,
    })
  }

  for (const rel of files) {
    const source = await readFile(join(root, rel), 'utf8')
    const rendered = renderTemplate(source, Object.fromEntries(vars), `${templateId}/${rel}`)
    const target = join(input.repoDir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, rendered, 'utf8')
  }

  return { templateId, files, entry: manifest.entry ?? null }
}
