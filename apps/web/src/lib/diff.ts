/**
 * Diff 视图的纯函数部分。
 *
 * 单独放这里是为了能单测 —— 折叠上下文是"看起来一定对、实际容易错"的那类逻辑：
 * 三个连续的改动之间只跳 1 行时不该插"跳过 1 行"，文件开头/结尾不该留空的省略占位。
 */
import type { DiffFile, DiffLine } from '@tenon/protocol'

/** 改动行上下各留几行。GitHub 默认 3，这里跟它一致 */
export const DEFAULT_CONTEXT = 3

export type DiffRow =
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldLine: number | null; newLine: number | null }
  | { kind: 'skip'; count: number }

/**
 * 只保留改动行及其上下 `context` 行，其余折成一条「跳过 N 行」。
 *
 * 不做折叠的话，一个 800 行的文件改 2 行也要整份渲染；浏览器扛得住，
 * 但用户要滚三屏才看到那两行。这里按行号折叠，不是按 hunk ——
 * 两个改动隔着 5 行时会合成一段，而不是切成两个 `@@`。
 */
export function collapseContext(lines: DiffLine[], context = DEFAULT_CONTEXT): DiffRow[] {
  const keep = lines.map(() => false)
  lines.forEach((line, index) => {
    if (line.kind === 'ctx') return
    const from = Math.max(0, index - context)
    const to = Math.min(lines.length - 1, index + context)
    for (let k = from; k <= to; k += 1) keep[k] = true
  })

  const rows: DiffRow[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index] === true) {
      if (skipped > 0) {
        rows.push({ kind: 'skip', count: skipped })
        skipped = 0
      }
      rows.push(line)
      return
    }
    skipped += 1
  })
  if (skipped > 0) rows.push({ kind: 'skip', count: skipped })
  return rows
}

export interface DiffTotals {
  files: number
  insertions: number
  deletions: number
  added: number
  modified: number
  deleted: number
}

export function diffTotals(files: DiffFile[]): DiffTotals {
  let insertions = 0
  let deletions = 0
  let added = 0
  let modified = 0
  let deleted = 0
  for (const file of files) {
    insertions += file.insertions
    deletions += file.deletions
    if (file.status === 'added') added += 1
    else if (file.status === 'deleted') deleted += 1
    else modified += 1
  }
  return { files: files.length, insertions, deletions, added, modified, deleted }
}

export const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

export const STATUS_SIGN: Record<DiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

/**
 * 文件路径的显示形式：保留最后两段。
 *
 * 只显示文件名不够 —— `src/components/ui/Button.tsx` 和 `src/features/chat/Button.tsx`
 * 会看起来一模一样，而它们改起来的含义完全不同（前者影响全局）。
 */
export function shortPath(path: string): string {
  const parts = path.split('/')
  return parts.length <= 2 ? path : parts.slice(-2).join('/')
}

/** 回滚确认里给人看的一句话 */
export function revertHint(sha: string, message: string): string {
  const first = message.split('\n')[0] ?? message
  return `回滚 ${sha.slice(0, 7)}「${first}」的改动？会生成一条新的回滚提交，历史不丢。`
}
