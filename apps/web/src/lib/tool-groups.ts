/**
 * 把连续的"探索动作"并成一组（v1.2.27）。
 *
 * 起因是真实截图：Agent 为了搞清一个仓库，会连着发七八条
 * `cat package.json` / `find src …` / `读取 README.md` / `sed -n '80,160p' …`。
 * 每条占一行的结果是**对话框被探索过程淹没**，用户想看的"它到底改了什么"被挤到看不见。
 *
 * 为什么规则要保守（只合并"不可能改文件"的）：
 * 合并的代价是**信息被折起来**。折错一条 `git commit` 或 `pnpm build`，
 * 用户就看不到"它动了什么"，那是比"多几行"严重得多的问题。
 * 所以：只读工具名白名单 + bash 只读命令白名单，两条都不命中就老老实实单独显示。
 *
 * 三条边界：
 * - **出错的不合并**：失败必须独立可见（折进"查看 12 项"里等于藏起来）
 * - **至少 2 条才合并**：一条独立命令写成"探索 1 项"是纯噪声
 * - **不跨类型合并**：`write`/`edit`/`subagent` 永远独立
 */

import type { TFunction } from './i18n.js'

/** 只读工具名（这三个查代码、不可能写盘） */
const READ_ONLY_TOOLS = new Set(['read', 'ls', 'glob', 'grep'])

/**
 * 只读命令白名单。
 *
 * 刻意**不含** `pnpm` / `npm` / `node` / `tsc` / `eslint` / `curl`：
 * 它们都可能写盘或联网（`pnpm add`、`eslint --fix`、`node -e`），
 * 而"那条命令其实改了什么"正是用户要看的。
 */
const READ_ONLY_BINARIES = new Set([
  'cat',
  'cd',
  'ls',
  'find',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'cut',
  'tr',
  'sort',
  'uniq',
  'pwd',
  'echo',
  'printf',
  'stat',
  'file',
  'tree',
  'du',
  'df',
  'diff',
  'jq',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'which',
  'uname',
  'date',
  'test',
  'true',
  'false',
])

/** `git` 只有这几个子命令是只读的 */
const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'ls-files',
  'rev-parse',
  'describe',
  'blame',
  'shortlog',
])

/** 单段命令是否只读。`sed -i` / `find -delete` 是白名单里的例外 */
function isReadOnlySegment(segment: string): boolean {
  // 去掉前置的环境变量赋值（`NODE_ENV=production cat x` 仍然只读）
  const text = segment.replace(/^(?:\w+=\S*\s+)+/, '').trim()
  if (text === '') return true

  const tokens = text.split(/\s+/)
  const first = tokens[0]
  if (first === undefined) return true

  if (first === 'git') {
    const sub = tokens.slice(1).find((token) => !token.startsWith('-'))
    return sub !== undefined && READ_ONLY_GIT.has(sub)
  }
  if (first === 'sed') {
    return !tokens.some((token) => token === '--in-place' || /^-i/.test(token))
  }
  if (first === 'find') {
    return !tokens.some((token) => token === '-delete' || token === '-exec' || token === '-execdir' || token === '-ok')
  }
  return READ_ONLY_BINARIES.has(first)
}

/**
 * 这条 bash 命令能不能并进"探索"。
 *
 * 判据是**每一段都只读**（按 `&&` / `||` / `;` / 管道 / 换行切开），
 * 而不是"第一个词是 cat"—— `cat a && rm b` 那种写法必须被挡在外面。
 */
export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === '') return false

  /*
   * 先把"不写盘的重定向"抹掉：`2>/dev/null`、`>/dev/null`、`2>&1` 在截图里满地都是，
   * 它们不产生文件。抹掉之后如果还有 `>`，那就是真的在写文件 —— 不算只读。
   */
  const cleaned = command
    .replace(/\d*>>?\s*\/dev\/null/g, ' ')
    .replace(/\d*>&\d/g, ' ')
    .replace(/&>/g, ' ')

  if (/>/.test(cleaned)) return false

  const segments = cleaned
    .split(/&&|\|\||;|\n|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')

  if (segments.length === 0) return false
  return segments.every(isReadOnlySegment)
}

export interface Activity {
  readonly toolCallId: string
  readonly name: string
  readonly args: Record<string, unknown> | undefined
  readonly status: 'running' | 'ok' | 'error'
}

export type ActivityEntry<A extends Activity> =
  | { readonly kind: 'single'; readonly activity: A }
  | { readonly kind: 'explore'; readonly items: readonly A[] }

/** 一个动作是不是"探索"：只读工具名，或只读 bash */
export function isExploration(activity: Activity): boolean {
  if (READ_ONLY_TOOLS.has(activity.name)) return true
  if (activity.name !== 'bash') return false
  const command = activity.args?.['command']
  return typeof command === 'string' && isReadOnlyCommand(command)
}

/**
 * 把一串动作切成"单条"与"探索组"。
 *
 * 顺序必须保留：探索组在流里出现的位置就是它发生的时刻，
 * 挪到别处会让"先读了什么、再改了什么"这条因果链读不出来。
 */
export function groupActivities<A extends Activity>(activities: readonly A[]): ActivityEntry<A>[] {
  const entries: ActivityEntry<A>[] = []
  let pending: A[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    if (pending.length === 1) {
      entries.push({ kind: 'single', activity: pending[0] as A })
    } else {
      entries.push({ kind: 'explore', items: pending })
    }
    pending = []
  }

  for (const activity of activities) {
    // 出错不合并：失败必须独立可见
    if (activity.status !== 'error' && isExploration(activity)) {
      pending.push(activity)
      continue
    }
    flush()
    entries.push({ kind: 'single', activity })
  }
  flush()
  return entries
}

/** 收起时那一行的说明："读取 3 个文件 · 执行 7 条命令" */
export function describeExploration(items: readonly Activity[], t: TFunction): string {
  let files = 0
  let commands = 0
  let others = 0
  for (const item of items) {
    if (item.name === 'bash') commands += 1
    else if (typeof item.args?.['path'] === 'string') files += 1
    else others += 1
  }
  const parts: string[] = []
  if (files > 0) parts.push(t('tool.summary.files', { count: files }))
  if (commands > 0) parts.push(t('tool.summary.commands', { count: commands }))
  if (others > 0) parts.push(t('tool.summary.others', { count: others }))
  return parts.join(' · ')
}

/** 组里最后一条在做什么（收起时给个"现在在哪"的线索） */
export function latestHint(items: readonly Activity[]): string {
  const last = items[items.length - 1]
  if (last === undefined) return ''
  const command = last.args?.['command']
  if (typeof command === 'string') {
    const firstLine = command.split('\n')[0] ?? command
    return firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine
  }
  const path = last.args?.['path']
  return typeof path === 'string' ? path : ''
}
