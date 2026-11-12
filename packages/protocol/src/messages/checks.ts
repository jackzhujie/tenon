/**
 * 发布门禁的三项检查：名字、结论、以及"为什么没跑成"。
 *
 * 这些句子有两个去处，所以必须走同一张表：**发布记录**（`releases.gate_summary`，
 * 历史里存着一份）与**发布会话框**（当下这一列）。两边各写一份的后果很具体 ——
 * 记录里是「类型检查 ✓」而界面上是 `lint ✓`，同一个东西两个名字。
 *
 * 英文侧别写成 `Passed (2 tsconfigs, 4.1s)` 的中译英：读者要的是"过没过"，
 * 括号里的东西是"凭什么"。
 */
export const checksEn = {
  'check.label.typecheck': 'Typecheck',
  'check.label.test': 'Tests',
  'check.label.lint': 'Lint',

  'check.skip.noTsconfig': 'Skipped: no tsconfig.json',
  'check.skip.noPackage': 'Skipped: no package.json',
  'check.skip.noScript': 'Skipped: package.json has no scripts.{name}',

  'check.fail.noTypescript': 'Did not run: typescript is not installed (dependencies are not ready)',
  'check.fail.depsMissing': 'Did not run: dependencies are not installed (no node_modules)',
  'check.fail.timeout': 'Timed out (over {seconds}s — stopped)',
  'check.fail.notStarted': 'Did not run: the {name} script would not start',
  'check.fail.commandMissing': 'Did not run: a command in the {name} script is missing (incomplete dependencies)',
  'check.fail.exitCode': 'Failed (pnpm run {name} exited with {code})',
  'check.fail.typecheck': 'Failed: {failed}',
  'check.fail.typecheckErrors': '{config} — {count} errors',
  'check.fail.typecheckErrors.one': '{config} — 1 error',
  'check.fail.typecheckNotRun': '{config} did not run ({reason})',

  'check.pass.typecheck': 'Passed ({where}, {elapsed})',
  'check.pass.script': 'Passed (pnpm run {name}, {elapsed})',

  'check.reason.timeout': 'timed out',
  'check.reason.exitCode': 'exit code {code}',
  'check.reason.noStart': 'would not start',

  'check.where.configs': '{count} tsconfigs',
  'check.where.configs.one': '{count} tsconfig file',

  /** 列表分隔符：中文用顿号、英文用逗号，这件事没法"翻译"，只能给一个键 */
  'check.listSeparator': ', ',

  /** 展开明细时那句建议 —— 它是给人看的，不是给模型看的（后者见 `sections`） */
  'check.hint.openPreviewFirst': 'Ask the user to open the preview once (that installs dependencies), then publish again.',
} as const

export type CheckMessageKey = keyof typeof checksEn

export const checksZh: Record<CheckMessageKey, string> = {
  'check.label.typecheck': '类型检查',
  'check.label.test': '测试',
  'check.label.lint': 'Lint',

  'check.skip.noTsconfig': '跳过：没有 tsconfig.json',
  'check.skip.noPackage': '跳过：没有 package.json',
  'check.skip.noScript': '跳过：package.json 里没有 scripts.{name}',

  'check.fail.noTypescript': '没跑成：没有装 typescript（依赖还没装好）',
  'check.fail.depsMissing': '没跑成：依赖还没装（没有 node_modules）',
  'check.fail.timeout': '超时（超过 {seconds}s，已终止）',
  'check.fail.notStarted': '没跑成：{name} 脚本起不来',
  'check.fail.commandMissing': '没跑成：{name} 脚本里的命令没装（依赖不完整）',
  'check.fail.exitCode': '失败（pnpm run {name} 退出码 {code}）',
  'check.fail.typecheck': '没过：{failed}',
  'check.fail.typecheckErrors': '{config} {count} 个错误',
  'check.fail.typecheckErrors.one': '{config} {count} 个错误',
  'check.fail.typecheckNotRun': '{config} 没跑成（{reason}）',

  'check.pass.typecheck': '通过（{where}，{elapsed}）',
  'check.pass.script': '通过（pnpm run {name}，{elapsed}）',

  'check.reason.timeout': '超时',
  'check.reason.exitCode': '退出码 {code}',
  'check.reason.noStart': '起不来',

  'check.where.configs': '{count} 个 tsconfig',
  'check.where.configs.one': '{count} 个 tsconfig',

  'check.listSeparator': '、',

  'check.hint.openPreviewFirst': '让用户先把预览打开一次（会装依赖），然后再发布。',
}
