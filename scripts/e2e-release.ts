/**
 * 真机端到端：发布（`release.publish`）→ **用系统 git 当裁判**验收备份库。
 *
 * 为什么这里要请系统 git 出场：产品本身不依赖任何 git 二进制（isomorphic-git 纯 JS，
 * 打包进 server.mjs）。但"我们自己写的代码说备份库没问题"不算证据 —— 备份库的用途
 * 是交给别人 `git clone`。所以这里用真正的 git 做三件事：
 *   ① `git fsck --strict`：对象图完整、没有悬空引用（写坏一个字节这里就红）
 *   ② `git clone` + `git log/cat-file`：别人拿到它能不能用
 *   ③ `git tag`：版本标签是不是真 tag
 *
 * 只在 e2e 里用系统 git，产品运行时不碰它 —— 这条边界别弄混。
 *
 * 用法：`pnpm e2e:release`（跑完删临时目录）、`pnpm e2e:release --keep`
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { appPaths, gitops, resolveHome } from '../packages/core/src/index.js'
import { setLocale } from '../packages/protocol/src/index.js'
import { startServer } from '../packages/server/src/index.js'

const exec = promisify(execFile)
const TOKEN = 'e2e-token'
const keep = process.argv.includes('--keep')

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface Release {
  id: string
  version: string
  commitSha: string
  kind: string
  artifactPath: string | null
  notes: string | null
  gateStatus: 'pass' | 'forced' | null
  gateSummary: string | null
  createdAt: number
}

interface Preflight {
  ready: boolean
  blocked: { code: string; message: string } | null
  commitSha: string | null
  gate: { ok: boolean; checks: { id: string; status: string; summary: string }[] } | null
  stale: boolean
  elapsedMs: number
}

interface PublishResult {
  release: Release
  version: string
  commitSha: string
  backupPath: string
  branch: string
  objects: number
  gate: { ok: boolean; checks: { id: string; status: string; summary: string }[] }
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

/** 跑一条系统 git 命令，把 stdout 拿回来；失败时把 stderr 一起抛出来 */
async function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const shaped = err as { code?: number; stdout?: string; stderr?: string }
    return { code: shaped.code ?? 1, stdout: shaped.stdout ?? '', stderr: shaped.stderr ?? String(err) }
  }
}

try {
  await git(['--version'])
} catch {
  console.log('✗ 这个 e2e 需要系统 git 做裁判（只有测试用它，产品运行时不依赖）')
  process.exit(1)
}

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-release-'))
const cloneRoot = await mkdtemp(join(tmpdir(), 'tenon-e2e-clone-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
})
/*
 * 断言里写的是中文（"类型检查 ✗"这种摘要原话）。服务端默认说英文，
 * 这里钉成中文；英文那一侧由 `packages/server/test/locale.test.ts` 守。
 */
setLocale('zh')

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
async function rpcError(
  method: string,
  input: unknown,
): Promise<{ code: string; message: string; details?: { checks?: { id: string; status: string }[] } }> {
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
  console.log('1) 建应用并造一轮改动')
  const created = await rpc<{ app: { id: string } }>('app.create', { name: '发布 E2E', templateId: 'react-vite' })
  const appId = created.app.id
  const paths = appPaths(resolveHome({ TENON_HOME: home }), appId)
  const repo = paths.repoDir

  await writeFile(join(repo, 'src', 'notes.md'), '第一轮写下的内容\n')
  const first = await gitops.commitAll(repo, 'feat: 加一份说明')
  check('第一轮产生 commit', first !== undefined)
  const head = await gitops.headSha(repo)

  console.log('\n2) 预检先说清楚，发布也确实被拦（M4 第 7 步 + 预检）')
  const pre = await rpc<Preflight>('release.check', { appId })
  check('预检说"现在发不出去"', pre.ready === false, String(pre.ready))
  check(
    '原因是检查没过，不是前提没满足（这两个字段回答不同的问题）',
    pre.blocked === null && pre.gate?.ok === false,
    JSON.stringify(pre.blocked ?? pre.gate?.ok ?? null),
  )
  check('预检针对的是当前 HEAD', pre.commitSha === head, `${String(pre.commitSha)} vs ${String(head)}`)
  check(
    '预检只读：查完既没有 tag 也没有发布记录，备份库还没建',
    (await gitops.listTags(repo)).length === 0 &&
      (await rpc<{ releases: unknown[] }>('release.list', { appId })).releases.length === 0,
  )

  // 门禁本身：这个应用没装依赖，类型检查跑不起来
  const blocked = await rpcError('release.publish', { appId, notes: '首个可交付版本' })
  check('检查没过时拒绝发布', blocked.code === 'RELEASE_CHECKS_FAILED', blocked.message)
  check('错误里说清是哪一项没过', blocked.message.includes('类型检查'), blocked.message)
  check(
    '清单随错误一起回来（三项都在，对话框逐行画）',
    /*
     * 不只数个数：`lint` 是 v1.2.20 加的第三项，长度对了但漏了它、或者多了个别的，
     * 都是界面画不出来的那种坏。逐个 id 点名。
     */
    blocked.details?.checks?.length === 3 &&
      ['typecheck', 'test', 'lint'].every((id) =>
        (blocked.details?.checks ?? []).some((check) => check.id === id),
      ),
    JSON.stringify(blocked.details ?? {}),
  )
  check('被拒时不消耗版本号（仓库里没有 tag）', (await gitops.listTags(repo)).length === 0)

  console.log('\n3) 硬发（force）：能发出去，但记录里留痕')
  const published = await rpc<PublishResult>('release.publish', {
    appId,
    notes: '首个可交付版本',
    force: true,
  })
  check('版本号是 v<日期>-1', /^v\d{4}\.\d{2}\.\d{2}-1$/.test(published.version), published.version)
  check('发布的就是当前 HEAD', published.commitSha === head, `${published.commitSha} vs ${String(head)}`)
  check('备份库落在 ~/.tenon/backups/<appId>.git', published.backupPath === paths.backupRepo, published.backupPath)
  check('记录 kind 是 push', published.release.kind === 'push')
  check('发布说明进了记录', published.release.notes === '首个可交付版本')
  check('真的写了对象（不是空转）', published.objects > 0, `objects=${String(published.objects)}`)
  check('记录标成 forced（检查没过被人工放过）', published.release.gateStatus === 'forced', String(published.release.gateStatus))
  check('摘要写清哪项没过', (published.release.gateSummary ?? '').includes('类型检查 ✗'), String(published.release.gateSummary))

  console.log('\n4) 系统 git 裁判：备份库是个合法的裸库')
  const fsck = await git(['-C', published.backupPath, 'fsck', '--strict', '--no-progress'])
  check('git fsck --strict 通过', fsck.code === 0, fsck.stderr.trim())
  check(
    'fsck 没报 missing / could not be parsed',
    !/missing|could not be parsed|invalid sha1/.test(fsck.stderr),
    fsck.stderr.trim(),
  )
  const bare = await git(['-C', published.backupPath, 'rev-parse', '--is-bare-repository'])
  check('确实是裸库', bare.stdout.trim() === 'true', bare.stdout.trim())

  const remoteLog = await git(['-C', published.backupPath, 'log', '--format=%H %s'])
  const remoteLines = remoteLog.stdout.trim().split('\n').filter((line) => line !== '')
  check('备份库有两条历史（初始模板 + 这一轮）', remoteLines.length === 2, remoteLines.join(' / '))
  check('最新提交就是 HEAD', remoteLines[0]?.startsWith(published.commitSha) === true, remoteLines[0])

  const tags = await git(['-C', published.backupPath, 'tag', '-l'])
  check('版本标签在备份库里', tags.stdout.split('\n').includes(published.version), tags.stdout.trim())

  const tagBody = await git(['-C', published.backupPath, 'cat-file', '-p', published.version])
  check('tag 是 annotated（能 show 出正文）', tagBody.stdout.includes('首个可交付版本'), tagBody.stdout.trim())
  const tagRef = await git(['-C', published.backupPath, 'cat-file', '-t', published.version])
  check('tag 指向的是 tag 对象而不是 commit', tagRef.stdout.trim() === 'tag', tagRef.stdout.trim())

  const blob = await git(['-C', published.backupPath, 'cat-file', '-p', `${published.version}:src/notes.md`])
  check('tag 里带着那一刻的文件内容', blob.stdout === '第一轮写下的内容\n', blob.stdout)

  console.log('\n5) 别人 clone 下来能直接用')
  const cloneDir = join(cloneRoot, 'app')
  const cloned = await git(['clone', '--quiet', published.backupPath, cloneDir])
  check('git clone 成功', cloned.code === 0, cloned.stderr.trim())
  check('clone 出来的工作区有文件', (await readFile(join(cloneDir, 'src', 'notes.md'), 'utf8')) === '第一轮写下的内容\n')
  const cloneLog = await git(['-C', cloneDir, 'log', '--oneline'])
  check('clone 里历史完整', cloneLog.stdout.trim().split('\n').length === 2, cloneLog.stdout.trim())
  const status = await git(['-C', cloneDir, 'status', '--porcelain'])
  check('clone 出来是干净工作区', status.stdout.trim() === '', status.stdout)

  console.log('\n6) 再改一轮、再发一版：备份库前进而不是被覆盖')
  await writeFile(join(repo, 'src', 'notes.md'), '第二版内容\n')
  const second = await gitops.commitAll(repo, 'feat: 改一版')
  const secondPublish = await rpc<PublishResult>('release.publish', { appId, force: true })
  check('同一天第二个版本是 -2', secondPublish.version.endsWith('-2'), secondPublish.version)
  check('第二次只写增量对象', secondPublish.objects < published.objects, `${String(secondPublish.objects)} vs ${String(published.objects)}`)
  check('新提交是 HEAD', secondPublish.commitSha === second?.sha)

  const tagsAfter = (await git(['-C', secondPublish.backupPath, 'tag', '-l'])).stdout.split('\n')
  check('两个版本标签都在', tagsAfter.includes(published.version) && tagsAfter.includes(secondPublish.version), tagsAfter.join(','))
  const oldBlob = await git(['-C', secondPublish.backupPath, 'cat-file', '-p', `${published.version}:src/notes.md`])
  check('旧版本标签仍指向旧内容（历史没被改写）', oldBlob.stdout === '第一轮写下的内容\n', oldBlob.stdout)

  await rm(cloneDir, { recursive: true, force: true })
  await git(['clone', '--quiet', secondPublish.backupPath, cloneDir])
  check('重新 clone 拿到最新一版', (await readFile(join(cloneDir, 'src', 'notes.md'), 'utf8')) === '第二版内容\n')

  console.log('\n7) release.list：新发的在前，门禁留痕也在')
  const listed = await rpc<{ releases: Release[] }>('release.list', { appId })
  check('两条发布记录', listed.releases.length === 2, `实际 ${String(listed.releases.length)}`)
  check('最新的排第一', listed.releases[0]?.version === secondPublish.version)
  check(
    '两条记录都留着 forced 的痕（不是倒推成 pass）',
    listed.releases.every((release) => release.gateStatus === 'forced'),
    listed.releases.map((release) => String(release.gateStatus)).join(','),
  )

  console.log('\n8) 闸门：工作区脏 / 没有提交 / 应用不存在')
  await writeFile(join(repo, 'src', 'notes.md'), '写到一半\n')
  const dirty = await rpcError('release.publish', { appId })
  check('工作区有未提交改动时拒绝', dirty.code === 'GIT_DIRTY_WORKTREE', dirty.message)
  check('错误里点名了那个文件', dirty.message.includes('src/notes.md'), dirty.message)
  await writeFile(join(repo, 'src', 'notes.md'), '第二版内容\n')

  const ghost = await rpcError('release.publish', { appId: 'app-nope' })
  check('应用不存在报 APP_NOT_FOUND', ghost.code === 'APP_NOT_FOUND', ghost.message)

  const empty = await rpc<{ app: { id: string } }>('app.create', { name: '空仓库', templateId: 'react-vite' })
  const emptyPaths = appPaths(resolveHome({ TENON_HOME: home }), empty.app.id)
  await rm(join(emptyPaths.repoDir, '.git'), { recursive: true, force: true })
  await gitops.initRepo(emptyPaths.repoDir)
  const noCommits = await rpcError('release.publish', { appId: empty.app.id })
  check('仓库里没有提交时拒绝', noCommits.code === 'RELEASE_NO_COMMITS', noCommits.message)
  check(
    '拒绝时不留下空备份库',
    await readFile(join(emptyPaths.backupRepo, 'HEAD'), 'utf8').then(
      () => false,
      () => true,
    ),
  )

  console.log('')
  if (failures > 0) {
    console.log(`✗ ${String(failures)} 项失败`)
    process.exitCode = 1
  } else {
    console.log('✓ 全部通过')
  }
} finally {
  await server.close()
  await rm(cloneRoot, { recursive: true, force: true })
  if (keep) console.log(`\n保留了 ${home}`)
  else await rm(home, { recursive: true, force: true })
}
