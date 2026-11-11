/**
 * 对话区的文案：子 Agent 卡片、工具行、输入框、空状态、系统消息。
 *
 * 复数拆 `.one` / `.other`；中文两个键写同一句（`{count}` 照常插值）。
 */
export const chatEn = {
  /* ---- 子 Agent 与任务状态（lib/agent-labels.ts） ---- */
  'agent.status.pending': 'Queued',
  'agent.status.running': 'Running',
  'agent.status.waiting': 'Waiting',
  'agent.status.waitingFor': 'waiting on {count} subtasks',
  'agent.status.waitingFor.one': 'waiting on {count} subtask',
  'agent.status.retrying': 'Retrying',
  'agent.status.completing': 'Finishing',
  'agent.phase.prepare': 'Preparing context',
  'agent.phase.request': 'Waiting for model',
  'agent.phase.tools': 'Running tools',
  'agent.phase.call': 'Dispatching tool',
  'agent.phase.execute': 'Executing',
  'agent.title.root': 'Main conversation',
  'agent.title.subagent': 'Sub-agent',
  'agent.title.tool': 'Tool call',
  'agent.title.delegated': 'Delegated to {role}',

  /* ---- 主对话此刻在干什么（lib/task-tree.ts） ---- */
  'agent.activity.prepare': 'Organizing context',
  'agent.activity.request': 'Waiting for the model',
  'agent.activity.tools': 'Still chaining tools',
  'agent.activity.call': 'Dispatching a tool',
  'agent.activity.execute': 'Executing',

  /* ---- 工具组摘要（lib/tool-groups.ts） ---- */
  'tool.summary.files': 'read {count} files',
  'tool.summary.files.one': 'read {count} file',
  'tool.summary.commands': 'ran {count} commands',
  'tool.summary.commands.one': 'ran {count} command',
  'tool.summary.others': 'checked {count} items',
  'tool.summary.others.one': 'checked {count} item',

  /* ---- 工具名标签（MessageList 的 TOOL_LABEL）---- */
  'tool.label.read': 'Read',
  'tool.label.write': 'Write',
  'tool.label.edit': 'Edit',
  'tool.label.bash': 'Run',
  'tool.label.subagent': 'Delegate',
  'tool.label.addBackend': 'Add backend',
  'tool.label.installComponent': 'Install component',
  'tool.label.removeComponent': 'Remove component',
  'tool.label.listComponents': 'List components',
  'tool.label.typecheck': 'Typecheck',
  'tool.label.gitDiff': 'View diff',
  'tool.label.previewAssert': 'Assert page',
  'tool.label.previewScreenshot': 'Screenshot',
  'tool.label.previewClick': 'Click page',
  'tool.label.previewOpen': 'Open page',

  /* ---- 工具卡片 ---- */
  'chat.tool.spendHint': 'Usage spent on this delegation (not this role in total)',
  'chat.tool.runningHint': 'Still running — output arrives in chunks',
  'chat.tool.empty': 'This call produced no output',
  'chat.card.detail': 'Details',
  'chat.card.collapse': 'Collapse',
  'chat.card.expand': 'Expand',
  'chat.explore.title': 'Reading code',
  'chat.live.thinking': 'Thinking…',

  'chat.status.idle': 'Idle',
  'chat.status.running': 'Running',
  'chat.status.error': 'Error',
  'chat.status.archived': 'Archived',
  'chat.status.preparing': 'Preparing',
  'chat.versions': '{count} versions',
  'chat.versions.one': '{count} version',

  /* ---- 空状态 ---- */
  'chat.empty.noApps.title': 'No apps yet',
  'chat.empty.noApps.body':
    'Create one and this becomes the place to talk. The agent edits files in the workspace directly and commits once per turn.',
  'chat.empty.noApps.create': 'New app',
  'chat.empty.pickApp': 'Pick an app from the top left, or create one.',
  'chat.ready.title': 'Workspace ready',
  /* 两句要拼一个内联的 `repo/`：前半句以空格结尾，后半句以空格开头（中文两侧都不加） */
  'chat.ready.body.before': 'Describe the interface you want. The agent reads and writes files in ',
  'chat.ready.body.after': ', and the preview on the right hot-reloads.',

  /* ---- 输入框 ---- */
  'chat.composer.selectionTitle': 'Drop this context',
  'chat.composer.selectionWillInclude': 'Included in this turn',
  'chat.composer.placeholder.disabled': 'Pick an app first',
  'chat.composer.placeholder.ready': 'Say what you want to build — Enter to send, Shift+Enter for a new line',
  'chat.composer.placeholder.connecting': 'Connecting to the local service…',
  'chat.stream.reconnecting': 'Disconnected — reconnecting…',
  'chat.stream.failed': 'Disconnected. Reload the page to retry',
  'chat.composer.stop': 'Stop',
  'chat.composer.send': 'Send',
  'chat.composer.footer': 'Each turn is committed to git automatically, and any commit can be reverted.',

  /* ---- 派活卡片 ---- */
  'chat.delegation.failed': 'Failed',
  'chat.delegation.running': 'Running',
  'chat.delegation.done': 'Finished',
  'chat.delegation.runningHint': 'Still running — steps arrive in chunks',
  'chat.delegation.noConclusion': 'This delegation left no conclusion',
  'chat.delegation.conversation': 'sub-session #{id}',
  'chat.subagent.name': 'Sub-agent',
  'chat.subagent.steps': '{count} steps',
  'chat.subagent.steps.one': '{count} step',
} as const

/** 这个文件自己的 key 类型 —— 让 lib 层不必绕回 `i18n.tsx`（那里会 import 本文件） */
export type ChatKey = keyof typeof chatEn

export const chatZh: Record<ChatKey, string> = {
  'agent.status.pending': '排队',
  'agent.status.running': '运行中',
  'agent.status.waiting': '等待',
  'agent.status.waitingFor': '等 {count} 个子任务',
  'agent.status.waitingFor.one': '等 {count} 个子任务',
  'agent.status.retrying': '等重试',
  'agent.status.completing': '收尾',
  'agent.phase.prepare': '准备上下文',
  'agent.phase.request': '等模型',
  'agent.phase.tools': '串工具',
  'agent.phase.call': '调度工具',
  'agent.phase.execute': '执行中',
  'agent.title.root': '主对话',
  'agent.title.subagent': '子 Agent',
  'agent.title.tool': '工具调用',
  'agent.title.delegated': '派活 {role}',

  'agent.activity.prepare': '整理上下文',
  'agent.activity.request': '等模型回复',
  'agent.activity.tools': '还在串工具',
  'agent.activity.call': '调度工具',
  'agent.activity.execute': '执行中',

  'tool.summary.files': '读取 {count} 个文件',
  'tool.summary.files.one': '读取 {count} 个文件',
  'tool.summary.commands': '执行 {count} 条命令',
  'tool.summary.commands.one': '执行 {count} 条命令',
  'tool.summary.others': '查看 {count} 项',
  'tool.summary.others.one': '查看 {count} 项',

  'tool.label.read': '读取',
  'tool.label.write': '写入',
  'tool.label.edit': '修改',
  'tool.label.bash': '执行',
  'tool.label.subagent': '派活',
  'tool.label.addBackend': '加后端',
  'tool.label.installComponent': '装组件',
  'tool.label.removeComponent': '卸组件',
  'tool.label.listComponents': '列组件',
  'tool.label.typecheck': '类型检查',
  'tool.label.gitDiff': '看改动',
  'tool.label.previewAssert': '验页面',
  'tool.label.previewScreenshot': '看页面',
  'tool.label.previewClick': '点页面',
  'tool.label.previewOpen': '开页面',

  'chat.tool.spendHint': '这一次派活消耗的用量（不是这个角色的累计）',
  'chat.tool.runningHint': '还在执行，输出会一段一段出来',
  'chat.tool.empty': '这次调用没有输出',
  'chat.card.detail': '详情',
  'chat.card.collapse': '收起',
  'chat.card.expand': '展开',
  'chat.explore.title': '查看代码',
  'chat.live.thinking': '思考中…',

  'chat.status.idle': '空闲',
  'chat.status.running': '运行中',
  'chat.status.error': '出错',
  'chat.status.archived': '已归档',
  'chat.status.preparing': '准备中',
  'chat.versions': '{count} 个版本',
  'chat.versions.one': '{count} 个版本',

  'chat.empty.noApps.title': '还没有应用',
  'chat.empty.noApps.body': '建一个之后，这里就是对话的地方。Agent 会直接改工作区里的代码，每一轮结束自动提交一次 git。',
  'chat.empty.noApps.create': '新建应用',
  'chat.empty.pickApp': '从左上角选择一个应用，或者新建一个。',
  'chat.ready.title': '工作区已就绪',
  'chat.ready.body.before': '描述你要的界面，Agent 会读写 ',
  'chat.ready.body.after': ' 里的文件，右侧预览会跟着热更新。',

  /* ---- 派活卡片 ---- */
  'chat.composer.selectionTitle': '不带这个上下文',
  'chat.composer.selectionWillInclude': '这一轮会带上它',
  'chat.composer.placeholder.disabled': '先选择一个应用',
  'chat.composer.placeholder.ready': '说说你想做什么，Enter 发送，Shift+Enter 换行',
  'chat.composer.placeholder.connecting': '正在连接本地服务…',
  'chat.stream.reconnecting': '连接断开，正在重连…',
  'chat.stream.failed': '连接已断开，刷新页面重试',
  'chat.composer.stop': '停止',
  'chat.composer.send': '发送',
  'chat.composer.footer': '每一轮对话结束会自动提交一次 git，可随时回滚。',

  /* ---- 派活卡片 ---- */
  'chat.delegation.failed': '失败',
  'chat.delegation.running': '运行中',
  'chat.delegation.done': '已结束',
  'chat.delegation.runningHint': '还在跑，步骤会一段一段出来',
  'chat.delegation.noConclusion': '这次派活没有留下结论',
  'chat.delegation.conversation': '子会话 #{id}',
  'chat.subagent.name': '子 Agent',
  'chat.subagent.steps': '{count} 步',
  'chat.subagent.steps.one': '{count} 步',
}
