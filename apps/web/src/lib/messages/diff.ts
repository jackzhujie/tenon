/**
 * 改动面板（diff）的文案。
 */
export const diffEn = {
  'diff.title': 'Changes',
  'diff.files': '{count} files',
  'diff.files.one': '{count} file',
  'diff.loading': 'Loading…',
  'diff.expandFile': 'Show the whole file',
  'diff.wholeFile': 'All lines',
  'diff.binary': 'Binary file — no line-by-line comparison',
  'diff.truncated': 'File too large — line comparison omitted',
  'diff.skipRows': '⋯ skipped {count} lines',
  'diff.skipRows.one': '⋯ skipped {count} line',

  'diff.revert.action': 'Revert this version',
  'diff.revert.close': 'Close (Esc)',
  'diff.revert.warning': 'Reverting {sha} writes a new commit — history is kept, nothing is erased.',
  'diff.revert.dbLabel': 'Also roll the database back to before this version',
  'diff.revert.dbSnapshot': 'a snapshot was saved for this version',
  'diff.revert.dbNoSnapshot': 'no snapshot here, so it rolls back to the most recent one',
  'diff.revert.dbLoss': 'Data written after that point will be dropped.',
  'diff.revert.codeOnly': 'This version did not change the schema — only code is reverted.',
  'diff.revert.running': 'Reverting…',
  'diff.revert.confirmBoth': 'Revert code and data',
  'diff.revert.confirm': 'Revert',
  'diff.revert.hint': 'Revert the changes in {sha} "{message}"? This writes a new commit; history is kept.',

  'diff.versions.title': 'Versions (click one to see its changes)',
  'diff.versions.empty': 'No commits yet',
  'diff.versions.latest': 'latest',
  'diff.empty.noChanges': 'This version has no file changes.',
  'diff.empty.pick': 'Pick a version on the left.',
} as const

export type DiffKey = keyof typeof diffEn

export const diffZh: Record<DiffKey, string> = {
  'diff.title': '改动',
  'diff.files': '{count} 个文件',
  'diff.files.one': '{count} 个文件',
  'diff.loading': '读取中…',
  'diff.expandFile': '展开整个文件',
  'diff.wholeFile': '全文',
  'diff.binary': '二进制文件，不做逐行比较',
  'diff.truncated': '文件太大，已省略逐行比较',
  'diff.skipRows': '⋯ 跳过 {count} 行',
  'diff.skipRows.one': '⋯ 跳过 {count} 行',

  'diff.revert.action': '回滚这一版',
  'diff.revert.close': '关闭（Esc）',
  'diff.revert.warning': '回滚 {sha} 会写一条新提交（历史保留，不抹掉）。',
  'diff.revert.dbLabel': '连数据库一起回到这一版之前',
  'diff.revert.dbSnapshot': '这一版存过快照',
  'diff.revert.dbNoSnapshot': '这一版没存快照，会退到最近一份',
  'diff.revert.dbLoss': '该时点之后写入的数据会被丢弃。',
  'diff.revert.codeOnly': '这一版没动表结构，只有代码会回滚。',
  'diff.revert.running': '回滚中…',
  'diff.revert.confirmBoth': '回滚代码与数据',
  'diff.revert.confirm': '确定回滚',
  'diff.revert.hint': '回滚 {sha}「{message}」的改动？会生成一条新的回滚提交，历史不丢。',

  'diff.versions.title': '版本（点一条看它改了什么）',
  'diff.versions.empty': '还没有提交',
  'diff.versions.latest': '最新',
  'diff.empty.noChanges': '这一版没有文件改动。',
  'diff.empty.pick': '从左边选一个版本。',
}
