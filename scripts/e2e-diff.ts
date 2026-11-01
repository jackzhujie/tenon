/**
 * 真机端到端：改动面板依赖的那三条 RPC —— `git.log` / `git.show` / `git.revert`。
 *
 * 为什么不只写单测：`packages/core` 的单测直接调库函数，绕过了
 * ① `app.paths` 的路径解析（拿错目录就报"不是 git 仓库"）② RPC schema 校验
 * ③ 错误码映射。这三样都在 server 里，只有真的起一个服务才验得到。
 *
 * 「一轮对话一 commit」那部分用库函数模拟（faux provider 不写文件，没法产生真实改动），
 * 但 `show / revert` 全程走 HTTP，前端拿到的形状就是这里断言的那个。
 *
 * 用法：`pnpm e2e:diff`（跑完删临时目录）、`pnpm e2e:diff --keep`
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitops } from '../packages/core/src/index.js'
import { startServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-token'
const keep = process.argv.includes('--keep')

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

interface Commit {
  sha: string
  message: string
  parents: string[]
}

interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  text: string
  oldLine: number | null
  newLine: number | null
}

interface ShowResult {
  commit: Commit
  changes: Array<{ path: string; status: string; insertions?: number; deletions?: number }>
  files: Array<{
    path: string
    status: string
    insertions: number
    deletions: number
    lines: DiffLine[]
      binary?: boolean
  }>
  patch: string
  /** 这一版动没动表结构 —— 决定回滚时要不要提供「连数据一起回去」 */
  schemaChanged: boolean
  /** 这一版自己有没有存库快照 */
  hasSnapshot: boolean
}

interface RevertResult {
  commit: Commit
  data: {
    requested: boolean
    restored: boolean
    fromSha: string | null
    skippedCommits: number
  }
}

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-diff-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
})

async function rpc<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

/** 期望失败的调用：把错误码拿回来断言，而不是让它抛 */
async function rpcError(method: string, input: unknown): Promise<{ code: string; message: string }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<unknown>
  if (body.ok) throw new Error(`${method} 本该失败却成功了`)
  return body.error ?? { code: 'UNKNOWN', message: '' }
}

try {
  console.log('1) 建应用')
  const created = await rpc<{ app: { id: string } }>('app.create', { name: '改动面板 E2E' })
  const appId = created.app.id
  const repo = join(home, 'apps', appId, 'repo')
  check('repo 是 git 仓库（模板铺好时已 init）', await readFile(join(repo, '.git', 'HEAD'), 'utf8').then(
    () => true,
    () => false,
  ))

  console.log('\n2) 造两轮改动（模拟两轮对话各自留下的 commit）')
  /*
   * 模板铺好时已经有第一个提交（"初始模板"），所以这里不能假设 `commitAll` 一定产生新提交 ——
   * 工作区干净时它返回 undefined，这是设计（不写空提交）。已有的那条就当"第一轮"。
   */
  const existing = await gitops.log(repo, 1)
  const first = existing[0] === undefined
    ? await gitops.commitAll(repo, '第一轮：初始界面', { conversationId: 'c1', turn: 1 })
    : { sha: existing[0].sha }
  check('存在第一轮提交', first !== undefined)

  const appFile = join(repo, 'src', 'App.tsx')
  const original = await readFile(appFile, 'utf8')
  await writeFile(
    appFile,
    original.replace('</h1>', '</h1>\n      <p>第二轮加上去的段落</p>'),
  ).catch(async () => {
    // 模板里 App.tsx 的结构可能变，兜底：直接追加一行
    await writeFile(appFile, `${original}\n// 第二轮追加\n`)
  })
  await writeFile(join(repo, 'src', 'notes.md'), '第二轮新增的文件\n')
  const second = await gitops.commitAll(repo, '第二轮：加一段说明', { conversationId: 'c1', turn: 2 })
  check('第二轮产生 commit', second !== undefined)

  console.log('\n3) git.log：两条都在，新的在前')
  const log = await rpc<{ commits: Commit[] }>('git.log', { appId, limit: 20 })
  check('两条 commit', log.commits.length === 2, `实际 ${String(log.commits.length)}`)
  check('第一条就是第二轮', log.commits[0]?.sha === second?.sha)
  check('第二轮带 trailer（能回溯到对话轮次）', log.commits[0]?.message.includes('Tenon-Turn: 2') === true)

  console.log('\n4) git.show：只看这一版自己改了什么')
  const shown = await rpc<ShowResult>('git.show', { appId, sha: second!.sha })
  const paths = shown.files.map((file) => file.path).sort()
  check(
    '改动文件正好是这一轮动的那两个（没把第一轮的内容也算进来）',
    JSON.stringify(paths) === JSON.stringify(['src/App.tsx', 'src/notes.md']),
    JSON.stringify(paths),
  )
  check('commit.parents 指向第一轮', shown.commit.parents[0] === first?.sha)

  const appDiff = shown.files.find((file) => file.path === 'src/App.tsx')
  check('App.tsx 是修改', appDiff?.status === 'modified', appDiff?.status ?? '缺失')
  check(
    '逐行差异里有新增行，行号给的是「新文件里的第几行」',
    appDiff?.lines.some((line) => line.kind === 'add' && typeof line.newLine === 'number') === true,
  )
  check(
    '删除行为 null 的 newLine（前端靠它决定显示哪个行号列）',
    appDiff?.lines.every((line) => line.kind !== 'del' || line.newLine === null) === true,
  )
  check(
    '新增文件报成 added 且全是 + 行',
    shown.files.find((file) => file.path === 'src/notes.md')?.lines.every((line) => line.kind === 'add') === true,
  )
  check('insertions 只算 + 行', (appDiff?.insertions ?? 0) >= 1, `insertions=${String(appDiff?.insertions)}`)

  console.log('\n5) 根提交：没有父提交，整棵树当新增')
  const rootShow = await rpc<ShowResult>('git.show', { appId, sha: first!.sha })
  check('根提交的 parents 为空', rootShow.commit.parents.length === 0)
  check(
    '根提交把每个文件都报成 added',
    rootShow.files.length > 0 && rootShow.files.every((file) => file.status === 'added'),
    `实际 ${rootShow.files.map((file) => file.status).join(',')}`,
  )

  console.log('\n6) git.revert：代码退回去，历史不退')
  const reverted = await rpc<RevertResult>('git.revert', { appId, sha: second!.sha })
  check('回滚产生的是新提交', reverted.commit.sha !== second?.sha)
  check('回滚提交的文案说清是 revert', reverted.commit.message.startsWith('revert:'))

  const after = await rpc<{ commits: Commit[] }>('git.log', { appId, limit: 20 })
  check('历史从 2 条变 3 条（改历史就错了）', after.commits.length === 3, `实际 ${String(after.commits.length)}`)
  check('两条原始提交都还在', after.commits.some((c) => c.sha === first?.sha) && after.commits.some((c) => c.sha === second?.sha))

  const restored = await rpc<{ content: string }>('files.read', { appId, path: 'src/App.tsx' })
  check('App.tsx 内容回到第一轮', restored.content === original)
  check(
    '第二轮新增的文件被删掉了',
    await readFile(join(repo, 'src', 'notes.md'), 'utf8').then(
      () => false,
      () => true,
    ),
  )

  console.log('\n7) 回滚第一个提交：明确拒绝，而不是清空仓库')
  const refused = await rpcError('git.revert', { appId, sha: first!.sha })
  check('错误码是 NOT_IMPLEMENTED', refused.code === 'NOT_IMPLEMENTED', JSON.stringify(refused))
  check('错误文案说清理由', refused.message.includes('第一个提交'), refused.message)

  console.log('\n8) 找不到的 sha：报错而不是空 diff')
  const missing = await rpcError('git.show', { appId, sha: 'deadbeef'.repeat(5) })
  check('错误码是 GIT_DIFF_FAILED', missing.code === 'GIT_DIFF_FAILED', JSON.stringify(missing))

  console.log('\n9) schemaChanged：只有动表结构的提交才为真')
  check('前两轮只改界面 → 不为真', shown.schemaChanged === false, JSON.stringify(shown.schemaChanged))
  const schemaFile = join(repo, 'api', 'migrations', '1767225600000-InitNotes.ts')
  await mkdir(dirname(schemaFile), { recursive: true })
  await writeFile(schemaFile, 'export class InitNotes {}\n')
  const third = await gitops.commitAll(repo, '第三轮：加一张表', { conversationId: 'c1', turn: 3 })
  check('第三轮产生 commit', third !== undefined)
  const shownThird = await rpc<ShowResult>('git.show', { appId, sha: third!.sha })
  check('动了 api/migrations/ → schemaChanged 为 true', shownThird.schemaChanged === true)
  // 全程没起过预览、也没跑过对话，所以不会有快照 —— 这个 false 是"如实回答"，不是失败
  check('没起过库 → hasSnapshot 为 false', shownThird.hasSnapshot === false)

  console.log('\n10) 带 dbRestore 但没有快照：拒绝，且**代码一动不动**')
  /*
   * 这条最重要的是后半句。带数据还原的回滚里，覆盖库不可逆、回滚代码可逆，
   * 所以实现必须是「检查 → 还原数据 → 回滚代码」。检查失败时如果代码已经动了，
   * 用户就得到"代码回滚了、数据没回滚"这种半成品状态 —— 比直接报错难收拾得多。
   */
  const beforeRefuse = await rpc<{ commits: Commit[] }>('git.log', { appId, limit: 20 })
  const refusedRestore = await rpcError('git.revert', { appId, sha: third!.sha, dbRestore: true })
  check('错误码是 DB_SNAPSHOT_MISSING', refusedRestore.code === 'DB_SNAPSHOT_MISSING', JSON.stringify(refusedRestore))
  check('文案说清"数据没有动"以及该怎么办', refusedRestore.message.includes('数据没有动'), refusedRestore.message)
  const afterRefuse = await rpc<{ commits: Commit[] }>('git.log', { appId, limit: 20 })
  check(
    '提交数没变（preflight 失败不该产生半成品状态）',
    afterRefuse.commits.length === beforeRefuse.commits.length,
    `${String(beforeRefuse.commits.length)} → ${String(afterRefuse.commits.length)}`,
  )
  check(
    '那个迁移文件还在（代码真的没被回滚）',
    await readFile(schemaFile, 'utf8').then(
      () => true,
      () => false,
    ),
  )

  console.log('\n11) 带 dbRestore=false 的回滚：data 字段如实说自己没动数据')
  const plain = await rpc<RevertResult>('git.revert', { appId, sha: third!.sha })
  check('requested 为 false', plain.data.requested === false)
  check('restored 为 false', plain.data.restored === false)
  check('fromSha 为 null', plain.data.fromSha === null)
  check('skippedCommits 为 0', plain.data.skippedCommits === 0)

  console.log('')
  if (failures > 0) {
    console.log(`✗ ${String(failures)} 项失败`)
    process.exitCode = 1
  } else {
    console.log('✓ 全部通过')
  }
} finally {
  await server.close()
  if (keep) console.log(`\n保留了 ${home}`)
  else await rm(home, { recursive: true, force: true })
}
