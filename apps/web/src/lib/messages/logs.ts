/**
 * 日志面板与"发给 Agent"提示词的文案。
 *
 * 提示词也算文案：它会被塞进输入框让用户看见、也决定 Agent 用什么语言回话 ——
 * 中文界面配英文回复（或反过来）都是半翻译。
 */
export const logsEn = {
  'log.title': 'Logs',
  'log.expand': 'Show logs',
  'log.collapse': 'Hide logs',
  'log.errors': '{count} errors',
  'log.errors.one': '{count} error',
  'log.showSource': 'Show {source} logs',
  'log.hideSource': 'Hide {source} logs',
  'log.raiseFilter': 'Click to raise the filter level',
  'log.clearTitle': 'Clear logs',
  'log.clear': 'Clear',
  'log.empty.never': 'No logs yet. Once the preview starts, build, backend and in-page errors show up here in real time.',
  'log.empty.filtered': 'No logs under the current filter.',
  'log.askFix.title': 'Send this line (with a few around it) to the agent to fix',
  'log.askFix.button': 'Send to agent',

  'log.source.web': 'frontend',
  'log.source.api': 'backend',
  'log.source.vite': 'build',
  'log.source.db': 'database',
  'log.source.tenon': 'platform',

  'log.filter.all': 'All',
  'log.filter.warn': 'Warnings+',
  'log.filter.error': 'Errors only',

  /* ---- 发给 Agent 的提示词 ---- */
  'log.prompt.intro':
    'This runtime log shows an error — please locate and fix it. **Read the relevant code before changing anything; do not guess from the error text.**',
  'log.prompt.repeat': ' (repeated {count} times)',
  'log.prompt.truncated': '\n… (truncated)',
  'log.prompt.context': 'Earlier log lines (context):',
  'log.prompt.outro': 'When done, tell me which files you changed and why.',
} as const

export type LogsKey = keyof typeof logsEn

export const logsZh: Record<LogsKey, string> = {
  'log.title': '日志',
  'log.expand': '展开日志',
  'log.collapse': '收起日志',
  'log.errors': '{count} 条错误',
  'log.errors.one': '{count} 条错误',
  'log.showSource': '显示{source}日志',
  'log.hideSource': '隐藏{source}日志',
  'log.raiseFilter': '点一下提高过滤级别',
  'log.clearTitle': '清空日志',
  'log.clear': '清空',
  'log.empty.never': '还没有日志。启动预览后，构建、后端与页面里的错误会实时出现在这里。',
  'log.empty.filtered': '当前筛选下没有日志。',
  'log.askFix.title': '把这条（含前后几行）发给 Agent 修',
  'log.askFix.button': '发给 Agent',

  'log.source.web': '前端',
  'log.source.api': '后端',
  'log.source.vite': '构建',
  'log.source.db': '数据',
  'log.source.tenon': '平台',

  'log.filter.all': '全部',
  'log.filter.warn': '警告+',
  'log.filter.error': '仅错误',

  'log.prompt.intro': '这条运行日志报错了，帮我定位并修掉。**先读相关代码再改，别照着报错文本猜**。',
  'log.prompt.repeat': '（重复 {count} 次）',
  'log.prompt.truncated': '\n…（截断）',
  'log.prompt.context': '前面几行日志（上下文）：',
  'log.prompt.outro': '改完告诉我：改了哪个文件、为什么这么改。',
}
