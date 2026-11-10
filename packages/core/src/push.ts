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
      message: `连不上远端仓库（${code}）`,
      hint: '检查地址是否写对、本机网络或代理是否正常。这一步还没轮到权限问题。',
    }
  }

  if (status === 401) {
    return {
      code: 'AUTH',
      message: '远端不认这个令牌（401）',
      hint:
        'GitHub：Settings → Developer settings → Personal access tokens → 新建 Fine-grained token，' +
        '权限勾 Contents: Read and write。令牌只显示一次，复制时别带空格或换行。',
    }
  }
  if (status === 403) {
    return {
      code: 'FORBIDDEN',
      message: '令牌有效，但没有这个仓库的写权限（403）',
      hint:
        'Fine-grained 令牌要**单独勾选**这一个仓库（默认是"只对选中的仓库生效"）。' +
        '组织仓库还需要该组织的同意（Settings → Personal access tokens → Pending requests）。',
    }
  }
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      message: '仓库找不到（404）',
      hint:
        '两种可能，别混：① 地址拼错或仓库还没建；② 仓库是私有的、而这个令牌看不到它 —— ' +
        'GitHub 对"无权访问"也回 404，不告诉你"存在但你没权限"。',
    }
  }

  // 422 是 git 协议层：远端拒绝了这次推送，最常见的是历史分叉
  if (status === 422 || /non-fast-forward|rejected|failed to update ref/i.test(message + textOf(data?.response))) {
    return {
      code: 'NON_FAST_FORWARD',
      message: '远端有本地没有的提交，推送被拒（不会是快进）',
      hint:
        '远端这个分支被别处改过（网页上直接编辑、或另一台机器推过）。先把远端的提交合过来再发；' +
        'Tenon 默认不强推 —— 强推会覆盖别人的提交，且不可撤销。',
    }
  }

  return {
    code: 'UNKNOWN',
    message: `推送失败：${message.slice(0, 300)}`,
    hint: '把这条消息连同地址一起看一遍；如果地址里带了账号密码，先改成只填令牌。',
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
        message: '这个应用还没有配令牌',
        hint: '远端写操作必须带令牌。在发布对话框里填一次，会加密保存。',
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
        // 认证失败不要重试三次：401 重试三次还是 401，只是让用户多等 2 秒。
        // `cancel: true` 让拿到的第一个错误原样冒出来，分类才准
        onAuthFailure: () => ({ cancel: true }),
        onProgress: options.onProgress,
      })
      pushed += 1
    } catch (error) {
      return { ok: false, failure: classifyPushError(error), refs: pushed }
    }
  }
  return { ok: true, failure: null, refs: pushed }
}
