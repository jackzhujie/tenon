/**
 * 推到**真远端**（DESIGN §12.1 的第二条路：配好远端就推远端）。
 *
 * 为什么只有 HTTPS：isomorphic-git 1.44 的 push 只实现了 HTTP 传输（`git.ts` 的
 * `mirrorTo` 注释里记着这件事 —— 它对本地路径也会报 `requires a "http" parameter`）。
 * SSH 要机器上有 `ssh` 二进制或加载 ssh2，前者与「运行时不依赖外部二进制」冲突，
 * 后者在 electron-builder 的产物里是一堆要额外处理的东西。所以这条路只做 HTTPS + 令牌。
 *
 * 这个文件的重点不是"把 git.push 包一层"，而是**失败分类**：同一个 401 在 GitHub 上
 * 有四种完全不同的原因（令牌过期、没勾仓库、勾了但没给写权限、用错了账号），
 * 用户拿到 "HTTP Error: 401" 只会去改代码。所以每一种都要给一句"现在该去点什么"。
 */
import fs from 'node:fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { msg } from '@tenon/protocol'

export type PushFailureCode =
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NON_FAST_FORWARD'
  | 'NETWORK'
  | 'UNKNOWN'

export interface PushFailure {
  code: PushFailureCode
  /** 给用户看的一句话（已去掉任何可能带凭据的东西） */
  message: string
  hint: string
}

/**
 * 判别联合而不是"每个字段都可空"：`if (result.ok) return ...` 之后 `failure` 自动
 * 是非空的，`if (!result.ok)` 之后它一定有值。调用方不必再写 `failure!`。
 */
export type PushResult =
  | { ok: true; failure: null; refs: number }
  | { ok: false; failure: PushFailure; refs: number }

/**
 * 从 isomorphic-git 的异常里认出"到底哪一步错了"。
 *
 * 判据只有两个来源：HTTP 状态码（`HttpError.data.statusCode`）与 node 的错误码
 * （`ENOTFOUND` 之类）。**不解析人话消息** —— 那是最容易随版本变化而失效的东西。
 *
 * 纯函数，单测直接喂各种 error 形状。
 */
export function classifyPushError(error: unknown): PushFailure {
  const raw = error as { code?: unknown; message?: unknown; data?: unknown } | null
  const code = typeof raw?.code === 'string' ? raw.code : ''
  const message = typeof raw?.message === 'string' ? raw.message : String(error)
  const data = raw?.data as { statusCode?: unknown; response?: unknown } | undefined
  const status = typeof data?.statusCode === 'number' ? data.statusCode : null

  // 网络层：根本没连上，和权限无关。混在一起会让人白改令牌
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH'].includes(code)) {
    return {
      code: 'NETWORK',
      message: msg('error.push.network', { code }),
      hint: msg('error.push.networkHint'),
    }
  }

  if (status === 401) {
    return {
      code: 'AUTH',
      message: msg('error.push.auth'),
      hint: msg('error.push.authHint'),
    }
  }
  if (status === 403) {
    return {
      code: 'FORBIDDEN',
      message: msg('error.push.forbidden'),
      hint: msg('error.push.forbiddenHint'),
    }
  }
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      message: msg('error.push.notFound'),
      hint: msg('error.push.notFoundHint'),
    }
  }

  // 422 是 git 协议层：远端拒绝了这次推送，最常见的是历史分叉
  if (status === 422 || /non-fast-forward|rejected|failed to update ref/i.test(message + textOf(data?.response))) {
    return {
      code: 'NON_FAST_FORWARD',
      message: msg('error.push.nonFastForward'),
      hint: msg('error.push.nonFastForwardHint'),
    }
  }

  return {
    code: 'UNKNOWN',
    message: msg('error.push.unknown', { detail: message.slice(0, 300) }),
    hint: msg('error.push.unknownHint'),
  }
}

/** 422 的 body 里是 git 的 report-status 文本，找关键词用 */
function textOf(response: unknown): string {
  if (typeof response === 'string') return response
  if (response !== null && response !== undefined && typeof response === 'object') {
    const body = (response as { body?: unknown }).body
    if (typeof body === 'string') return body
  }
  return ''
}

export interface PushToRemoteOptions {
  dir: string
  url: string
  username?: string | null
  /** 明文令牌。**不要写进日志** */
  token: string | null
  /** 分支，默认 main */
  branch?: string
  /** 一并推过去的 tag（发布版本） */
  tags?: readonly string[]
  /** 默认 false。强推会覆盖远端提交，只应该由用户显式选择 */
  force?: boolean
  /** 进度回调（`git.push` 的 onProgress）；测试里用来观察是否真的走完了 */
  onProgress?: (event: { phase: string; loaded: number; total: number }) => void
  /** 测试注入：替换真正的 push。生产永远用默认值 */
  pushImpl?: typeof git.push
}

/**
 * 推分支 + tag。**部分成功也算失败**：返回 `refs` 说明推上去几个，
 * 调用方（`release.publish`）据此决定要不要在界面上说"分支上去了、标签没上去"。
 */
export async function pushToRemote(options: PushToRemoteOptions): Promise<PushResult> {
  const push = options.pushImpl ?? git.push
  const branch = options.branch ?? 'main'
  const refs: string[] = [`refs/heads/${branch}`, ...(options.tags ?? []).map((tag) => `refs/tags/${tag}`)]
  const token = options.token

  // GitHub 认 `x-access-token` 作用户名；GitLab 要 `oauth2`；Gitea 用自己的账号名。
  // 所以留一个可选用户名，不填时用 GitHub 的推荐值 —— 那是绝大多数人的场景
  const explicit = options.username?.trim() ?? ''
  const username = explicit === '' ? 'x-access-token' : explicit

  // 没有令牌就不发这一次注定 401 的请求：先不说那一次网络往返，`onAuth` 返回
  // `cancel` 时 isomorphic-git 抛的是 "no auth" 这种看不出问题在哪的话
  if (token === null) {
    return {
      ok: false,
      failure: {
        code: 'AUTH',
        message: msg('error.push.noToken'),
        hint: msg('error.push.noTokenHint'),
      },
      refs: 0,
    }
  }

  let pushed = 0
  for (const ref of refs) {
    try {
      await push({
        fs,
        http,
        dir: options.dir,
        url: options.url,
        ref,
        remoteRef: ref,
        force: options.force === true,
        onAuth: () => ({ username, password: token }),
        /*
         * **刻意不提供 `onAuthFailure`。**
         *
         * 它返回 `{ cancel: true }` 时 isomorphic-git 抛的是 `UserCanceledError`，
         * 那个异常里没有状态码 —— 于是 401 被 cancel 吃掉了，分类器只能给 UNKNOWN，
         * 用户拿到的是"把这条消息看一遍"这种没用的建议。真机验过：错令牌本来该是
         * `AUTH` 却报成 `UNKNOWN`，根因就在这里。
         *
         * 代价是失败时会多试两次认证（正确令牌一次就成功，不受影响）。用两次 HTTPS
         * 往返换"401 能正确分类"，值。
         */
        onProgress: options.onProgress,
      })
      pushed += 1
    } catch (error) {
      return { ok: false, failure: classifyPushError(error), refs: pushed }
    }
  }
  return { ok: true, failure: null, refs: pushed }
}
