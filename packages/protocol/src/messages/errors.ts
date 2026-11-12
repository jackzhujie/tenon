/**
 * 服务端会**直接念给用户听**的句子（错误消息）。
 *
 * 为什么不用错误码当键：同一个 `code` 下有几件完全不同的事。`APP_NOT_FOUND` 既可能是
 * "这个应用没了"，也可能是"这个提供商没了"；把它们压成一句"找不到"会让用户不知道
 * 该去改什么 —— 而错误消息存在的唯一意义就是**指路**。所以键跟着**处境**走，不跟着码走。
 *
 * `details` 照旧带着结构化数据（前端按 code 分支、按 details 取值）；这里只是把
 * `message` 这一栏变成可翻译的。
 *
 * 写英文时不要逐字翻：读者在英文界面上要的是"我该做什么"，不是中文句子的镜像。
 */
export const errorsEn = {
  'error.assistant.questionEmpty': 'The question cannot be empty.',
  'error.assistant.noAnswer': 'The assistant finished without producing anything.',

  'error.chat.emptyInput': 'The message cannot be empty.',
  'error.chat.busy': 'This app is still generating — wait a moment and send again.',

  'error.model.providerGone': 'That provider no longer exists: {id}',
  'error.model.noApiKey': 'Provider "{label}" has no API key configured.',

  'error.assembly.invalid': 'The assembly declaration is invalid, so nothing was written.',

  'error.file.outside': 'That path is outside the app directory: {path}',
  'error.file.notFound': 'File not found: {path}',
  'error.file.tooLarge': 'File is too large ({size} bytes) to open here.',

  'error.git.notRepo': 'Not a git repository: {dir}',
  'error.git.diffFailed': 'Could not compare {from}..{to}',
  'error.git.commitMissing': 'No such commit: {sha}',
  'error.git.revertRoot': 'Reverting the very first commit is not supported — it would empty the repository.',
  'error.git.revertNoChange': 'Reverting {sha} produced no changes.',

  'error.release.noCommits': 'This app has no commits yet, so there is nothing to publish.',
  'error.release.generating': 'It is still generating — wait for this round to finish, then publish.',
  'error.release.dirty':
    'The workspace still has {count} uncommitted files ({files}) — let this round finish, then publish.',
  'error.release.unknownObject': 'Unrecognised object type: {type} ({oid})',
  'error.release.commitUnreadable': 'The revert commit was written but could not be read back.',
  'error.release.busyDuringCheck': 'New commits landed while checking — wait for this round to finish, then publish.',
  'error.release.backupPushFailed': 'Pushing to the backup repository failed: {detail}',
  'error.release.checksFailed':
    'Pre-publish checks failed: {failed}. Fix them and try again; if you really mean it, choose "Publish anyway".',
  'error.release.checkNotPassed': '{label}{summary}',

  'error.secret.corrupt': 'The key file is damaged: {file}',
  'error.secret.badLength': 'The ciphertext length is invalid.',
  'error.secret.mismatch': 'Cannot decrypt: the key does not match this ciphertext (did the machine change?).',

  'error.app.notFound': 'No such app: {id}',
  'error.app.homeMissing': 'Could not create the app directory.',
  'error.app.nameInvalid': 'The app name cannot be empty and must be at most 64 characters.',
  'error.app.refuseDelete': 'Refusing to delete a path outside the app directory: {path}',

  'error.provider.notFound': 'No such provider: {id}',
  'error.provider.unreadable': 'The provider could not be read back after writing.',

  'error.remote.badUrl': 'That is not a valid URL: {url}',
  'error.remote.notHttps': 'The repository URL must start with https:// — tokens must not travel in clear text.',

  'error.db.notStarted': 'The database has not started yet, so there is no connection string.',
  'error.db.notReadyForSnapshot': 'The database is not running, so it cannot be snapshotted.',
  'error.db.notLive': 'The database has not passed its health check yet.',
  'error.db.startFailed': 'The app database failed to start: {detail}',
  'error.db.noPort': 'The app database could not get a listening port.',
  'error.db.listenMissing': 'Internal error: no database instance while listening.',
  'error.db.backendWithoutDb': 'Internal error: a backend exists but there is no database.',
  'error.db.dumpFailed': 'Snapshot failed: {detail}',
  'error.db.restoreFailed': 'Restoring the snapshot failed: {detail}',
  'error.db.restoreRolledBack': 'Restore failed and was rolled back, so the database is unchanged: {detail}',
  'error.db.notSnapshot': 'This is not a Tenon database snapshot (gzip will not open it): {detail}',
  'error.db.notJson': 'The snapshot is not valid JSON: {detail}',
  'error.db.restoreUnsupported': 'The current database implementation cannot restore snapshots.',
  'error.db.noWritableColumns': '{table} has no writable columns (are they all generated?)',
  'error.db.noUserTables': 'The source database has no user tables (schemas: {schemas})',

  'error.preview.closing': 'The server is shutting down, so a preview cannot be started.',
  'error.preview.noAppDir': 'The app directory does not exist, so the preview cannot start.',
  'error.preview.portsExhausted': 'Could not get {count} free ports.',
  'error.preview.tscMissing': 'TypeScript not found — dependencies are not installed or the install failed.',
  'error.preview.tsconfigMissing': 'The backend needs to compile, but tsconfig.server.json is missing.',
  'error.deps.noPackage': 'This workspace has no package.json, so there is nothing to install.',
  'error.deps.viteMissing': 'vite not found — dependencies are not installed or the install failed.',

  'error.feature.noBackend': 'This workspace has no package.json, so a backend cannot be added.',
  'error.feature.noAuth': 'This workspace has no package.json, so sign-in cannot be added.',
  'error.feature.badJson': '{file} is not valid JSON, so fields cannot be merged into it.',
  'error.feature.notObject': 'The top level of {file} is not an object.',

  'error.template.unknown': 'No such template: {id}',
  'error.template.badManifest': 'The template manifest is not an object: {file}',
  'error.template.idMismatch': 'Template directory name and manifest id disagree: {dir} ≠ {id}',
  'error.template.varMissing': 'Template {at} needs {name}, but the caller did not provide it.',
  'error.template.varsMissing': 'Template {id} declares variables with no value: {names}',

  'error.request.sinceNotNumber': '`since` must be a number.',
  'error.request.invalid': 'The request parameters are not valid.',

  'error.export.noPackage': 'This workspace has no package.json, so there is nothing to export.',
  'error.export.badJson': 'package.json is not valid JSON — fix it before exporting.',
  'error.export.noBuildScript': 'This app has no build script in package.json, so there is nothing to build.',
  'error.export.installFailed': 'Installing dependencies failed (the build needs vite and tsc).',
  'error.export.noDist': 'The build finished but there is no dist/ directory — where did the frontend output go?',
  'error.export.prodInstallFailed': 'Installing production dependencies failed (exit code {code}).',

  'error.secret.urlCredentials':
    'Do not put a username or password in the repository URL — the token goes in the next field, where it is encrypted.',

  'error.component.permissionDenied': '{id} does not have the "{action}" permission.',

  'error.assistant.notSettled': 'The assistant did not finish cleanly ({status}){detail}',
  'error.model.noneConfigured':
    'No model is available yet. Add a provider and an API key in Settings; for development you can set TENON_FAUX=1 to use a fake model.',

  'error.preview.notProbedYet': 'not probed yet',
  'error.preview.unknownReason': 'unknown reason',
  'error.preview.devNotReady': 'The dev server was not ready within {seconds}s (last seen: {last})',
  'error.preview.apiNotReady': 'The backend was not ready within {seconds}s (last seen: {last})',
  'error.preview.apiNotCompiled': 'The backend did not compile {entry} within {seconds}s (last tsc output: {tail})',
  'error.preview.devExited': '{reason} (last dev server output: {tail})',
  'error.preview.apiExited': '{reason} (last backend output: {tail})',

  'error.deps.spawnFailed': 'Could not start the dependency installer ({command}): {detail}',
  'error.deps.installFailed': 'Installing dependencies failed ({command} install exited with {code})',

  'error.db.connectFailed': 'Could not connect to the {mode} tier ({url}): {detail}',
  'error.db.cyclicFk':
    'Tables have a circular foreign key, so insert order cannot be determined: {tables}. Make one of those keys nullable first, migrate, then put it back.',
  'error.db.sameMode': 'Source and target are both the {mode} tier — there is nothing to migrate. Cross-tier migration is the only meaningful case.',
  'error.db.snapshotModeMismatch': 'The snapshot is from the {snapshot} tier and you are on {current} — it cannot be restored directly.',
  'error.db.postgresNoUrl':
    'This is the postgres tier but there is no connection string. Set TENON_DATABASE_URL (or switch back to the default pglite tier).',
  'error.db.missingTables':
    'These tables are missing in the target: {tables}. Cross-tier migration moves data, not schema — start the app once on the target tier (migrations run automatically), then migrate.',
  'error.db.rowCountMismatch':
    '{table} row count does not add up: before {before} + written {written} = {expected}, but the target has {actual}. Something else is probably writing to this database (stop the preview while migrating).',
  'error.db.unknownSnapshot':
    'Unrecognised snapshot format (it may come from an old `pg_dump --format=custom`, which needs pg_restore).',
  'error.db.newerSnapshot': 'The snapshot uses a newer format (v{found}; this build understands up to v{known}). Upgrade Tenon, then restore.',
  'error.db.noTablesInTarget': 'None of the tables in this snapshot exist in the target — it probably belongs to a different app.',
  'error.db.snapshotMissing':
    'There is no database snapshot for this version (snapshots are only taken when a commit changes the schema), so the data was left alone. Uncheck "roll back data too" to roll back code only.',

  'error.template.varsLeft': 'Template {at} still has unreplaced placeholders: {names}',
  'error.template.dirNotEmpty': 'This workspace already has a package.json (template {id}): {dir}',

  'error.export.busyExporting':
    'This app is already being exported. Wait for that run to finish — two builds at once wipe each other\u2019s dist/, and the error looks like "build failed".',
  'error.export.buildFailed': 'Build failed (pnpm run build exited with {code}): {tail}',
  'error.export.noBuildApi':
    'This app declares a backend (tenon.api in package.json) but has no build:api script.',
  'error.export.apiBuildFailed': 'Backend build failed (pnpm run build:api exited with {code}): {tail}',

  'error.hub.notConfigured':
    'The official Hub is not configured. Set TENON_HUB_URL and TENON_HUB_PUBLIC_KEY before installing components from it.',

  'error.storage.previewRunning':
    'The preview for "{id}" is running. Stop it before cleaning dependencies — otherwise the next request fails with a missing module.',

  /*
   * 远端的这六条是**指路**用的：用户拿到的不是"失败了"，而是"下一步改哪里"。
   * 英文侧逐字翻会变难读，所以按同样的处置顺序重写，信息一条不少。
   */
  'error.push.network': 'Could not reach the remote repository ({code})',
  'error.push.networkHint': 'Check the URL, your network and any proxy. This is not a permissions problem yet.',
  'error.push.auth': 'The remote rejected this token (401)',
  'error.push.authHint':
    'GitHub: Settings → Developer settings → Personal access tokens → new Fine-grained token, with Contents: Read and write. The token is shown once — do not copy spaces or newlines with it.',
  'error.push.forbidden': 'The token works, but it cannot write to this repository (403)',
  'error.push.forbiddenHint':
    'A fine-grained token must select this repository, and Repository permissions → Contents must be Read and write. With Read alone you can fetch but not push, and that is exactly this 403 — it is easy to misread as "wrong repository", because the repo does show up in the list. Organisation repos also need the org to approve (Settings → Personal access tokens → Pending requests).',
  'error.push.notFound': 'Repository not found (404)',
  'error.push.notFoundHint':
    'Two different causes, do not mix them: (1) the URL is wrong, or the repository does not exist yet; (2) the repository is private and this token cannot see it — GitHub answers 404 for "no access" too, without telling you it exists.',
  'error.push.nonFastForward': 'The remote has commits you do not — push rejected (not a fast-forward)',
  'error.push.nonFastForwardHint':
    'That branch was changed elsewhere (edited on the web, or pushed from another machine). Merge those commits first; Tenon never force-pushes by default — it would overwrite other people\u2019s commits and cannot be undone.',
  'error.push.unknown': 'Push failed: {detail}',
  'error.push.unknownHint':
    'Read that message together with the address; if the address carries a username or password, put only the token in the token field.',
  'error.push.noToken': 'This app has no token yet',
  'error.push.noTokenHint': 'Writing to a remote requires a token. Enter it once in the publish dialog; it is stored encrypted.',

  'error.agent.retrying': 'The model call failed — retry {attempt}',
  'error.agent.closing': 'The service is shutting down',
  'error.agent.noProvider': 'No provider is selected yet',
  'error.agent.snapshotFailed':
    'Database snapshot failed, so this version cannot roll data back with the code: {detail}',

  'error.budget.appExhausted':
    'This app is out of budget (used {used}, limit {limit}). Raise the limit, or switch to another app.',
  'error.budget.globalMonthExhausted':
    'This month\u2019s total budget is used up ({used} of {limit}). It resets on the 1st; to keep going now, raise the monthly limit.',
  'error.budget.globalTotalExhausted':
    'The total budget is used up ({used} of {limit}). This one does not reset monthly — raise it (or remove it) to keep going.',
} as const

export type ErrorMessageKey = keyof typeof errorsEn

/** 中文表必须逐键覆盖（少一条编译期就报）。措辞沿用产品原本的说法，不做"改写" */
export const errorsZh: Record<ErrorMessageKey, string> = {
  'error.assistant.questionEmpty': '问题不能为空',
  'error.assistant.noAnswer': '助手跑完了但没有输出',

  'error.chat.emptyInput': '消息内容不能为空',
  'error.chat.busy': '这个应用正在生成中，稍等一下再发',

  'error.model.providerGone': '选中的提供商已不存在：{id}',
  'error.model.noApiKey': '提供商「{label}」没有配置 API Key',

  'error.assembly.invalid': '装配声明不合法，拒绝写入',

  'error.file.outside': '路径越界：{path}',
  'error.file.notFound': '文件不存在：{path}',
  'error.file.tooLarge': '文件过大（{size} 字节），暂时不能在线打开',

  'error.git.notRepo': '不是 git 仓库：{dir}',
  'error.git.diffFailed': '无法比对 {from}..{to}',
  'error.git.commitMissing': '找不到 commit {sha}',
  'error.git.revertRoot': '不支持回滚仓库的第一个提交（等于清空仓库）',
  'error.git.revertNoChange': '回滚 {sha} 没有产生任何改动',

  'error.release.noCommits': '这个应用还没有任何提交，没有可以发布的内容',
  'error.release.generating': '正在生成中，等这一轮跑完再发布',
  'error.release.dirty': '工作区还有 {count} 个文件没提交（{files}），先让这一轮跑完再发布',
  'error.release.unknownObject': '不认识的对象类型：{type}（{oid}）',
  'error.release.commitUnreadable': '回滚提交已写入但读不回来',
  'error.release.busyDuringCheck': '检查期间仓库又有新提交，等这一轮跑完再发布',
  'error.release.backupPushFailed': '推送到备份库失败：{detail}',
  'error.release.checksFailed': '发布前检查没通过：{failed}。修好再发；确认要发就显式选「仍然发布」。',
  'error.release.checkNotPassed': '{label}{summary}',

  'error.secret.corrupt': '密钥文件损坏：{file}',
  'error.secret.badLength': '密文长度不合法',
  'error.secret.mismatch': '无法解密：密钥与密文不匹配（可能换过机器）',

  'error.app.notFound': '应用不存在：{id}',
  'error.app.homeMissing': '创建应用目录失败',
  'error.app.nameInvalid': '应用名不能为空，且不超过 64 个字',
  'error.app.refuseDelete': '拒绝删除越界路径：{path}',

  'error.provider.notFound': '提供商不存在：{id}',
  'error.provider.unreadable': '写入提供商后读不回来',

  'error.remote.badUrl': '仓库地址不是合法 URL：{url}',
  'error.remote.notHttps': '仓库地址必须以 https:// 开头（令牌不能走明文传输）',

  'error.db.notStarted': '数据库还没启动，拿不到连接串',
  'error.db.notReadyForSnapshot': '数据库没启动，不能打快照',
  'error.db.notLive': '数据库还没探活成功',
  'error.db.startFailed': '应用数据库起不来：{detail}',
  'error.db.noPort': '应用数据库拿不到监听端口',
  'error.db.listenMissing': '内部错误：listen 时没有 db 实例',
  'error.db.backendWithoutDb': '内部错误：有后端却没有数据库',
  'error.db.dumpFailed': '快照失败：{detail}',
  'error.db.restoreFailed': '还原快照失败：{detail}',
  'error.db.restoreRolledBack': '还原失败（已回滚，库没被改动）：{detail}',
  'error.db.notSnapshot': '这不是一份 Tenon 的库快照（gzip 解不开）：{detail}',
  'error.db.notJson': '快照内容不是合法 JSON：{detail}',
  'error.db.restoreUnsupported': '当前数据库实现不支持还原快照',
  'error.db.noWritableColumns': '{table} 没有可写的列（全是生成列？）',
  'error.db.noUserTables': '源库里没有任何用户表（schemas: {schemas}）',

  'error.preview.closing': '服务正在关闭，不能再起预览',
  'error.preview.noAppDir': '应用目录不存在，没法起预览',
  'error.preview.portsExhausted': '拿不到 {count} 个空闲端口',
  'error.preview.tscMissing': '找不到 typescript：依赖没装完或装失败了',
  'error.preview.tsconfigMissing': '后端要编译，但找不到 tsconfig.server.json',
  'error.deps.noPackage': '这个工作区没有 package.json，没法装依赖',
  'error.deps.viteMissing': '找不到 vite：依赖没装完或装失败了',

  'error.feature.noBackend': '这个工作区没有 package.json，加不了后端',
  'error.feature.noAuth': '这个工作区没有 package.json，加不了登录',
  'error.feature.badJson': '{file} 不是合法 JSON，没法往里合并字段',
  'error.feature.notObject': '{file} 的顶层不是对象',

  'error.template.unknown': '没有这个模板：{id}',
  'error.template.badManifest': '模板清单不是对象：{file}',
  'error.template.idMismatch': '模板目录名与清单 id 不一致：{dir} ≠ {id}',
  'error.template.varMissing': '模板 {at} 需要变量 {name}，但调用方没有提供',
  'error.template.varsMissing': '模板 {id} 声明的变量没有值：{names}',

  'error.request.sinceNotNumber': 'since 必须是数字',
  'error.request.invalid': '参数不合法',

  'error.export.noPackage': '这个工作区没有 package.json，导不出东西',
  'error.export.badJson': 'package.json 不是合法 JSON，先修好再导出',
  'error.export.noBuildScript': '这个应用的 package.json 没有 build 脚本，不知道怎么构建',
  'error.export.installFailed': '装依赖失败（构建需要 vite 与 tsc）',
  'error.export.noDist': '构建完成了，但没有 dist/ 目录（前端产物去哪了？）',
  'error.export.prodInstallFailed': '装生产依赖失败（退出码 {code}）',

  'error.secret.urlCredentials': '仓库地址里不要带用户名或密码 —— 令牌请填在下一栏，那里会加密保存',

  'error.component.permissionDenied': '{id} 没有「{action}」的权限',

  'error.assistant.notSettled': '助手这一轮没有正常结束（{status}）{detail}',
  'error.model.noneConfigured':
    '还没有可用的模型。请在设置里添加提供商并填入 API Key；开发调试可设 TENON_FAUX=1 用假模型。',

  'error.preview.notProbedYet': '还没开始探测',
  'error.preview.unknownReason': '未知原因',
  'error.preview.devNotReady': 'dev server 在 {seconds} 秒内没有就绪（最后一次：{last}）',
  'error.preview.apiNotReady': '后端在 {seconds} 秒内没有就绪（最后一次：{last}）',
  'error.preview.apiNotCompiled': '后端在 {seconds} 秒内没有编译出 {entry}（tsc 最后输出：{tail}）',
  'error.preview.devExited': '{reason}（dev server 最后输出：{tail}）',
  'error.preview.apiExited': '{reason}（后端最后输出：{tail}）',

  'error.deps.spawnFailed': '起不来依赖安装程序（{command}）：{detail}',
  'error.deps.installFailed': '依赖安装失败（{command} install 退出码 {code}）',

  'error.db.connectFailed': '连不上 {mode} 档（{url}）：{detail}',
  'error.db.cyclicFk': '表之间有循环外键，无法确定插入顺序：{tables}。请先把其中一条外键改成可空，迁完数据再改回来。',
  'error.db.sameMode': '源和目标都是 {mode} 档，没有可迁的东西。跨档迁移才有意义。',
  'error.db.snapshotModeMismatch': '快照是 {snapshot} 档的，当前是 {current} 档，不能直接还原。',
  'error.db.postgresNoUrl': '当前是 postgres 档，但没有连接串。设 TENON_DATABASE_URL（或改用默认的 pglite 档）。',
  'error.db.missingTables':
    '目标库里缺少这些表：{tables}。跨档迁移只搬数据不搬结构 —— 先让应用在目标档启动一次（迁移会自动跑），再迁移数据。',
  'error.db.rowCountMismatch':
    '{table} 行数对不上：迁前 {before} + 实写 {written} = {expected}，实际 {actual}。多半是有别的进程在同时写这个库（迁移期间请停掉预览）。',
  'error.db.unknownSnapshot': '快照格式不认识（可能是旧版 pg_dump --format=custom 打的，那个要用 pg_restore）。',
  'error.db.newerSnapshot': '快照是更新的格式（v{found}，本机只认到 v{known}），升级 Tenon 后再还原。',
  'error.db.noTablesInTarget': '快照里的表在目标库里一个都不存在。这份快照多半是另一个应用的库。',
  'error.db.snapshotMissing':
    '这一版之前没有可用的数据库快照（只有改过表结构的提交才会存快照），所以数据没有动。取消勾选「连数据一起回滚」可以只回滚代码。',

  'error.template.varsLeft': '模板 {at} 渲染后仍有未替换的占位符：{names}',
  'error.template.dirNotEmpty': '这个工作区已经有 package.json 了（模板 {id}）：{dir}',

  'error.export.busyExporting':
    '这个应用正在导出（上一次还没结束）。等它跑完再点 —— 两次同时构建会互相清 dist/，报出来像是"构建失败"。',
  'error.export.buildFailed': '构建失败（pnpm run build 退出码 {code}）：{tail}',
  'error.export.noBuildApi': '这个应用声明了后端（package.json 的 tenon.api），但没有 build:api 脚本',
  'error.export.apiBuildFailed': '后端编译失败（pnpm run build:api 退出码 {code}）：{tail}',

  'error.hub.notConfigured': '官方 Hub 还没配置。设 TENON_HUB_URL 与 TENON_HUB_PUBLIC_KEY 之后才能从 Hub 安装组件。',

  'error.storage.previewRunning':
    '「{id}」的预览正在运行。先停掉预览再清理依赖 —— 否则它会在下一次请求时突然报找不到模块。',

  'error.push.network': '连不上远端仓库（{code}）',
  'error.push.networkHint': '检查地址是否写对、本机网络或代理是否正常。这一步还没轮到权限问题。',
  'error.push.auth': '远端不认这个令牌（401）',
  'error.push.authHint':
    'GitHub：Settings → Developer settings → Personal access tokens → 新建 Fine-grained token，权限勾 Contents: Read and write。令牌只显示一次，复制时别带空格或换行。',
  'error.push.forbidden': '令牌有效，但没有这个仓库的写权限（403）',
  'error.push.forbiddenHint':
    'Fine-grained 令牌要单独勾选这一个仓库，且 Repository permissions → Contents 必须是 Read and write。只给 Read 时读得到、推不了，报的就是这个 403 —— 很容易误判成"仓库勾错了"，因为仓库列表里确实有它。组织仓库还需要该组织的同意（Settings → Personal access tokens → Pending requests）。',
  'error.push.notFound': '仓库找不到（404）',
  'error.push.notFoundHint':
    '两种可能，别混：① 地址拼错或仓库还没建；② 仓库是私有的、而这个令牌看不到它 —— GitHub 对"无权访问"也回 404，不告诉你"存在但你没权限"。',
  'error.push.nonFastForward': '远端有本地没有的提交，推送被拒（不会是快进）',
  'error.push.nonFastForwardHint':
    '远端这个分支被别处改过（网页上直接编辑、或另一台机器推过）。先把远端的提交合过来再发；Tenon 默认不强推 —— 强推会覆盖别人的提交，且不可撤销。',
  'error.push.unknown': '推送失败：{detail}',
  'error.push.unknownHint': '把这条消息连同地址一起看一遍；如果地址里带了账号密码，先改成只填令牌。',
  'error.push.noToken': '这个应用还没有配令牌',
  'error.push.noTokenHint': '远端写操作必须带令牌。在发布对话框里填一次，会加密保存。',

  'error.agent.retrying': '模型调用失败，正在第 {attempt} 次重试',
  'error.agent.closing': '服务正在关闭',
  'error.agent.noProvider': '还没有选中任何提供商',
  'error.agent.snapshotFailed': '库快照失败，这一版将无法连数据一起回滚：{detail}',

  'error.budget.appExhausted': '这个应用的额度用完了（已用 {used}，上限 {limit}）。调高上限，或者换一个应用继续。',
  'error.budget.globalMonthExhausted':
    '本月总额度用完了（本月已用 {used}，上限 {limit}）。下月 1 日自动重置；要现在继续，就把「每月总额度」调高。',
  'error.budget.globalTotalExhausted':
    '总额度用完了（累计已用 {used}，上限 {limit}）。这道闸不会按月份重置 —— 要继续就得把它调高（或者取消这一项）。',
}
