/**
 * 应用菜单与新建对话框的文案。
 */
export const appsEn = {
  'apps.select': 'Select app',
  'apps.empty': 'No apps yet',
  'apps.deleting': 'Deleting…',
  'apps.delete': 'Delete',
  'apps.save': 'Save',
  'apps.saving': 'Saving…',
  'apps.renameTitle': 'Rename "{name}"',
  'apps.deleteTitle': 'Delete "{name}"',
  'apps.new': 'New app',

  'apps.new.body':
    'Just say what it should do. The agent picks the stack from the requirement and adds a backend when needed.',
  'apps.new.name': 'Name',
  'apps.new.namePlaceholder': 'e.g. Expense approvals',
  'apps.new.brief': 'What should it do?',
  'apps.new.briefHint': '(optional — sent to the agent right after creation)',
  'apps.new.briefPlaceholder':
    'e.g. an expense approval tool with submit, approve and history views; data must persist',
  'apps.new.stack.before': 'Stack: ',
  'apps.new.stack.emphasis': 'decided by the agent',
  'apps.new.advancedShow': 'I want to choose',
  'apps.new.collapse': 'Collapse',
  'apps.new.template': 'Template',
  'apps.new.templateFailed': 'Could not load templates — the default react-vite will be used.',
  'apps.new.creating': 'Creating…',
  'apps.new.create': 'Create',

  'apps.deleteConfirm':
    'Delete "{name}"? Its code, database, logs and published backups go with it. This cannot be undone.',
} as const

export type AppsKey = keyof typeof appsEn

export const appsZh: Record<AppsKey, string> = {
  'apps.select': '选择应用',
  'apps.empty': '还没有应用',
  'apps.deleting': '删除中…',
  'apps.delete': '删除',
  'apps.save': '保存',
  'apps.saving': '保存中…',
  'apps.renameTitle': '重命名「{name}」',
  'apps.deleteTitle': '删除「{name}」',
  'apps.new': '新建应用',

  'apps.new.body': '说一句要做什么就行。技术栈由 Agent 按需求决定，需要后端时它会自己加上。',
  'apps.new.name': '名称',
  'apps.new.namePlaceholder': '例如：报销单审批',
  'apps.new.brief': '要做什么',
  'apps.new.briefHint': '（可选，建完直接发给 Agent）',
  'apps.new.briefPlaceholder': '例如：一个报销单审批工具，能提交、审批、看历史；数据要能存下来',
  'apps.new.stack.before': '技术栈：',
  'apps.new.stack.emphasis': '由 Agent 决定',
  'apps.new.advancedShow': '我要自己选',
  'apps.new.collapse': '收起',
  'apps.new.template': '模板',
  'apps.new.templateFailed': '模板列表没拉到，将使用默认的 react-vite。',
  'apps.new.creating': '创建中…',
  'apps.new.create': '创建',

  'apps.deleteConfirm': '删除「{name}」？代码、数据库、日志和已发布的备份会一起删掉，不能恢复。',
}
