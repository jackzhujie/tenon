/**
 * 把一条运行日志（含前后几行上下文）拼成"发给 Agent"的提示词。
 *
 * 为什么要有上下文：**单看最后一行经常没用**。Vite 的真实报错常常是"第 3 行说某个
 * import 找不到，最后一行只说 `Failed to load url`"。只发最后一行，Agent 会去猜。
 *
 * 为什么带"先看代码再改"：这条提示是从日志面板点出来的，用户要的是**修掉**，
 * 不是解释。但也明确要求它先读代码 —— 否则模型容易照着错误文本编一个改动。
 *
 * 纯函数：在这里拼好文本，`LogPanel` 只负责把它塞进输入框（测试见
 * `apps/web/test/log-prompt.test.ts`）。
 */
import type { LogEntry, LogSource } from '@tenon/protocol'

const SOURCE_LABEL: Record<LogSource, string> = {
  web: '前端',
  api: '后端',
  vite: '构建',
  db: '数据',
  tenon: '平台',
}

/** 堆栈太长会把输入框撑爆；保留前面一段就够定位（真要全部，用户可以自己复制） */
const MAX_DETAIL_CHARS = 3000
/** 默认带几行上下文：4 行差不多是"同一段输出里的前几条" */
const DEFAULT_CONTEXT = 4

function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function oneLine(entry: LogEntry): string {
  const repeat = entry.repeat > 1 ? `（重复 ${entry.repeat} 次）` : ''
  return `[${entry.level}] ${SOURCE_LABEL[entry.source]} ${clockOf(entry.at)}  ${entry.message}${repeat}`
}

export function buildLogPrompt(
  entries: readonly LogEntry[],
  target: LogEntry,
  contextLines: number = DEFAULT_CONTEXT,
): string {
  const index = entries.findIndex((entry) => entry.id === target.id)
  const before =
    index < 0 ? [] : entries.slice(Math.max(0, index - Math.max(0, contextLines)), index).map(oneLine)

  const detail =
    target.detail === null
      ? ''
      : `\n\n\`\`\`\n${target.detail.slice(0, MAX_DETAIL_CHARS)}${
          target.detail.length > MAX_DETAIL_CHARS ? '\n…（截断）' : ''
        }\n\`\`\``

  const lines = [
    '这条运行日志报错了，帮我定位并修掉。**先读相关代码再改，别照着报错文本猜**。',
    '',
    oneLine(target) + detail,
  ]
  if (before.length > 0) {
    lines.push('', '前面几行日志（上下文）：', ...before)
  }
  lines.push('', '改完告诉我：改了哪个文件、为什么这么改。')
  return lines.join('\n')
}
