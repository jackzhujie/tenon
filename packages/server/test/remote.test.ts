import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appPaths, gitops, openCore, type CoreServices } from '@tenon/core'
import { publishRelease, pushReleaseToRemote } from '../src/release.js'

let dir: string
let core: CoreServices

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-remote-'))
  core = openCore({ env: { TENON_HOME: dir } })
})

afterEach(async () => {
  core.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const VERSION = 'v2026.11.10-1'

/** 建一个应用、提交一次、打上发布 tag（不跑门禁，直接给 `pushReleaseToRemote` 用） */
async function seededApp(): Promise<{ app: Awaited<ReturnType<CoreServices['apps']['create']>>; repoDir: string }> {
  const app = await core.apps.create({ name: '待办', templateId: 'react-vite', styleId: null })
  const paths = appPaths(core.home, app.id)
  await writeFile(join(paths.repoDir, 'notes.md'), 'hello\n')
  await gitops.commitAll(paths.repoDir, 'init')
  const head = await gitops.headSha(paths.repoDir)
  await gitops.createReleaseTag(paths.repoDir, { tag: VERSION, sha: head as string, message: 'x' })
  return { app, repoDir: paths.repoDir }
}

/** 假的 git.push：按需成功或抛 401 */
function fakePush(seen: Array<{ ref: string; password?: string }>, fail: boolean) {
  return (async (args: { ref?: string; onAuth?: () => { password?: string } }) => {
    seen.push({ ref: args.ref ?? '', password: args.onAuth?.().password })
    if (fail) {
      const error = new Error('HTTP Error: 401') as Error & { code: string; data: unknown }
      error.code = 'HttpError'
      error.data = { statusCode: 401 }
      throw error
    }
    return { ok: true }
  }) as unknown as Parameters<typeof pushReleaseToRemote>[0]['pushImpl']
}

describe('推远端（release.push 的那层）', () => {
  it('没配远端时明确说"没配"，不假装网络出了问题', async () => {
    const { app } = await seededApp()
    const outcome = await pushReleaseToRemote({ core, app, version: VERSION })

    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('NO_REMOTE')
    expect(outcome.hint).toContain('远端仓库')
  })

  it('版本 tag 不在仓库里时直接说清楚（而不是让 git 报一句 by rev-parse 的错）', async () => {
    const { app } = await seededApp()
    core.remotes.upsert({ appId: app.id, url: 'https://github.com/me/app.git', token: 't' })

    const outcome = await pushReleaseToRemote({ core, app, version: 'v1999.01.01-9' })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('v1999.01.01-9')
  })

  it('成功时分支 + tag 两个 ref 都推了，令牌从库里解出来交给 onAuth', async () => {
    const { app } = await seededApp()
    core.remotes.upsert({ appId: app.id, url: 'https://github.com/me/app.git', token: 'ghp_secret' })

    const seen: Array<{ ref: string; password?: string }> = []
    const outcome = await pushReleaseToRemote({
      core,
      app,
      version: VERSION,
      pushImpl: fakePush(seen, false),
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.refs).toBe(2)
    expect(seen.map((s) => s.ref)).toEqual(['refs/heads/main', `refs/tags/${VERSION}`])
    expect(seen[0]?.password).toBe('ghp_secret')
  })

  it('失败时**不抛错** —— 调用方要把它显示出来，而不是让整个 RPC 变红', async () => {
    const { app } = await seededApp()
    core.remotes.upsert({ appId: app.id, url: 'https://github.com/me/app.git', token: 'expired' })

    const outcome = await pushReleaseToRemote({
      core,
      app,
      version: VERSION,
      pushImpl: fakePush([], true),
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('AUTH')
    // 文案要指路，不能只说"失败了"
    expect(outcome.hint).toContain('Contents: Read and write')
  })
})

describe('发布与远端的失败语义（BACKLOG 3.9 的核心承诺）', () => {
  it('远端推失败不影响这次发布：记录照写，只是 remote.ok=false', async () => {
    const app = await core.apps.create({ name: '待办', templateId: 'react-vite', styleId: null })
    const paths = appPaths(core.home, app.id)
    await writeFile(join(paths.repoDir, 'notes.md'), 'hello\n')
    await gitops.commitAll(paths.repoDir, 'init')
    core.remotes.upsert({ appId: app.id, url: 'https://github.com/me/app.git', token: 'expired' })

    const result = await publishRelease({ core, app, pushImpl: fakePush([], true) })

    // 发布本身是成功的：备份库有这一版、记录也写了
    expect(result.release.version).toBe(result.version)
    expect(core.releases.list(app.id)).toHaveLength(1)
    // 远端那格如实说失败，且带着可操作的原因
    expect(result.remote?.ok).toBe(false)
    expect(result.remote?.code).toBe('AUTH')
  })

  it('没配远端时 remote 是 null —— 和"配了但失败"必须能分开', async () => {
    const app = await core.apps.create({ name: '待办', templateId: 'react-vite', styleId: null })
    const paths = appPaths(core.home, app.id)
    await writeFile(join(paths.repoDir, 'notes.md'), 'hello\n')
    await gitops.commitAll(paths.repoDir, 'init')

    const result = await publishRelease({ core, app })
    expect(result.remote).toBeNull()
  })
})
