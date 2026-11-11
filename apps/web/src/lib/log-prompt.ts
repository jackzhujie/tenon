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
import type { LogEntry } from '@tenon/protocol'
import type { TFunction } from './i18n.js'

/** 堆栈太长会把输入框撑爆；保留前面一段就够定位（真要全部，用户可以自己复制） */
const MAX_DETAIL_CHARS = 3000
/** 默认带几行上下文：4 行差不多是"同一段输出里的前几条" */
const DEFAULT_CONTEXT = 4

function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function oneLine(entry: LogEntry, t: TFunction): string {
  const repeat = entry.repeat > 1 ? t('log.prompt.repeat', { count: entry.repeat }) : ''
  return `[${entry.level}] ${t(`log.source.${entry.source}` as 'log.source.web')} ${clockOf(entry.at)}  ${entry.message}${repeat}`
}

export function buildLogPrompt(
  entries: readonly LogEntry[],
  target: LogEntry,
  t: TFunction,
  contextLines: number = DEFAULT_CONTEXT,
): string {
  const index = entries.findIndex((entry) => entry.id === target.id)
  const before =
    index < 0
      ? []
      : entries
          .slice(Math.max(0, index - Math.max(0, contextLines)), index)
          .map((entry) => oneLine(entry, t))

  const detail =
    target.detail === null
      ? ''
      : `\n\n\`\`\`\n${target.detail.slice(0, MAX_DETAIL_CHARS)}${
          target.detail.length > MAX_DETAIL_CHARS ? t('log.prompt.truncated') : ''
        }\n\`\`\``

  const lines = [t('log.prompt.intro'), '', oneLine(target, t) + detail]
  if (before.length > 0) {
    lines.push('', t('log.prompt.context'), ...before)
  }
  lines.push('', t('log.prompt.outro'))
  return lines.join('\n')
}
