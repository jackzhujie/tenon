/**
 * 给**已有应用**补一块能力（目前只有「加后端」）。
 *
 * 为什么不是"再铺一次模板"：
 * - 模板是「从零铺一份」，会写 package.json / vite.config.ts / src/App.tsx；
 *   在已有应用上重铺等于把用户与 Agent 写的代码冲掉。
 * - 用户装上之后真正的需求是「这个应用现在需要一个后端」，而不是「我想换个模板」。
 *
 * 所以这里做三件模板做不到的事：
 * 1. 只写**新文件**（`api/`、`shared/`、`src/api.ts`、`tsconfig.server.json`）
 * 2. package.json 只**补缺**（scripts / deps 已存在的一个都不覆盖），但 `tenon.api` 必写 ——
 *    那是平台判断"要不要起后端"的唯一事实来源
 * 3. 两处**就地改**：`tsconfig.json` 的 `include` 加 `shared`、`eslint.config.mjs` 忽略 `dist-server`，
 *    以及给 `docs/AGENTS.md` 加一节（否则 Agent 下一次改代码不知道有后端，很可能又用 localStorage
 *    存数据 —— 那不是"重复劳动"，是两套事实来源）
 *
 * 幂等：已经有 `tenon.api` 就什么都不做（返回 `applied: false`）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TenonError } from '@tenon/protocol'
import { renderTemplate } from './render.js'
import { loadTemplate } from './registry.js'

/** 功能包在模板目录里的名字（`hidden: true`，不会出现在建应用对话框） */
export const API_FEATURE = 'api-feature'

export interface ApplyApiFeatureInput {
  /** 应用仓库目录（`apps/<id>/repo`） */
  readonly repoDir: string
  readonly env?: NodeJS.ProcessEnv
}

export interface ApplyApiFeatureResult {
  readonly applied: boolean
  /** 没应用的原因（`already` = 本来就有后端） */
  readonly reason?: string
  /** 写进应用的文件（相对路径） */
  readonly files: readonly string[]
  /** 这次补上的 npm script 名 */
  readonly addedScripts: readonly string[]
  /** 这次补上的依赖名 */
  readonly addedDependencies: readonly string[]
  /** 需要人（或 Agent）知道一句的事：就地改失败、版本冲突之类 */
  readonly notes: readonly string[]
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<Json> {
  const raw = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new TenonError('FEATURE_BAD_JSON', `${path} 不是合法 JSON，没法往里合并字段`, {
      file: path,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (!isRecord(parsed)) {
    throw new TenonError('FEATURE_BAD_JSON', `${path} 的顶层不是对象`, { file: path })
  }
  return parsed
}

const SECTION_BEGIN = '<!-- tenon:backend:begin -->'
const SECTION_END = '<!-- tenon:backend:end -->'

const AGENTS_HEADER = `# 项目说明（给 Agent 读）

> 这份文件是这个项目的长期记忆：架构、约定、坑、运行方式。
> 带 \`tenon:\` 标记的几节由 Tenon 维护，**不要手改**；其余小节随便写。
`

/** 把后端那一节塞进标记之间；没有标记就追加到文末（不动别人写的任何内容） */
function spliceSection(text: string, body: string): string {
  const begin = text.indexOf(SECTION_BEGIN)
  const end = text.indexOf(SECTION_END)
  const block = `${SECTION_BEGIN}\n${body.trimEnd()}\n${SECTION_END}\n`
  if (begin !== -1 && end !== -1 && end > begin) {
    return `${text.slice(0, begin)}${block}${text.slice(end + SECTION_END.length + 1)}`
  }
  const trimmed = text.endsWith('\n') ? text : `${text}\n`
  return `${trimmed}\n${block}`
}

/**
 * `tsconfig.json` 的 `include` 加 `shared`。
 *
 * 为什么必须：`src/api.ts` 从 `../shared/schema` 引类型。`shared` 不在 include 里的话，
 * 前端那份 tsconfig 不会把 shared 当项目文件，`tsc --noEmit` 会报
 * "File is not under rootDir / not listed in project" 之类的错 —— 而报错位置在 api.ts，
 * 看起来像是后端的问题。
 */
async function includeShared(repoDir: string, notes: string[]): Promise<void> {
  const file = join(repoDir, 'tsconfig.json')
  if (!(await exists(file))) {
    notes.push('没有 tsconfig.json（不是 TypeScript 项目？），没自动把 shared 加进 include')
    return
  }
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text) as Json
    const include = Array.isArray(parsed['include']) ? parsed['include'] : []
    if (include.includes('shared')) return
    parsed['include'] = [...include, 'shared']
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  } catch {
    // tsconfig 允许注释与尾逗号，JSON.parse 会失败 —— 这条是"尽力"，失败要说出来
    notes.push('tsconfig.json 里可能有注释（不是纯 JSON），没自动加 shared：请手动把 "shared" 放进 include')
  }
}

/** `eslint.config.mjs` 的 ignores 加 `dist-server/**`（否则 lint 会去扫编译产物） */
async function ignoreDistServer(repoDir: string, notes: string[]): Promise<void> {
  const file = join(repoDir, 'eslint.config.mjs')
  if (!(await exists(file))) return
  const text = await readFile(file, 'utf8')
  if (text.includes('dist-server')) return
  const patched = text.replace(/(['"])dist\/\*\*\1/, (match, quote: string) => `${match}, ${quote}dist-server/**${quote}`)
  if (patched === text) {
    notes.push('eslint.config.mjs 里没有 `dist/**` 那条 ignores，没自动加 dist-server（lint 会扫到后端产物）')
    return
  }
  await writeFile(file, patched, 'utf8')
}

/** 把「有后端」写进 docs/AGENTS.md（幂等） */
async function writeAgentsDoc(repoDir: string, section: string): Promise<void> {
  const file = join(repoDir, 'docs', 'AGENTS.md')
  let current = ''
  if (await exists(file)) current = await readFile(file, 'utf8')
  else await mkdir(dirname(file), { recursive: true })
  const base = current === '' ? AGENTS_HEADER : current
  const next = spliceSection(base, section)
  if (next !== current) await writeFile(file, next, 'utf8')
}

export async function applyApiFeature(input: ApplyApiFeatureInput): Promise<ApplyApiFeatureResult> {
  const env = input.env ?? process.env
  const pkgPath = join(input.repoDir, 'package.json')
  if (!(await exists(pkgPath))) {
    throw new TenonError('FEATURE_NO_PACKAGE', '这个工作区没有 package.json，加不了后端', {
      repoDir: input.repoDir,
    })
  }

  const pkg = await readJson(pkgPath)
  const notes: string[] = []
  const tenonField = isRecord(pkg['tenon']) ? pkg['tenon'] : {}
  if (typeof tenonField['api'] === 'string' && tenonField['api'] !== '') {
    return { applied: false, reason: 'already', files: [], addedScripts: [], addedDependencies: [], notes: [] }
  }

  const { files, root } = await loadTemplate(API_FEATURE, env)
  const fragment = await readJson(join(root, 'package.fragment.json'))
  const section = await readFile(join(root, 'AGENTS.section.md'), 'utf8')

  // ---------- 1) 新文件 ----------
  const vars = { appSlug: typeof pkg['name'] === 'string' ? pkg['name'] : 'app' }
  const written: string[] = []
  for (const rel of files) {
    const source = await readFile(join(root, rel), 'utf8')
    const rendered = renderTemplate(source, vars, `${API_FEATURE}/${rel}`)
    const target = join(input.repoDir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, rendered, 'utf8')
    written.push(rel)
  }

  // ---------- 2) package.json：只补缺 ----------
  const addedScripts: string[] = []
  const addedDependencies: string[] = []
  const scripts = isRecord(pkg['scripts']) ? { ...pkg['scripts'] } : {}
  const fragmentScripts = isRecord(fragment['scripts']) ? fragment['scripts'] : {}
  for (const [name, command] of Object.entries(fragmentScripts)) {
    if (scripts[name] !== undefined) continue
    scripts[name] = command
    addedScripts.push(name)
  }
  pkg['scripts'] = scripts

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const fragmentDeps = isRecord(fragment[field]) ? fragment[field] : {}
    if (Object.keys(fragmentDeps).length === 0) continue
    const current = isRecord(pkg[field]) ? { ...pkg[field] } : {}
    for (const [name, version] of Object.entries(fragmentDeps)) {
      if (current[name] !== undefined) {
        if (current[name] !== version) {
          notes.push(`${name} 已有版本 ${String(current[name])}，保留（功能包想要 ${String(version)}）`)
        }
        continue
      }
      current[name] = version
      addedDependencies.push(name)
    }
    pkg[field] = current
  }

  // ★ 这一行是"要不要起后端"的唯一开关，必须写
  const fragmentTenon = isRecord(fragment['tenon']) ? fragment['tenon'] : {}
  pkg['tenon'] = { ...tenonField, ...fragmentTenon }

  /*
   * `"type": "module"` 的应用（react-vite 模板就有）会在这一步踩一个很隐蔽的坑：
   * Nest 的编译产物是 CommonJS，而 Node 判定 `.js` 是 ESM 还是 CJS 只看**最近的
   * package.json 的 `type`** —— 于是 `dist-server/api/main.js` 被当 ESM 跑，
   * 启动即 `ReferenceError: require is not defined`。
   * 产物目录里那个 `{"type":"commonjs"}` 由 `scripts/mark-cjs.mjs` 写（build:api 会调它），
   * 预览时由网关在编译完之后补（见 `gateway/src/api.ts` 的 `pinOutputModule`）。
   */
  if (pkg['type'] === 'module') {
    notes.push('这个应用是 ESM 的（package.json 有 "type": "module"）：已加 scripts/mark-cjs.mjs 给编译产物钉 commonjs，否则后端启动会 require is not defined')
  }

  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  // ---------- 3) 两处就地改 + AGENTS.md ----------
  await includeShared(input.repoDir, notes)
  await ignoreDistServer(input.repoDir, notes)
  await writeAgentsDoc(input.repoDir, section)

  return { applied: true, files: written, addedScripts, addedDependencies, notes }
}
