import { describe, expect, it } from 'vitest'
import { classifyPushError, pushToRemote } from '../src/push.js'

/** isomorphic-git 的 HttpError 长这样：`code='HttpError'`，状态码在 `data.statusCode` */
function httpError(status: number, body = ''): Error {
  const error = new Error(`HTTP Error: ${String(status)}`) as Error & { code: string; data: unknown }
  error.code = 'HttpError'
  error.data = { statusCode: status, statusMessage: '', response: { body } }
  return error
}

function netError(code: string): Error {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

describe('推送失败分类（DoD 的"失败信息能指路"）', () => {
  it('401 指向"令牌过期/建新令牌"，而不是让人去查网络', () => {
    const failure = classifyPushError(httpError(401))
    expect(failure.code).toBe('AUTH')
    expect(failure.hint).toContain('Contents: Read and write')
  })

  it('403 说的是"令牌没这个仓库的写权限"，和 401 是两件事', () => {
    const failure = classifyPushError(httpError(403))
    expect(failure.code).toBe('FORBIDDEN')
    expect(failure.message).toContain('写权限')
    // 两种最容易混的原因：没单独勾仓库 / 勾了但 Contents 只给了 Read
    expect(failure.hint).toContain('单独勾选')
    expect(failure.hint).toContain('Read and write')
  })

  it('404 要同时提"地址错"和"私有库看不见" —— GitHub 对两者都回 404', () => {
    const failure = classifyPushError(httpError(404))
    expect(failure.code).toBe('NOT_FOUND')
    expect(failure.hint).toContain('私有')
  })

  it('422 → 非快进，且明说不会强推', () => {
    const failure = classifyPushError(httpError(422, '! [rejected] main -> main (non-fast-forward)'))
    expect(failure.code).toBe('NON_FAST_FORWARD')
    expect(failure.hint).toContain('不强推')
  })

  it('没有状态码但 body 里写着 rejected 也算非快进（协议层拒绝不一定带 422）', () => {
    const failure = classifyPushError(httpError(500, 'error: failed to update ref'))
    expect(failure.code).toBe('NON_FAST_FORWARD')
  })

  it('连不上就是连不上，别混进权限问题', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']) {
      const failure = classifyPushError(netError(code))
      expect(failure.code).toBe('NETWORK')
      expect(failure.hint).toContain('还没轮到权限问题')
    }
  })

  it('认不出来的就照原样报，但截断 —— 错误消息不该把界面撑爆', () => {
    const failure = classifyPushError(new Error('x'.repeat(2000)))
    expect(failure.code).toBe('UNKNOWN')
    expect(failure.message.length).toBeLessThanOrEqual(320)
  })

  it('非 Error 的东西也不会让分类器自己崩', () => {
    expect(classifyPushError('boom').code).toBe('UNKNOWN')
    expect(classifyPushError(null).code).toBe('UNKNOWN')
  })
})

interface Call {
  url: string
  ref: string
  force: boolean
  auth: { username?: string; password?: string; cancel?: boolean }
}

/** 假的 git.push：记下每次调用，按 ref 决定成功还是抛错 */
function fakePush(calls: Call[], failOn: (ref: string) => Error | null = () => null) {
  return (async (args: {
    url?: string
    ref?: string
    force?: boolean
    onAuth?: () => { username?: string; password?: string; cancel?: boolean }
  }) => {
    const auth = args.onAuth?.() ?? {}
    calls.push({ url: args.url ?? '', ref: args.ref ?? '', force: args.force === true, auth })
    const error = failOn(args.ref ?? '')
    if (error !== null) throw error
    return { ok: true }
  }) as unknown as Parameters<typeof pushToRemote>[0]['pushImpl']
}

describe('推远端（分支 + tag）', () => {
  it('先推分支再推 tag，令牌只交给 onAuth，不拼进 url', async () => {
    const calls: Call[] = []
    const result = await pushToRemote({
      dir: '/tmp/whatever',
      url: 'https://github.com/me/app.git',
      token: 'ghp_secret',
      branch: 'main',
      tags: ['v2026.11.10-1'],
      pushImpl: fakePush(calls),
    })

    expect(result.ok).toBe(true)
    expect(result.refs).toBe(2)
    expect(calls.map((call) => call.ref)).toEqual(['refs/heads/main', 'refs/tags/v2026.11.10-1'])
    // URL 必须是干净的 —— 一旦把令牌拼进去，它就会出现在错误消息与日志里
    for (const call of calls) expect(call.url).not.toContain('ghp_secret')
    expect(calls[0]?.auth).toEqual({ username: 'x-access-token', password: 'ghp_secret' })
  })

  it('默认不强推（覆盖远端提交必须是用户显式选择的）', async () => {
    const calls: Call[] = []
    await pushToRemote({ dir: '/tmp/x', url: 'https://e.com/a.git', token: 't', pushImpl: fakePush(calls) })
    expect(calls[0]?.force).toBe(false)
  })

  it('GitLab 那种要用户名的场景：填了就用填的', async () => {
    const calls: Call[] = []
    await pushToRemote({
      dir: '/tmp/x',
      url: 'https://gitlab.com/me/app.git',
      username: 'oauth2',
      token: 'glpat-1',
      pushImpl: fakePush(calls),
    })
    expect(calls[0]?.auth).toEqual({ username: 'oauth2', password: 'glpat-1' })
  })

  it('分支成功、tag 失败 ⇒ 如实说"只上去了 1 个"，不谎报成功', async () => {
    const calls: Call[] = []
    const result = await pushToRemote({
      dir: '/tmp/x',
      url: 'https://e.com/a.git',
      token: 't',
      tags: ['v1'],
      pushImpl: fakePush(calls, (ref) => (ref.startsWith('refs/tags/') ? httpError(422) : null)),
    })

    expect(result.ok).toBe(false)
    expect(result.refs).toBe(1)
    if (!result.ok) expect(result.failure.code).toBe('NON_FAST_FORWARD')
  })

  it('没配令牌时直接说"还没配"，连一次注定 401 的请求都不发', async () => {
    const calls: Call[] = []
    const result = await pushToRemote({
      dir: '/tmp/x',
      url: 'https://e.com/a.git',
      token: null,
      pushImpl: fakePush(calls, () => httpError(401)),
    })

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    if (!result.ok) {
      expect(result.failure.code).toBe('AUTH')
      expect(result.failure.message).toContain('还没有配令牌')
    }
  })
})
