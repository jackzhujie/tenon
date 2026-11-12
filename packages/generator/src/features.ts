/**
 * 给**已有应用**补一块能力（「加后端」与「加登录」）。
 *
 * 为什么不是"再铺一次模板"：
 * - 模板是「从零铺一份」，会写 package.json / vite.config.ts / src/App.tsx；
 *   在已有应用上重铺等于把用户与 Agent 写的代码冲掉。
 * - 用户装上之后真正的需求是「这个应用现在需要一个后端 / 需要登录」，而不是「我想换个模板」。
 *
 * 所以这里做三件模板做不到的事：
 * 1. 只写**新文件**（`api/`、`shared/`、`src/api.ts`、`tsconfig.server.json`）
 * 2. package.json 只**补缺**（scripts / deps 已存在的一个都不覆盖），但 `tenon.api` 必写 ——
 *    那是平台判断"要不要起后端"的唯一事实来源
 * 3. 几处**就地改**：`tsconfig.json` 的 `include` 加 `shared`、`eslint.config.mjs` 忽略 `dist-server`、
 *    `api/db.ts` 登记实体、`api/app.module.ts` 挂模块、`src/main.tsx` 包一层闸门，
 *    以及给 `docs/AGENTS.md` 加一节（否则 Agent 下一次改代码不知道有后端，很可能又用 localStorage
 *    存数据 —— 那不是"重复劳动"，是两套事实来源）
 *
 * 幂等：已经有 `tenon.api` / `tenon.auth` 就什么都不做（返回 `applied: false`）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { msg, TenonError } from '@tenon/protocol'
import { renderTemplate, type TemplateVars } from './render.js'
import { loadTemplate } from './registry.js'

/** 功能包在模板目录里的名字（`hidden: true`，不会出现在建应用对话框） */
export const API_FEATURE = 'api-feature'
export const AUTH_FEATURE = 'auth-feature'

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
    throw new TenonError('FEATURE_BAD_JSON', msg('error.feature.badJson', { file: path }), {
      file: path,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (!isRecord(parsed)) {
    throw new TenonError('FEATURE_BAD_JSON', msg('error.feature.notObject', { file: path }), { file: path })
  }
  return parsed
}

/**
 * `docs/AGENTS.md` 里每一节用一对注释圈起来。
 *
 * 为什么按功能包分两对标记：`spliceSection` 的做法是"找到 begin/end，把中间整段换掉"。
 * 两个功能包如果共用一对标记，后写的那个会把先写的那一节整段抹掉 ——
 * 而抹掉之后文件仍然合法、应用也照跑，只是下一次 Agent 改代码时不知道有后端了。
 */
interface Markers {
  readonly begin: string
  readonly end: string
}

const BACKEND_MARKERS: Markers = {
  begin: '<!-- tenon:backend:begin -->',
  end: '<!-- tenon:backend:end -->',
}

const AUTH_MARKERS: Markers = {
  begin: '<!-- tenon:auth:begin -->',
  end: '<!-- tenon:auth:end -->',
}

const AGENTS_HEADER = `# Project notes (for the Agent)

> This file is the project's long-term memory: architecture, conventions, pitfalls, how to run it.
> Sections marked \`tenon:\` are maintained by Tenon — **do not edit them by hand**; write freely elsewhere.
`

/** 把一节塞进它的标记之间；没有标记就追加到文末（不动别人写的任何内容） */
function spliceSection(text: string, body: string, markers: Markers): string {
  const begin = text.indexOf(markers.begin)
  const end = text.indexOf(markers.end)
  const block = `${markers.begin}\n${body.trimEnd()}\n${markers.end}\n`
  if (begin !== -1 && end !== -1 && end > begin) {
    return `${text.slice(0, begin)}${block}${text.slice(end + markers.end.length + 1)}`
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
    notes.push('No tsconfig.json (not a TypeScript project?), so "shared" was not added to include')
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
    notes.push('tsconfig.json may contain comments (not plain JSON), so "shared" was not added — add it to include by hand')
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
    notes.push('eslint.config.mjs has no "dist/**" ignore entry, so dist-server was not added (lint would scan the backend build output)')
    return
  }
  await writeFile(file, patched, 'utf8')
}

/** 把「有后端」写进 docs/AGENTS.md（幂等） */
async function writeAgentsDoc(repoDir: string, section: string, markers: Markers): Promise<void> {
  const file = join(repoDir, 'docs', 'AGENTS.md')
  let current = ''
  if (await exists(file)) current = await readFile(file, 'utf8')
  else await mkdir(dirname(file), { recursive: true })
  const base = current === '' ? AGENTS_HEADER : current
  const next = spliceSection(base, section, markers)
  if (next !== current) await writeFile(file, next, 'utf8')
}

export async function applyApiFeature(input: ApplyApiFeatureInput): Promise<ApplyApiFeatureResult> {
  const env = input.env ?? process.env
  const pkgPath = join(input.repoDir, 'package.json')
  if (!(await exists(pkgPath))) {
    throw new TenonError('FEATURE_NO_PACKAGE', msg('error.feature.noBackend'), {
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
          notes.push(`${name} is already at ${String(current[name])}; kept it (the feature wanted ${String(version)})`)
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
    notes.push('This app is ESM (package.json has "type": "module"): added scripts/mark-cjs.mjs to pin the compiled output to CommonJS — otherwise the backend starts with "require is not defined"')
  }

  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  // ---------- 3) 两处就地改 + AGENTS.md ----------
  await includeShared(input.repoDir, notes)
  await ignoreDistServer(input.repoDir, notes)
  await writeAgentsDoc(input.repoDir, section, BACKEND_MARKERS)

  return { applied: true, files: written, addedScripts, addedDependencies, notes }
}

// ============================================================================
// 加登录（`auth-feature`）
// ============================================================================

export interface ApplyAuthFeatureInput {
  /** 应用仓库目录（`apps/<id>/repo`） */
  readonly repoDir: string
  readonly env?: NodeJS.ProcessEnv
}

export interface ApplyAuthFeatureResult {
  readonly applied: boolean
  /** 没应用的原因（`already` = 本来就有登录） */
  readonly reason?: string
  /** 纯前端应用会被先补上后端 —— 鉴权必须有后端，那不是可选步骤 */
  readonly addedBackend: boolean
  /** 写进应用的新文件（相对路径） */
  readonly files: readonly string[]
  /** `src/main.tsx` 有没有自动包上 `<AuthGate>` */
  readonly wired: boolean
  /** 需要人（或 Agent）知道一句的事：就地改失败之类 */
  readonly notes: readonly string[]
}

/** 应用名 → slug。cookie 名和日志里用它，所以只留 `[a-z0-9-]` */
function slugOf(pkg: Json): string {
  const raw = typeof pkg['name'] === 'string' ? pkg['name'] : 'app'
  const bare = raw.slice(raw.lastIndexOf('/') + 1)
  const slug = bare
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'app' : slug
}

/**
 * 会话 cookie 名。
 *
 * ★ 必须按应用区分：浏览器**不按端口**隔离 cookie，同一台机器上两个应用都用 `sid`
 *   会互相覆盖，症状是"随机掉登录"。详见模板里 `api/auth/cookie-name.ts` 的注释。
 */
function cookieNameOf(slug: string): string {
  return `tenon_auth_${slug.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`
}

/**
 * 把 import 插到**最后一个 import 之后**。
 *
 * 插到文件第一行会跑到 `'use client'` / `// @ts-nocheck` 之类指令前面（它们必须待在首行）；
 * 插到文件末尾又不合法（import 只能在顶层）。只有最后一个 import 之后两边都安全。
 */
function insertAfterImports(text: string, lines: readonly string[]): string {
  const all = text.split('\n')
  let last = -1
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index] ?? ''
    if (/^import\s/.test(line)) {
      last = index
      continue
    }
    // 空行不算结束：import 之间常有空行分组
    if (last !== -1 && line.trim() !== '') break
  }
  if (last === -1) return [...lines, text].join('\n')
  return [...all.slice(0, last + 1), ...lines, ...all.slice(last + 1)].join('\n')
}

const AUTH_ENTITY_IMPORTS = [
  "import { AuthSession } from './auth/auth-session.entity'",
  "import { AuthUser } from './auth/auth-user.entity'",
]

/**
 * 在 `api/db.ts` 的 `entities` 里登记两张账号表。
 *
 * 漏了这一步的报错**离原因很远**：迁移不会建表，第一次登录报
 * `relation "auth_users" does not exist`，看起来像"迁移没跑"。
 */
async function registerAuthEntities(repoDir: string, notes: string[]): Promise<void> {
  const file = join(repoDir, 'api', 'db.ts')
  if (!(await exists(file))) {
    notes.push(
      'No api/db.ts, so the auth tables were not registered: add AuthUser / AuthSession to entities (without them, sign-in fails with relation "auth_users" does not exist)',
    )
    return
  }
  let text = await readFile(file, 'utf8')
  if (text.includes('AuthUser')) return
  const pattern = /export const entities = \[([\s\S]*?)\] as const/
  if (!pattern.test(text)) {
    notes.push(
      'Could not find `export const entities = [...] as const` in api/db.ts — add AuthUser / AuthSession by hand (without them, sign-in fails with relation "auth_users" does not exist)',
    )
    return
  }
  text = insertAfterImports(text, AUTH_ENTITY_IMPORTS)
  text = text.replace(pattern, (_match, inner: string) => {
    const body = inner.trim()
    return `export const entities = [${body === '' ? '' : `${body}, `}AuthUser, AuthSession] as const`
  })
  await writeFile(file, text, 'utf8')
}

/** 在 `api/app.module.ts` 里挂上 `AuthModule` —— **守卫就是从这里生效的** */
async function registerAuthModule(repoDir: string, notes: string[]): Promise<void> {
  const file = join(repoDir, 'api', 'app.module.ts')
  if (!(await exists(file))) {
    notes.push(
      'No api/app.module.ts, so AuthModule was not wired: import it and add it to imports (without it the guard never runs and every endpoint is public)',
    )
    return
  }
  let text = await readFile(file, 'utf8')
  if (text.includes('AuthModule')) return
  if (!/imports:\s*\[/.test(text)) {
    notes.push(
      'Could not find `imports: [` in the @Module of api/app.module.ts — add AuthModule by hand (without it the guard never runs and every endpoint is public)',
    )
    return
  }
  text = insertAfterImports(text, ["import { AuthModule } from './auth/auth.module'"])
  text = text.replace(/imports:\s*\[/, (match) => `${match}\n    AuthModule,`)
  await writeFile(file, text, 'utf8')
}

/**
 * 把 `<App/>` 包进 `<AuthGate>`。
 *
 * 这是唯一"碰用户代码"的一步，所以做成**尽力而为**：形状不匹配（用户重写过 main.tsx）
 * 就只留一条明确的待办，绝不硬改。硬改的代价是白屏，而白屏比"没接上"难查得多
 * —— 后者至少接口还在正确地说 401。
 */
async function wrapWithAuthGate(repoDir: string, notes: string[]): Promise<boolean> {
  const file = join(repoDir, 'src', 'main.tsx')
  if (!(await exists(file))) {
    notes.push(
      'No src/main.tsx, so the sign-in page was not wired: wrap <App/> in <AuthGate> (without it every request returns 401 while the page shows no sign-in form)',
    )
    return false
  }
  const text = await readFile(file, 'utf8')
  if (text.includes('AuthGate')) return true

  const pattern = /(<TenonErrorBoundary>)([\s\S]*?)(<\/TenonErrorBoundary>)/
  const match = pattern.exec(text)
  if (match === null) {
    notes.push(
      'src/main.tsx does not match the template (no <TenonErrorBoundary>): wrap <App/> in <AuthGate>, otherwise every request returns 401 while the page shows no sign-in form',
    )
    return false
  }
  const open = match[1] ?? ''
  const close = match[3] ?? ''
  const inner = (match[2] ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '')
  const indented = inner
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `  ${line}`))
    .join('\n')
  const wrapped = text.replace(
    pattern,
    `${open}\n      <AuthGate>\n${indented}\n      </AuthGate>\n    ${close}`,
  )
  await writeFile(file, insertAfterImports(wrapped, ["import { AuthGate } from './auth/AuthGate'"]), 'utf8')
  return true
}

/**
 * 给已有应用加账号体系。
 *
 * 顺序不能换：
 * 1. 先确保有后端（否则写了 `api/auth/*` 也没人跑）
 * 2. 写文件
 * 3. 就地改四处（db.ts 登记实体、app.module.ts 挂模块、main.tsx 包闸门、AGENTS.md 加一节）
 *    —— 这四处**任何一处漏掉都不会在编译期报错**，只是功能静默不生效
 * 4. 最后才写 `tenon.auth`：中途失败时重新跑一次还能补齐，而不是一条"已完成"的假记录
 */
export async function applyAuthFeature(input: ApplyAuthFeatureInput): Promise<ApplyAuthFeatureResult> {
  const env = input.env ?? process.env
  const pkgPath = join(input.repoDir, 'package.json')
  if (!(await exists(pkgPath))) {
    throw new TenonError('FEATURE_NO_PACKAGE', msg('error.feature.noAuth'), {
      repoDir: input.repoDir,
    })
  }

  let pkg = await readJson(pkgPath)
  const tenonField = isRecord(pkg['tenon']) ? pkg['tenon'] : {}
  if (tenonField['auth'] === true) {
    return { applied: false, reason: 'already', addedBackend: false, files: [], wired: true, notes: [] }
  }

  const notes: string[] = []

  /*
   * 鉴权是**后端**能力：会话、口令哈希、"谁都改不了的默认拒绝"都只能在后端。
   * 所以纯前端应用会先被补上后端。这不是"顺手加的功能"，是前置条件 ——
   * 只在前端做登录框，等于在门上装了一把画上去的锁。
   */
  let addedBackend = false
  if (typeof tenonField['api'] !== 'string' || tenonField['api'] === '') {
    const backend = await applyApiFeature({ repoDir: input.repoDir, env })
    addedBackend = backend.applied
    notes.push(...backend.notes)
    pkg = await readJson(pkgPath)
  }

  const { files, root } = await loadTemplate(AUTH_FEATURE, env)
  const section = await readFile(join(root, 'AGENTS.section.md'), 'utf8')

  const slug = slugOf(pkg)
  const vars: TemplateVars = { appSlug: slug, authCookieName: cookieNameOf(slug) }

  const written: string[] = []
  for (const rel of files) {
    const source = await readFile(join(root, rel), 'utf8')
    const rendered = renderTemplate(source, vars, `${AUTH_FEATURE}/${rel}`)
    const target = join(input.repoDir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, rendered, 'utf8')
    written.push(rel)
  }

  await registerAuthEntities(input.repoDir, notes)
  await registerAuthModule(input.repoDir, notes)
  const wired = await wrapWithAuthGate(input.repoDir, notes)
  await writeAgentsDoc(input.repoDir, section, AUTH_MARKERS)

  const tenonNow = isRecord(pkg['tenon']) ? pkg['tenon'] : {}
  // 这个标记有两个作用：幂等判据，以及"这个应用有登录"对界面/Agent 的可读事实
  pkg['tenon'] = { ...tenonNow, auth: true }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  return { applied: true, addedBackend, files: written, wired, notes }
}
