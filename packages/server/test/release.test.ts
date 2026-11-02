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
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

/** 应用自己的 node_modules 里放一份 typescript（软链到仓库那份），门禁才跑得起来 */
async function installTypescript(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, 'node_modules'), { recursive: true })
  await symlink(TS_DIR, join(repoDir, 'node_modules', 'typescript'), 'dir')
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
    expect(checks.map((check) => check.id)).toEqual(['typecheck', 'test'])
    expect(checks[0]?.status).toBe('fail')
    expect(checks[0]?.detail).toContain('TS2322')

    // 最关键的一条：不许留下"有 tag 没记录"的半成品，也不许消耗版本号
    expect(await gitops.listTags(paths.repoDir)).toEqual([])
    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases).toEqual([])
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
    expect(result.release.gateSummary).toBe('类型检查 ✓ · 测试 ⏭')
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
