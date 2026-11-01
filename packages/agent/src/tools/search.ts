/**
 * 只读检索工具：`ls` / `glob` / `grep`（M4 第 1 步）。
 *
 * **为什么不用 `pi-coding-agent` 的同名工具**（这是本轮最重要的一个决定）：
 * 它的 `grep` / `find` 走 `ensureTool()` —— **首次调用时从 GitHub 下载 `rg` / `fd` 二进制**
 * 到 `~/.pi/bin`，然后把子进程拉起来。对 CLI 是合理设计，对我们三处都错：
 * 1. 本地优先（DESIGN §1.1）：用户没网时第一次搜索就卡住十秒然后失败；
 * 2. 桌面版不该在用户机器上偷偷落地可执行文件（打包后体积与签名审计都会被它咬一口）；
 * 3. 它把 `cwd` 之外的路径解析交给自己，我们的越界守卫就漏了。
 *
 * 所以这里自己写：纯 `node:fs`、有上限、有跳过目录、正则在进程内跑。
 * 代价是没有 ripgrep 快 —— 生成的应用只有几十个文本文件，量级根本用不上 ripgrep。
 *
 * 共同约束：
 * - 只读：不提供任何写操作，越界路径直接拒绝（`isInside`）。
 * - 全部有上限（条目 / 匹配数 / 单文件大小 / 扫描文件数），输出不会把上下文撑爆。
 * - 跳过 `node_modules` / `.git` / `dist` 这类目录 —— 搜它们等于把预算烧在依赖里。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { isInside } from './coding.js'

export const SEARCH_TOOL_NAMES = ['ls', 'glob', 'grep'] as const

/** 递归时一律跳过的目录（按名字匹配，任何层级） */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.tenon',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.turbo',
  '.next',
])

const MAX_SCANNED_FILES = 4000
const MAX_FILE_BYTES = 512 * 1024
const MAX_OUTPUT_BYTES = 48 * 1024
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
/** 单行太长（压缩产物、单行 JSON）对模型没有价值，还占额度 */
const MAX_LINE_CHARS = 300

export interface SearchToolsOptions {
  /** 应用仓库目录。搜索范围永远不出这里 */
  repoDir: string
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT
  return Math.min(Math.max(n, 1), MAX_LIMIT)
}

function guardPath(repoDir: string, candidate: unknown): string | undefined {
  if (candidate === undefined || candidate === '') return undefined
  if (typeof candidate !== 'string') return '参数 `path` 必须是字符串'
  if (!isInside(repoDir, candidate)) {
    return `拒绝访问工作区之外的路径：${candidate}。只能检索应用工作区（repo/）里的文件。`
  }
  return undefined
}

/** 把 glob 编译成正则：`**` 跨目录、`*` 不跨、`?` 单字符。 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string
    if (char === '*') {
      const isDouble = pattern[index + 1] === '*'
      if (isDouble) {
        // `**/` 匹配零层或更多层目录
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

async function readSmallFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined
    const buffer = await readFile(path)
    // 前 8KB 里有 NUL 就当二进制：不必解码，也不该把二进制塞给模型
    if (buffer.subarray(0, 8192).includes(0)) return undefined
    return buffer.toString('utf8')
  } catch {
    // 权限/竞态/符号链接断链：跳过，不让一个文件毁掉整次搜索
    return undefined
  }
}

interface WalkResult {
  files: string[]
  truncated: boolean
}

/** 深度优先收集相对路径；按名字跳过 SKIP_DIRS，超出上限就停。 */
async function walk(root: string, start: string, accept: (relativePath: string) => boolean): Promise<WalkResult> {
  const files: string[] = []
  let truncated = false
  const stack = [start]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        // 隐藏文件（含 .git）默认不看，除非显式给了点开头的 glob
        if (entry.isDirectory()) continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute).split(sep).join('/')
      if (!accept(rel)) continue
      files.push(rel)
      if (files.length >= MAX_SCANNED_FILES) {
        truncated = true
        return { files, truncated }
      }
    }
  }
  files.sort()
  return { files, truncated }
}

function errorResult(text: string): { isError: true; output: { type: 'text'; text: string }[] } {
  return { isError: true, output: [{ type: 'text', text }] }
}

export function createSearchTools(options: SearchToolsOptions): ToolRegistration[] {
  const { repoDir } = options

  const ls: ToolRegistration = {
    name: 'ls',
    description:
      'List a directory inside the app workspace. Directories first, then files with size. ' +
      'Paths are relative to the workspace root. Use it before reading files to learn the layout.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory path (default: repository root)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum entries to return (default 100)' })),
    }),
    replay: 'safe',
    async execute(args) {
      const input = args as { path?: string; limit?: number }
      const rejection = guardPath(repoDir, input.path)
      if (rejection !== undefined) return errorResult(rejection)
      const target = resolve(repoDir, input.path ?? '.')
      const limit = clampLimit(input.limit)
      let entries
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch {
        return errorResult(`目录不存在或不可读：${input.path ?? '.'}`)
      }
      const rows: string[] = []
      const dirs = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
      const files = entries.filter((entry) => !entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of [...dirs, ...files]) {
        if (rows.length >= limit) break
        if (entry.isDirectory()) {
          rows.push(`${entry.name}/`)
          continue
        }
        const size = await stat(join(target, entry.name)).then(
          (info) => `${info.size}B`,
          () => '?',
        )
        rows.push(`${entry.name}\t${size}`)
      }
      if (rows.length === 0) return { output: [{ type: 'text', text: '(空目录)' }] }
      const more = dirs.length + files.length > rows.length ? `\n… 还有 ${dirs.length + files.length - rows.length} 项未列出` : ''
      return { output: [{ type: 'text', text: rows.join('\n') + more }] }
    },
  }

  const glob: ToolRegistration = {
    name: 'glob',
    description:
      'Find files by glob pattern inside the app workspace (e.g. "src/**/*.tsx", "*.json"). ' +
      'Skips node_modules, dist and dotfiles.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern, relative to the search root' }),
      path: Type.Optional(Type.String({ description: 'Search root (default: repository root)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum paths to return (default 100)' })),
    }),
    replay: 'safe',
    async execute(args) {
      const input = args as { pattern?: string; path?: string; limit?: number }
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        return errorResult('参数 `pattern` 缺失，例如 "src/**/*.tsx"')
      }
      const rejection = guardPath(repoDir, input.path)
      if (rejection !== undefined) return errorResult(rejection)
      const limit = clampLimit(input.limit)
      const root = resolve(repoDir, input.path ?? '.')
      const matcher = globToRegExp(input.pattern.split(sep).join('/'))
      const walked = await walk(repoDir, root, (rel) => {
        const scope = relative(root, resolve(repoDir, rel)).split(sep).join('/')
        return matcher.test(scope) || matcher.test(rel)
      })
      if (walked.files.length === 0) return { output: [{ type: 'text', text: `没有匹配 ${input.pattern} 的文件` }] }
      const shown = walked.files.slice(0, limit)
      const truncated = walked.truncated || walked.files.length > shown.length
      return {
        output: [
          {
            type: 'text',
            text: shown.join('\n') + (truncated ? `\n… 结果被截断（上限 ${limit}，扫描 ${walked.files.length}）` : ''),
          },
        ],
      }
    },
  }

  const grep: ToolRegistration = {
    name: 'grep',
    description:
      'Search file contents with a regular expression inside the app workspace. ' +
      'Returns "path:line: text". Skips node_modules, dist, binary files and lines longer than 300 chars.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regular expression (or literal text with literal=true)' }),
      path: Type.Optional(Type.String({ description: 'Directory or file to search (default: repository root)' })),
      glob: Type.Optional(Type.String({ description: 'Only search files matching this glob, e.g. "*.tsx"' })),
      ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive (default false)' })),
      literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as literal text (default false)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum matches to return (default 100)' })),
    }),
    replay: 'safe',
    async execute(args) {
      const input = args as {
        pattern?: string
        path?: string
        glob?: string
        ignoreCase?: boolean
        literal?: boolean
        limit?: number
      }
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        return errorResult('参数 `pattern` 缺失')
      }
      const rejection = guardPath(repoDir, input.path)
      if (rejection !== undefined) return errorResult(rejection)

      let regex: RegExp
      try {
        const source = input.literal === true ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : input.pattern
        regex = new RegExp(source, input.ignoreCase === true ? 'i' : '')
      } catch (err) {
        return errorResult(`正则写法有问题：${err instanceof Error ? err.message : String(err)}`)
      }

      const limit = clampLimit(input.limit)
      const root = resolve(repoDir, input.path ?? '.')
      const fileMatcher =
        typeof input.glob === 'string' && input.glob !== '' ? globToRegExp(input.glob.split(sep).join('/')) : undefined

      const info = await stat(root).catch(() => undefined)
      const candidates =
        info === undefined
          ? []
          : info.isFile()
            ? [relative(repoDir, root).split(sep).join('/')]
            : (
                await walk(repoDir, root, (rel) =>
                  fileMatcher === undefined
                    ? true
                    : fileMatcher.test(rel) || fileMatcher.test(rel.slice(rel.lastIndexOf('/') + 1)),
                )
              ).files

      const hits: string[] = []
      let bytes = 0
      for (const rel of candidates) {
        if (hits.length >= limit || bytes >= MAX_OUTPUT_BYTES) break
        const content = await readSmallFile(join(repoDir, rel))
        if (content === undefined) continue
        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] as string
          if (!regex.test(line)) continue
          const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
          const hit = `${rel}:${index + 1}: ${clipped.trimEnd()}`
          hits.push(hit)
          bytes += hit.length + 1
          if (hits.length >= limit || bytes >= MAX_OUTPUT_BYTES) break
        }
      }

      if (hits.length === 0) {
        return { output: [{ type: 'text', text: `没有匹配 ${input.pattern} 的行（扫描 ${candidates.length} 个文件）` }] }
      }
      const capped = hits.length >= limit || bytes >= MAX_OUTPUT_BYTES
      return {
        output: [
          {
            type: 'text',
            text: hits.join('\n') + (capped ? `\n… 匹配被截断（上限 ${limit} 条）` : ''),
          },
        ],
      }
    },
  }

  return [ls, glob, grep]
}
