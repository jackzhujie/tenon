/**
 * 发布的集成测试：走真 HTTP，验的是「编排」而不是 git 原语（那些在 core 的单测里）。
 *
 * 五条最容易错的事，各有一个用例钉住：
 * 1. 无提交不该发一个空版本
 * 2. 工作区脏（上一轮没写完）不该发出去
 * 3. 推送失败时**不能留下没有记录的 tag** —— 否则下次发布直接跳到 -2，用户以为少发了一版
 * 4. **检查没过不许发**，而且不许留下 tag 与记录（M4 第 7 步）
 * 5. 用户硬发（`force`）要能发，但记录里必须留痕 —— 半年后得有人答得出"这版为什么带着错上线"
 *
 * 前三条的用例用 `force: true`：它们测的是发布编排本身，应用里故意没装依赖（门禁会拦），
 * 那不是这些用例要验的东西。门禁本身在 `checks.test.ts` 与下面后面四条里验。
 *
 * 后半段是**预检**（`release.check`）：它只读地回答"现在能不能发"。最要紧的两条是
 * 「查完什么都没留下」和「它说的与发布做的是同一件事」—— 预检说能发、点下去却被拦，
 * 是这类功能最容易出的毛病，一旦出现用户就会绕开它。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { lastCheckKey } from '@tenon/core'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import git from 'isomorphic-git'
import fs from 'node:fs'
import { appPaths, gitops, resolveHome } from '@tenon/core'
import { boot, TEST_TOKEN, type BootOptions } from './support.js'
import type { RunningServer } from '../src/index.js'

interface Release {
  id: string
  appId: string
  version: string
  commitSha: string
  kind: string
  artifactPath: string | null
  notes: string | null
  gateStatus: 'pass' | 'forced' | null
  gateSummary: string | null
}

interface CheckOutcome {
  id: string
  status: 'pass' | 'fail' | 'skip'
  summary: string
  detail: string | null
  elapsedMs: number
}

interface Preflight {
  ready: boolean
  blocked: { code: string; message: string } | null
  commitSha: string | null
  gate: { ok: boolean; checks: CheckOutcome[] } | null
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
  gate: { ok: boolean; checks: CheckOutcome[] }
}

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-release-srv-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

async function bootServer(options: BootOptions = {}): Promise<RunningServer> {
  running = await boot(dir, options)
  return running
}

async function rpc<T>(server: RunningServer, method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } }
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.code} ${body.error?.message}`)
  return body.data as T
}

async function rpcError(
  server: RunningServer,
  method: string,
  input: unknown,
): Promise<{ code: string; message: string; details?: { checks?: CheckOutcome[] } }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as {
    ok: boolean
    error?: { code: string; message: string; details?: { checks?: CheckOutcome[] } }
  }
  if (body.ok) throw new Error(`${method} 本该失败`)
  return body.error as { code: string; message: string; details?: { checks?: CheckOutcome[] } }
}

async function createApp(server: RunningServer): Promise<string> {
  const created = await rpc<{ app: { id: string } }>(server, 'app.create', {
    name: '发布测试',
    templateId: 'react-vite',
    styleId: null,
  })
  return created.app.id
}

async function commit(server: RunningServer, appId: string, file: string, content: string): Promise<string> {
  const repoDir = appPaths(resolveHome({ TENON_HOME: dir }), appId).repoDir
  await writeFile(join(repoDir, file), content)
  const result = await gitops.commitAll(repoDir, `feat: ${file}`)
  if (result === undefined) throw new Error('测试里应该有改动')
  void server
  return result.sha
}


/** 用本仓库自己装的那份 typescript：不联网、不假定临时目录里装过依赖 */
const TS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/typescript')

/**
 * 把模板换成一个「最小可检查项目」。
 *
 * 为什么不能直接用模板：`react-vite` 的 tsconfig 写着 `types: ["vite/client", "node"]`，
 * 而这里只软链了 typescript —— 缺 `@types/node` 会让 tsc 报"找不到类型定义"，
 * 于是"通过"这个用例根本构造不出来。测试要验的是门禁的判据，不是模板的依赖完整性
 * （那个由 `e2e:preview` 与 `smoke` 盯）。
 */
async function makeCheckable(repoDir: string, source: string): Promise<void> {
  await rm(join(repoDir, 'src'), { recursive: true, force: true })
  await rm(join(repoDir, 'vite.config.ts'), { force: true })
  /*
   * 模板自 v1.2.20 起带 `lint` 脚本（`eslint .`）与 `eslint.config.mjs`，而这里只软链了
   * typescript。留着它，门禁会**正确地**报「没跑成：lint 脚本里的命令没装」——
   * 于是"通过"这个用例根本构造不出来，而它要验的是 typecheck / test 的判据组合，
   * 不是 lint 本身（那是 `checks.test.ts` 与 `review-tools.test.ts` 的事）。
   * 所以这里一并摘掉；需要验 lint 拦截的用例在下面单独把脚本换回去。
   */
  await rm(join(repoDir, 'eslint.config.mjs'), { force: true })
  const pkgPath = join(repoDir, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
  if (pkg.scripts !== undefined) delete pkg.scripts['lint']
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(
    join(repoDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
        },
        include: ['src'],
      },
      null,
      2,
    ),
  )
  await mkdir(join(repoDir, 'src'), { recursive: true })
  await writeFile(join(repoDir, 'src', 'main.ts'), source)
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** 往应用的 package.json 里塞一个 test 脚本（模板只有 lint，没有 test） */
async function withTestScript(repoDir: string, script: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  pkg.scripts['test'] = script
  await writeFile(join(repoDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

/** 应用自己的 node_modules 里放一份 typescript（软链到仓库那份），门禁才跑得起来 */
async function installTypescript(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, 'node_modules'), { recursive: true })
  // Windows 的 `'dir'` 软链要特权，`'junction'` 不要（且只支持目录 —— 这里正好是目录）
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(TS_DIR, join(repoDir, 'node_modules', 'typescript'), linkType)
}

describe('发布（release.publish）', () => {
  it('把 commit 冻结成版本：记一条 release，备份库 HEAD 指向它', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const sha = await commit(server, appId, 'note.txt', 'v1\n')

    // force：这个应用故意没装依赖，门禁会拦；本用例只验发布编排
    const result = await rpc<PublishResult>(server, 'release.publish', { appId, notes: '第一版', force: true })
    expect(result.version).toMatch(/^v\d{4}\.\d{2}\.\d{2}-1$/)
    expect(result.commitSha).toBe(sha)
    expect(result.release.kind).toBe('push')
    expect(result.release.notes).toBe('第一版')
    // 发布说明同时进了 tag 正文：把备份库 clone 走的人也能看到
    const tagOid = await git.resolveRef({ fs, gitdir: result.backupPath, ref: `refs/tags/${result.version}` })
    const tag = (await git.readObject({ fs, gitdir: result.backupPath, oid: tagOid })).object as unknown as {
      message: string
    }
    expect(tag.message).toContain('第一版')

    const remoteHead = await git.resolveRef({ fs, gitdir: result.backupPath, ref: 'refs/heads/main' })
    expect(remoteHead).toBe(sha)

    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases.map((release) => release.version)).toEqual([result.version])
  })

  it('同一天再发一次是 -2，备份库跟着前进', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await commit(server, appId, 'note.txt', 'v1\n')
    const first = await rpc<PublishResult>(server, 'release.publish', { appId, force: true })

    const secondSha = await commit(server, appId, 'note.txt', 'v2\n')
    const second = await rpc<PublishResult>(server, 'release.publish', { appId, force: true })

    expect(second.version).not.toBe(first.version)
    expect(second.version.endsWith('-2')).toBe(true)
    expect(await git.resolveRef({ fs, gitdir: second.backupPath, ref: 'refs/heads/main' })).toBe(secondSha)

    // 历史是累加的，不是覆盖：备份库里两版都在
    const tags = await git.listTags({ fs, gitdir: second.backupPath })
    expect(tags).toEqual(expect.arrayContaining([first.version, second.version]))
  })

  it('仓库里一条提交都没有时拒绝发布，也不会凭空造一个备份库', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    // 建应用会有一个初始提交，把它删掉，造出「仓库在、历史空」的状态
    await rm(join(paths.repoDir, '.git'), { recursive: true, force: true })
    await gitops.initRepo(paths.repoDir)

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_NO_COMMITS')

    await expect(readFile(join(paths.backupRepo, 'HEAD'), 'utf8')).rejects.toThrowError()
  })

  it('工作区还有没提交的改动时拒绝（可能这一轮没跑完）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await commit(server, appId, 'note.txt', 'v1\n')

    const repoDir = appPaths(resolveHome({ TENON_HOME: dir }), appId).repoDir
    await writeFile(join(repoDir, 'note.txt'), '写了一半\n')

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('GIT_DIRTY_WORKTREE')
    expect(error.message).toContain('note.txt')
  })

  it('推送失败时把 tag 删掉，不留「有 tag 没记录」的半成品', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await commit(server, appId, 'note.txt', 'v1\n')

    // 把备份库路径做成一个普通文件：裸库建不出来，推送必然失败
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await mkdir(dirname(paths.backupRepo), { recursive: true })
    await writeFile(paths.backupRepo, '不是目录\n')

    const error = await rpcError(server, 'release.publish', { appId, force: true })
    expect(error.code).toBe('RELEASE_FAILED')

    expect(await gitops.listTags(paths.repoDir)).toEqual([])
    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases).toEqual([])
  })

  it('应用不存在时报 APP_NOT_FOUND，而不是在别的目录里乱发布', async () => {
    const server = await bootServer()
    const error = await rpcError(server, 'release.publish', { appId: 'app-nope' })
    expect(error.code).toBe('APP_NOT_FOUND')
  })

  it('★ 类型检查没过时拒绝发布，且不留下 tag 与记录', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, "export const answer: number = 'not a number'\n")
    await installTypescript(paths.repoDir)
    const sha = await gitops.commitAll(paths.repoDir, 'feat: 故意写错类型')
    expect(sha).toBeDefined()

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_CHECKS_FAILED')
    expect(error.message).toContain('类型检查没过')

    // 清单随错误一起回去，对话框才画得出"哪一项没过"
    const checks = error.details?.checks ?? []
    expect(checks.map((check) => check.id)).toEqual(['typecheck', 'test', 'lint'])
    expect(checks[0]?.status).toBe('fail')
    expect(checks[0]?.detail).toContain('TS2322')

    // 最关键的一条：不许留下"有 tag 没记录"的半成品，也不许消耗版本号
    expect(await gitops.listTags(paths.repoDir)).toEqual([])
    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases).toEqual([])
  }, 60_000)

  it('★ lint 没过时同样拒绝发布（第三项判据真的接上了）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)

    /*
     * `makeCheckable` 把模板的 lint 摘掉了（这里只软链了 typescript，跑不了 eslint）。
     * 塞一个**必然失败**的 lint 脚本：不装 eslint 也能验"第三项是不是真的在拦"。
     * 用 `node -e` 而不是真的 eslint，是因为这条用例要验的是**门禁的接线**，
     * 不是 eslint 能不能跑（那两条模板已经在 e2e 里真跑过了）。
     */
    const pkg = JSON.parse(await readFile(join(paths.repoDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    pkg.scripts['lint'] = 'node -e "console.error(\'src/main.ts:1:1 error 未使用变量\');process.exit(1)"'
    await writeFile(join(paths.repoDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await gitops.commitAll(paths.repoDir, 'chore: 引入一个 lint 错误')

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_CHECKS_FAILED')
    expect(error.message).toContain('Lint没过')

    const checks = error.details?.checks ?? []
    expect(checks.map((check) => check.id)).toEqual(['typecheck', 'test', 'lint'])
    const lint = checks.find((check) => check.id === 'lint')
    expect(lint?.status).toBe('fail')
    // 具体错误要跟着回去，否则用户只知道"lint 没过"却不知道改哪
    expect(lint?.detail).toContain('未使用变量')

    expect(await gitops.listTags(paths.repoDir)).toEqual([])
  }, 60_000)

  it('★ 改对之后能发，记录里是 pass，摘要写清哪项过了哪项没得检查', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    await gitops.commitAll(paths.repoDir, 'feat: 写对了类型')

    const result = await rpc<PublishResult>(server, 'release.publish', { appId })
    expect(result.gate.ok).toBe(true)
    expect(result.gate.checks[0]?.status).toBe('pass')
    // 模板没有 test 脚本 —— 这是 skip，不是"测试通过了"
    expect(result.gate.checks[1]?.status).toBe('skip')
    expect(result.release.gateStatus).toBe('pass')
    expect(result.release.gateSummary).toBe('类型检查 ✓ · 测试 ⏭ · Lint ⏭')
    expect(await gitops.listTags(paths.repoDir)).toEqual([result.version])
  }, 60_000)

  it('★ 硬发（force）能发出去，但记录里留痕 forced', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, "export const answer: number = 'still wrong'\n")
    await installTypescript(paths.repoDir)
    await gitops.commitAll(paths.repoDir, 'feat: 还是错的')

    const result = await rpc<PublishResult>(server, 'release.publish', { appId, force: true, notes: '先发再说' })
    expect(result.gate.ok).toBe(false)
    expect(result.release.gateStatus).toBe('forced')
    expect(result.release.gateSummary).toContain('类型检查 ✗')
    // 记录里留了痕，历史列表才画得出那个「带问题」的标记
    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases[0]?.gateStatus).toBe('forced')
    expect(listed.releases[0]?.notes).toBe('先发再说')
  }, 60_000)

  it('★ test 脚本红了也拦（不只是类型）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    // 让 test 脚本存在、可跑、且失败：断言的地方也一并写进 package.json
    const pkg = JSON.parse(await readFile(join(paths.repoDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    pkg.scripts['test'] = 'node -e "process.exit(1)"'
    await writeFile(join(paths.repoDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    await gitops.commitAll(paths.repoDir, 'chore: 加一个会红的测试')

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_CHECKS_FAILED')
    const test = (error.details?.checks ?? []).find((check) => check.id === 'test')
    expect(test?.status).toBe('fail')
    expect(test?.summary).toContain('退出码 1')
    // 类型那项是好的 —— 说明拦下来的确实是测试，不是"反正都不让发"
    expect((error.details?.checks ?? []).find((check) => check.id === 'typecheck')?.status).toBe('pass')
  }, 60_000)
})

describe('发布预检（release.check）', () => {
  it('★ 只读：查完不打 tag、不写记录、不消耗版本号，且结论与发布一致', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    const committed = await gitops.commitAll(paths.repoDir, 'feat: 写对了类型')

    const first = await rpc<Preflight>(server, 'release.check', { appId })
    expect(first.ready).toBe(true)
    // 前提没问题，所以不是 blocked 的那种"不能发" —— 这两个字段回答的是不同的问题
    expect(first.blocked).toBeNull()
    expect(first.commitSha).toBe(committed?.sha)
    expect(first.gate?.ok).toBe(true)
    expect(first.stale).toBe(false)

    // 只读的全部含义：没有 tag、没有记录、备份库根本没建出来
    expect(await gitops.listTags(paths.repoDir)).toEqual([])
    expect((await rpc<{ releases: Release[] }>(server, 'release.list', { appId })).releases).toEqual([])
    await expect(readFile(join(paths.backupRepo, 'HEAD'), 'utf8')).rejects.toThrowError()

    // 查第二次结论一样（没有"查过就失效"的副作用）
    const again = await rpc<Preflight>(server, 'release.check', { appId })
    expect(again.ready).toBe(true)

    // 最要紧的一条：预检说的和发布做的是同一件事 —— 不用 force 就能发出去，
    // 版本号还是 -1（预检没偷走一个版本号）
    const published = await rpc<PublishResult>(server, 'release.publish', { appId })
    expect(published.release.version.endsWith('-1')).toBe(true)
    expect(published.release.gateStatus).toBe('pass')
  }, 90_000)

  it('★ 检查没过：ready=false 但 blocked=null —— 是代码问题，不是前提问题', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, "export const answer: number = 'not a number'\n")
    await installTypescript(paths.repoDir)
    await gitops.commitAll(paths.repoDir, 'feat: 故意写错类型')

    const pre = await rpc<Preflight>(server, 'release.check', { appId })
    expect(pre.blocked).toBeNull()
    expect(pre.ready).toBe(false)
    expect(pre.gate?.ok).toBe(false)
    expect(pre.gate?.checks[0]?.status).toBe('fail')

    // 预检说不能发 → 发布真的发不出去，而且是同一个原因（不是两套判断）
    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_CHECKS_FAILED')

    // 预检本身仍然什么都没写
    expect(await gitops.listTags(paths.repoDir)).toEqual([])
  }, 90_000)

  it('工作区脏时只说前提，不跑门禁（也就没有 gate 结论）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await withTestScript(paths.repoDir, 'node -e "process.exit(1)"')
    await gitops.commitAll(paths.repoDir, 'chore: 一个会红的测试')
    // 上一轮写到一半：脏工作区
    await writeFile(join(paths.repoDir, 'note.txt'), '写了一半\n')

    const pre = await rpc<Preflight>(server, 'release.check', { appId })
    expect(pre.blocked?.code).toBe('GIT_DIRTY_WORKTREE')
    expect(pre.blocked?.message).toContain('note.txt')
    // gate 是 null 而不是"跑了但没过"：工作区脏的时候去跑一遍测试，既白等几十秒，
    // 又会让人以为"测试修好就快能发了"。这里没有测试结论可给
    expect(pre.gate).toBeNull()
    expect(pre.ready).toBe(false)
  })

  it('没有提交时看的是"没有内容可发"，不是"检查没过"', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    // 建应用会有一个初始提交，把它删掉，造出「仓库在、历史空」的状态
    await rm(join(paths.repoDir, '.git'), { recursive: true, force: true })
    await gitops.initRepo(paths.repoDir)

    const pre = await rpc<Preflight>(server, 'release.check', { appId })
    expect(pre.blocked?.code).toBe('RELEASE_NO_COMMITS')
    expect(pre.commitSha).toBeNull()
    expect(pre.gate).toBeNull()
    expect(pre.ready).toBe(false)
  })

  it('★ 检查期间又有提交：门禁虽过也标 stale，不能说"可以发"', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    // 慢 4 秒的测试：给这个用例留出"检查跑着的时候仓库又前进了一版"的窗口
    await withTestScript(paths.repoDir, 'node -e "setTimeout(function () {}, 4000)"')
    const first = await gitops.commitAll(paths.repoDir, 'feat: 一个慢测试')

    const pending = rpc<Preflight>(server, 'release.check', { appId })
    await sleep(1200)
    await writeFile(join(paths.repoDir, 'note.txt'), '检查跑着的时候又改了一笔\n')
    const second = await gitops.commitAll(paths.repoDir, 'feat: 检查期间的改动')
    expect(second?.sha).toBeDefined()

    const result = await pending
    expect(result.commitSha).toBe(first?.sha)
    expect(result.stale).toBe(true)
    // 门禁本身是过的 —— 说明 ready=false 来自"结果过期"，而不是"检查没过"。
    // 这两种情况对用户的含义完全相反：一个该重新检查，一个该改代码
    expect(result.gate?.ok).toBe(true)
    expect(result.ready).toBe(false)
  }, 90_000)

  it('同一个应用的两次预检合并成一次（不并发跑两套 tsc + 测试）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    await withTestScript(paths.repoDir, 'node -e "setTimeout(function () {}, 1200)"')
    await gitops.commitAll(paths.repoDir, 'feat: 稍微慢一点的测试')

    const [a, b] = await Promise.all([
      rpc<Preflight>(server, 'release.check', { appId }),
      rpc<Preflight>(server, 'release.check', { appId }),
    ])
    // 同一个结果对象才会连耗时都一样；真跑了两份的话这个数字不可能分毫不差
    expect(a.elapsedMs).toBe(b.elapsedMs)
    expect(a.commitSha).toBe(b.commitSha)
  }, 90_000)
})

describe('预检存档（release.lastCheck，v1.2.23）', () => {
  it('跑完预检能读到，且与那次检查一致', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    const committed = await gitops.commitAll(paths.repoDir, 'feat: 写对了')
    const sha = committed?.sha
    expect(sha).toBeDefined()

    // 从没查过：null，不是空对象 —— 界面要能区分"还没查"和"查了但没结果"
    const before = await rpc<{ check: unknown }>(server, 'release.lastCheck', { appId })
    expect(before.check).toBeNull()

    const check = await rpc<{ gate: { ok: boolean; checks: CheckOutcome[] } }>(server, 'release.check', { appId })
    const { check: stored } = await rpc<{ check: Record<string, unknown> | null }>(server, 'release.lastCheck', {
      appId,
    })
    expect(stored).not.toBeNull()
    expect(stored?.commitSha).toBe(sha)
    expect(stored?.ready).toBe(check.gate.ok)
    // 存档里的清单与那次检查一模一样：界面拿它逐项画，少一项就会画错
    expect((stored?.gate as { checks: CheckOutcome[] }).checks.map((item) => item.id)).toEqual(
      check.gate.checks.map((item) => item.id),
    )
    expect(typeof stored?.checkedAt).toBe('number')
  }, 60_000)

  it('★ 工作区脏时（没跑门禁）不覆盖上次的存档', async () => {
    /*
     * "工作区脏"是**瞬时状态**，几分钟后就变了。存下来只会让下次打开对话框看到
     * 一句已经过时的"工作区有未提交的改动"，而用户真正想看的是上次跑出来的结论。
     * 所以 gate 为 null 时不写 —— 旧的那份继续留着（界面会标"已过期"）。
     */
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    const committed = await gitops.commitAll(paths.repoDir, 'feat: 写对了')
    const sha = committed?.sha
    expect(sha).toBeDefined()
    await rpc(server, 'release.check', { appId })

    await writeFile(join(paths.repoDir, 'note.txt'), '写了一半\n')
    const blocked = await rpc<{ blocked: unknown }>(server, 'release.check', { appId })
    expect(blocked.blocked).not.toBeNull()

    const { check } = await rpc<{ check: { commitSha: string } | null }>(server, 'release.lastCheck', { appId })
    expect(check?.commitSha).toBe(sha)
  }, 60_000)

  it('★ 发布成功之后清掉：下一个版本从"还没查过"开始', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    await gitops.commitAll(paths.repoDir, 'feat: 写对了')
    await rpc(server, 'release.check', { appId })
    expect((await rpc<{ check: unknown }>(server, 'release.lastCheck', { appId })).check).not.toBeNull()

    await rpc(server, 'release.publish', { appId })

    // 那份结论讲的是**已经发出去的那一版**，留着会显示"上次检查：通过"而让人以为下一版也过了
    expect((await rpc<{ check: unknown }>(server, 'release.lastCheck', { appId })).check).toBeNull()
  }, 60_000)

  it('删应用时把存档一起清掉（不留孤儿 settings 键）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    await gitops.commitAll(paths.repoDir, 'feat: 写对了')
    await rpc(server, 'release.check', { appId })

    const key = lastCheckKey(appId)
    expect(server.core.settings.get(key)).toBeDefined()

    await rpc(server, 'app.delete', { id: appId, removeFiles: true })
    expect(server.core.settings.get(key)).toBeUndefined()
  }, 60_000)
  it('★ reusable 的判据：同一版 + 工作区干净才为真，改了任何一样都要真跑', async () => {
    /*
     * 这是"打开对话框不再等 30 秒"的全部依据，所以三条边界都要钉住：
     * 1. 没存档 → false
     * 2. 同一版 + 干净 → true
     * 3. 之后又提交 → false
     * 4. **工作区脏（HEAD 没变）→ false** ← 最容易漏的一条：只比 sha 会拿
     *    "上一版通过"去证明"这一版"
     */
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await makeCheckable(paths.repoDir, 'export const answer: number = 42\n')
    await installTypescript(paths.repoDir)
    await gitops.commitAll(paths.repoDir, 'feat: 写对了')

    // 1. 从没查过
    expect((await rpc<{ reusable: boolean }>(server, 'release.lastCheck', { appId })).reusable).toBe(false)

    // 2. 查完、同一版、干净
    await rpc(server, 'release.check', { appId })
    expect((await rpc<{ reusable: boolean }>(server, 'release.lastCheck', { appId })).reusable).toBe(true)

    // 4. 工作区脏而 HEAD 没变（先测这条：它最容易漏）
    await writeFile(join(paths.repoDir, 'note.txt'), '改了一半\n')
    expect((await rpc<{ reusable: boolean }>(server, 'release.lastCheck', { appId })).reusable).toBe(false)
    await rm(join(paths.repoDir, 'note.txt'))

    // 3. 又提交了一版（存档还是上一版的）
    await writeFile(join(paths.repoDir, 'src', 'main.ts'), 'export const answer: number = 43\n')
    await gitops.commitAll(paths.repoDir, 'feat: 改成 43')
    expect((await rpc<{ reusable: boolean }>(server, 'release.lastCheck', { appId })).reusable).toBe(false)
  }, 60_000)
})

