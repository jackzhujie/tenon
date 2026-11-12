/**
 * `tsc` 输出的解析与摘要（M4 第 5 步，给 Reviewer 用）。
 *
 * 为什么单独一个模块：类型检查的输出是**给模型看的**，而 `tsc` 的默认格式（带颜色、带
 * 源码摘录、带波浪线）在上下文里全是噪声。`--pretty false` 之后每行一条
 * `src/App.tsx(12,5): error TS2322: ...`，解析成结构再由我们控制"说几条、说多细"，
 * 比让模型自己去读 200 行彩色文本便宜得多，也不会因为一条错误换行而读错。
 *
 * 纯函数、不 spawn、不碰盘 —— 跑 `tsc` 的事在 `packages/agent/src/tools/review.ts`。
 */
export interface TscDiagnostic {
  /** 相对仓库根的路径（`tsc` 本来就按 `-p` 的目录给相对路径） */
  file: string
  /** 1 起 */
  line: number
  column: number
  /** 例如 `TS2322` */
  code: string
  message: string
}

export interface TscParseResult {
  diagnostics: TscDiagnostic[]
  /** 不是诊断行、也不是空行的那些（配置错误、`tsc` 自己的崩溃信息） */
  other: string[]
}

/** `src/App.tsx(12,5): error TS2322: Type 'x' is not assignable to type 'y'.` */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/

/**
 * 解析 `tsc --noEmit --pretty false` 的输出。
 *
 * 三条宽容规则，都是为了"别把真错误吞掉"：
 * - 也认路径里带空格/括号的（正则用非贪婪的 `.+?` 到 `(` 为止，但要求后面紧跟 `(行,列)`）
 * - 续行（`tsc` 偶尔把长消息折到下一行、缩进对齐）并进上一条诊断，不单独成条
 * - 认不出的非空行原样留在 `other` 里 —— 比如 `error TS5023: Unknown compiler option`，
 *   它没有文件位置，但它是**真的没跑成**，不能当"没有错误"
 */
export function parseTscOutput(stdout: string, stderr = ''): TscParseResult {
  const diagnostics: TscDiagnostic[] = []
  const other: string[] = []
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/)

  for (const raw of lines) {
    if (raw.trim() === '') continue
    const match = DIAGNOSTIC.exec(raw)
    if (match !== null) {
      diagnostics.push({
        file: match[1] as string,
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[4] as string,
        message: (match[5] as string).trim(),
      })
      continue
    }
    // 缩进行是上一条诊断的续行（对齐用的空白 + 消息后半段）
    if (/^\s/.test(raw) && diagnostics.length > 0) {
      const last = diagnostics[diagnostics.length - 1] as TscDiagnostic
      last.message = `${last.message} ${raw.trim()}`
      continue
    }
    other.push(raw.trimEnd())
  }
  return { diagnostics, other }
}

export interface TscReportOptions {
  /** 最多列几条诊断（默认 12） */
  maxItems?: number
  /** 用哪个 tsconfig 跑的，写进标题 */
  config?: string
  /** 耗时（毫秒） */
  elapsedMs?: number
  /** 退出码；undefined 表示超时/被杀 */
  exitCode?: number
}

/**
 * 把解析结果写成人能读、模型能引用的几行。
 *
 * **判据只有一条：`ok` 必须同时满足"跑完了（exit 0）"和"没有诊断"**。
 * 只看诊断会把"`tsc` 崩了 / 超时了"报成通过 —— 那是评审里最坏的假绿。
 */
export function formatTscReport(
  result: TscParseResult,
  ok: boolean,
  options: TscReportOptions = {},
): { ok: boolean; text: string; errorCount: number } {
  const max = options.maxItems ?? 12
  const where = options.config ?? 'tsconfig.json'
  const took = options.elapsedMs === undefined ? '' : `, ${(options.elapsedMs / 1000).toFixed(1)}s`
  const count = result.diagnostics.length

  if (ok) {
    return { ok: true, errorCount: 0, text: `✓ Typecheck passed (${where}${took})` }
  }

  const head =
    count > 0
      ? `✗ Typecheck failed: ${count} ${count === 1 ? 'error' : 'errors'} (${where}${took})`
      : // 措辞里有 "did not run"：Reviewer 的提示词教模型认这句话（见 roles.ts），别随手改成 "failed"
        `✗ Typecheck did not run (${where}${took}, exit code ${options.exitCode ?? 'timeout/killed'})`

  const body = result.diagnostics
    .slice(0, max)
    .map((item) => `  ${item.file}:${item.line}:${item.column}  ${item.code}  ${item.message}`)
  if (count > max) body.push(`  … ${count - max} more not listed`)
  // `other` 在"没有诊断"时是唯一线索，必须给出来，否则模型只知道"失败了"不知道为什么
  if (result.other.length > 0) {
    body.push('  ----')
    for (const line of result.other.slice(0, 8)) body.push(`  ${line}`)
    if (result.other.length > 8) body.push(`  … ${result.other.length - 8} more output lines not listed`)
  }
  return { ok: false, errorCount: count, text: [head, ...body].join('\n') }
}
