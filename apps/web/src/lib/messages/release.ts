/**
 * 发布对话框与远端仓库配置的文案。
 *
 * 带内联强调的句子拆成 `before` / `emphasis` / `after` 三段：
 * 位置不能靠中文语序猜，英文里那个强调词可能落在完全不同的地方。
 */
export const releaseEn = {
  'release.title': 'Publish',
  'release.titleWithApp': 'Publish · {app}',
  'release.close': 'Close',
  'release.copy': 'Copy',
  'release.copyPath': 'Copy path',
  'release.copied': 'Copied',
  'release.showOutput': 'Show output',

  /* ---- 头部 ---- */
  'release.header.body.before':
    'Freeze the current commit into a version and push it to the local backup repo — a standard bare repo, so ',
  'release.header.body.emphasis': 'a git clone gives you the full code of this version',
  'release.header.body.after': '.',
  'release.thisVersion': 'This version',
  'release.noCommits': 'No commits yet',

  /* ---- 预检 ---- */
  'release.check.running': 'Running typecheck and tests…',
  'release.check.real.before': 'This actually runs ',
  'release.check.real.emphasis': 'the real checks',
  'release.check.real.after': ' (it does not reuse the last result). Apps with tests can take tens of seconds.',
  'release.check.crashed': 'Preflight could not run: {error}',
  'release.check.crashedNote':
    'That does not mean the code is broken — publishing runs the full check again on the server.',
  'release.check.notRun.before': 'The preconditions for publishing are not met, so ',
  'release.check.notRun.emphasis': 'no',
  'release.check.notRun.after': ' typecheck or tests were run.',
  'release.check.stale.before': 'A new commit landed while checking — this result describes ',
  'release.check.stale.after': ' and does not count.',
  'release.check.staleNote':
    'Reusing a pass from version A for version B is worse than not checking at all: it gives false confidence. Run it again.',
  'release.check.failed': 'Checks failed — do not publish yet',
  'release.check.failedHint': 'Fix it, then click "Re-check". If you really mean it, click "Publish anyway" — history will mark it.',
  'release.check.passed': '✓ Checks passed — ready to publish',
  'release.check.passedNote':
    'Publishing runs them again (results are not cached — code or dependencies may have changed), so you will wait once more.',
  'release.check.cacheNote':
    'Checked {time} for the same code — nothing changed, so the result was reused. Click "Re-check" to run it again.',
  'release.check.typecheck': 'Typecheck',
  'release.check.test': 'Tests',
  'release.check.lint': 'Lint',

  /* ---- 主按钮 ---- */
  'release.action.publishing': 'Publishing…',
  'release.action.blocked': 'Fix the problems above first',
  'release.action.checking': 'Checking…',
  'release.action.recheck': 'Re-check',
  'release.action.confirmForce': 'Confirm: publish with issues',
  'release.action.publish': 'Publish',
  'release.action.publishAgain': 'Publish another version',
  'release.action.publishAnyway': 'Publish anyway',
  'release.action.confirmNotice': 'Click again to really publish — history will mark it "with issues"',

  /* ---- 发布说明 ---- */
  'release.notes.label': 'Release notes (optional)',
  'release.notes.placeholder': 'What changed in this version, and why publish it',
  'release.notes.hint': 'It goes into the tag body, so anyone who clones the backup repo sees it.',

  /* ---- 结果 ---- */
  'release.result.checks': 'Checks',
  'release.result.backup': 'Backup repo',
  'release.result.clone': 'Clone the full code of this version',
  'release.result.cloneCommand': 'git clone {path}',
  'release.result.remote': 'Remote',
  'release.result.pushed': 'Pushed to {target} ({count} refs)',
  'release.result.remoteFallback': 'the remote repository',
  'release.remote.pushing': 'Pushing…',
  'release.remote.retry': 'Push again',
  'release.remote.pushNote': 'This version is already published — pushing again does not create another version number.',
  'release.remote.retryHint':
    'Click again to retry. If it still fails, make sure the remote URL opens right now and that the network or proxy works.',

  /* ---- 导出 ---- */
  'release.deploy.title': 'Deploy',
  'release.export.static': 'Export static bundle',
  'release.export.docker': 'Export Docker',
  'release.export.running': 'Exporting… {seconds}s',
  'release.export.dockerContext': 'Docker context (cd in and run docker compose up -d)',
  'release.export.staticWithApi': 'Static bundle · with backend (migrations run automatically)',
  'release.export.staticOnly': 'Static bundle · frontend only',

  'release.done.published': 'Published {version}',
  'release.export.help':
    'Static bundle: copy it to a machine with Node and run start.sh (production deps included). Docker: the same output plus Dockerfile/compose — docker compose up -d brings it up, database included. Both read a single DATABASE_URL. Exporting really runs a build (tens of seconds to two minutes); progress shows in the log at the bottom left.',
  'release.export.summary':
    '{size}MB · {files} files · {kind}. The README inside explains how to start it.',

  /* ---- 历史 ---- */
  'release.history.title': 'Release history',
  'release.history.empty': 'Nothing published yet.',
  'release.forced.title': 'Published with issues',
  'release.forced.badge': 'with issues',

  /* ---- 远端仓库（RemoteSection） ---- */
  'remote.title': 'Remote repository',
  'remote.notConfigured': 'Not configured · optional — when set, each publish also pushes a copy to GitHub etc.',
  'remote.branchToken': '{branch} · token {hint}',
  'remote.branchNoToken': '{branch} · no token',
  'remote.clear': 'Remove',
  'remote.toggle.collapse': 'Collapse',
  'remote.toggle.configure': 'Configure',
  'remote.toggle.edit': 'Edit',
  'remote.note':
    'Every publish also pushes a copy here (branch + version tag). A failed push does not void the release — the local backup repo already holds a complete version, and you can push again later.',
  'remote.urlLabel': 'Repository URL (https only)',
  'remote.urlPlaceholder': 'https://github.com/me/my-app.git',
  'remote.usernameLabel': 'Username (optional)',
  'remote.usernamePlaceholder': 'oauth2 for GitLab',
  'remote.branchLabel': 'Branch',
  'remote.tokenLabel': 'Access token',
  'remote.tokenSaved': '(saved {hint}, leave empty to keep)',
  'remote.tokenKeep': 'Leave empty to keep the saved token',
  'remote.tokenNew': 'ghp_… or glpat-…',
  'remote.encrypt.before':
    'The token is encrypted on this machine (AES-256-GCM) and never shown again. Use a GitHub Fine-grained token with ',
  'remote.encrypt.emphasis': 'Contents: Read and write',
  'remote.encrypt.after': ' and select this repository.',
  'remote.saveSaving': 'Saving…',
  'remote.save': 'Save',
  'remote.savedHint': 'Saving does not push right away — it goes out with the next publish',
} as const

export type ReleaseKey = keyof typeof releaseEn

export const releaseZh: Record<ReleaseKey, string> = {
  'release.title': '发布',
  'release.titleWithApp': '发布 · {app}',
  'release.close': '关闭',
  'release.copy': '复制',
  'release.copyPath': '复制路径',
  'release.copied': '已复制',
  'release.showOutput': '看输出',

  'release.header.body.before': '把当前提交冻结成一个版本，推到本地备份库。备份库是标准裸库，',
  'release.header.body.emphasis': 'git clone 出来就是这一版的完整代码',
  'release.header.body.after': '。',
  'release.thisVersion': '这一版',
  'release.noCommits': '还没有任何提交',

  'release.check.running': '正在跑类型检查与测试…',
  'release.check.real.before': '这一步会',
  'release.check.real.emphasis': '真跑一遍',
  'release.check.real.after': '（不是读上一次的结果），有测试的应用可能要几十秒。',
  'release.check.crashed': '预检没跑起来：{error}',
  'release.check.crashedNote': '这不代表代码有问题 —— 点发布时服务端还会完整检查一遍。',
  'release.check.notRun.before': '现在不满足发布的前提，所以这一步',
  'release.check.notRun.emphasis': '没有',
  'release.check.notRun.after': '跑类型检查和测试。',
  'release.check.stale.before': '检查期间又有新提交，这份结果讲的是 ',
  'release.check.stale.after': ' 那一版，不算数。',
  'release.check.staleNote': '针对 A 版的"通过"拿去给 B 版用，比不检查更糟 —— 它给的是虚假的安心。再查一次。',
  'release.check.failed': '检查没通过，先别发',
  'release.check.failedHint': '修好再点「重新检查」；确实要发就点「仍然发布」，历史里会标「带问题」。',
  'release.check.passed': '✓ 检查通过，可以发',
  'release.check.passedNote': '点发布会再跑一遍（结果不缓存 —— 两次之间代码或依赖都可能变），所以还会再等一次。',
  'release.check.cacheNote':
    '这是 {time} 的检查结果（同一版代码）—— 代码没变就直接用了，没重跑。想再看一遍点「重新检查」。',
  'release.check.typecheck': '类型检查',
  'release.check.test': '测试',
  'release.check.lint': 'Lint',

  'release.action.publishing': '发布中…',
  'release.action.blocked': '先处理上面的问题',
  'release.action.checking': '检查中…',
  'release.action.recheck': '重新检查',
  'release.action.confirmForce': '确认：带着问题发布',
  'release.action.publish': '发布',
  'release.action.publishAgain': '再发一版',
  'release.action.publishAnyway': '仍然发布',
  'release.action.confirmNotice': '再点一次就真的发出去 —— 历史里会标「带问题」',

  'release.notes.label': '发布说明（可选）',
  'release.notes.placeholder': '这一版改了什么、为什么要发',
  'release.notes.hint': '会写进这次 tag 的正文，拿备份库的人也能看到。',

  'release.result.checks': '检查',
  'release.result.backup': '备份库',
  'release.result.clone': '克隆这一版的完整代码',
  'release.result.cloneCommand': 'git clone {path}',
  'release.result.remote': '远端',
  'release.result.pushed': '已推到 {target}（{count} 个 ref）',
  'release.result.remoteFallback': '远端仓库',
  'release.remote.pushing': '推送中…',
  'release.remote.retry': '再推一次',
  'release.remote.pushNote': '这一版已经发出去了，补推不会多出一个版本号',
  'release.remote.retryHint': '再点一次重试；还不行就确认远端地址现在能打开、网络或代理正常。',

  'release.deploy.title': '拿去部署',
  'release.export.static': '导出静态包',
  'release.export.docker': '导出 Docker',
  'release.export.running': '导出中… {seconds}s',
  'release.export.dockerContext': 'Docker 上下文（cd 进去 docker compose up -d）',
  'release.export.staticWithApi': '静态包 · 含后端（迁移会自动跑）',
  'release.export.staticOnly': '静态包 · 纯前端',

  'release.done.published': '已发布 {version}',
  'release.export.help':
    '静态包：拷到有 Node 的机器上跑 start.sh（自带生产依赖）。Docker：同一份产物 + Dockerfile/compose，docker compose up -d 即起，数据库也一起带。两者都只认一个 DATABASE_URL。导出会真跑一次构建（几十秒到两分钟），进度在左下角日志里。',
  'release.export.summary':
    '{size}MB · {files} 个文件 · {kind}。产物里的 README 写了怎么起。',

  'release.history.title': '发布历史',
  'release.history.empty': '还没有发布过。',
  'release.forced.title': '检查没通过仍然发布',
  'release.forced.badge': '带问题',

  'remote.title': '远端仓库',
  'remote.notConfigured': '未配置 · 可选，配了就同时推一份到 GitHub 等',
  'remote.branchToken': '{branch} · 令牌 {hint}',
  'remote.branchNoToken': '{branch} · 无令牌',
  'remote.clear': '清除',
  'remote.toggle.collapse': '收起',
  'remote.toggle.configure': '配置',
  'remote.toggle.edit': '修改',
  'remote.note':
    '每次发布都会推一份到这里（分支 + 版本标签）。推送失败不会让这次发布作废 —— 本地备份库已经是完整的一版，可以稍后「再推一次」。',
  'remote.urlLabel': '仓库地址（只收 https）',
  'remote.urlPlaceholder': 'https://github.com/me/my-app.git',
  'remote.usernameLabel': '用户名（可选）',
  'remote.usernamePlaceholder': 'GitLab 填 oauth2',
  'remote.branchLabel': '分支',
  'remote.tokenLabel': '访问令牌',
  'remote.tokenSaved': '（已存 {hint}，留空表示不改）',
  'remote.tokenKeep': '留空则保持原令牌',
  'remote.tokenNew': 'ghp_… 或 glpat-…',
  'remote.encrypt.before': '令牌加密存在本机（AES-256-GCM），不会回显。GitHub 用 Fine-grained token，权限勾 ',
  'remote.encrypt.emphasis': 'Contents: Read and write',
  'remote.encrypt.after': ' 并选中这个仓库。',
  'remote.saveSaving': '保存中…',
  'remote.save': '保存',
  'remote.savedHint': '保存后不会立刻推送 —— 下次发布时一起推',
}
