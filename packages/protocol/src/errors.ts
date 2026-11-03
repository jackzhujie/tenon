/**
 * 错误模型（DESIGN §7.4）。
 *
 * 约定：
 * - `code` 是稳定契约，前端按 code 分支；`message` 可以改文案，code 不能随便改
 * - `httpStatus` 由 code 前缀决定，服务端不手写 status
 * - 细节放 `details`，不拼进 message（避免前端正则解析字符串）
 */
import { z } from 'zod'

/** 前缀分组：APP_* 注册表 / GIT_* 版本 / PREVIEW_* 预览 / AGENT_* 模型 / EXPORT_* 导出 / VALIDATION_* 入参 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'METHOD_NOT_FOUND',
  'NOT_IMPLEMENTED',
  'INTERNAL',

  'APP_NOT_FOUND',
  'APP_SLUG_TAKEN',
  'APP_BUSY',
  'APP_HOME_MISSING',

  'CHAT_NOT_FOUND',
  'CHAT_EMPTY_INPUT',
  'CHAT_BUSY',

  'GIT_NOT_INITIALIZED',
  'GIT_COMMIT_FAILED',
  'GIT_DIFF_FAILED',
  'GIT_REVERT_FAILED',
  'GIT_DIRTY_WORKTREE',

  'AGENT_NO_MODEL',
  'AGENT_UNAVAILABLE',
  'BUDGET_EXCEEDED',

  'TEMPLATE_UNKNOWN',
  'TEMPLATE_VAR_MISSING',
  'TEMPLATE_VAR_LEFT',
  'TEMPLATE_DIR_NOT_EMPTY',

  'PREVIEW_PORT_EXHAUSTED',
  'PREVIEW_NOT_RUNNING',
  'PREVIEW_START_FAILED',
  'PREVIEW_DEPS_FAILED',

  'DB_START_FAILED',
  'DB_NOT_READY',
  'DB_DUMP_FAILED',
  'DB_RESTORE_FAILED',
  'DB_SNAPSHOT_MISSING',
  'DB_UNSUPPORTED',
  'DB_MIGRATE_FAILED',

  'EXPORT_FAILED',

  'RELEASE_NO_COMMITS',
  'RELEASE_FAILED',
  'RELEASE_CHECKS_FAILED',

  /** Hub（M6）：未配置是**正常状态**（官方 Hub 上线前就是它），不是故障 */
  'HUB_NOT_CONFIGURED',
  'HUB_BAD_BUNDLE',
  'HUB_BAD_SIGNATURE',
  'HUB_INSTALL_FAILED',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorPayload = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ErrorPayload = z.infer<typeof ErrorPayload>

const STATUS_BY_PREFIX: ReadonlyArray<readonly [string, number]> = [
  ['VALIDATION_', 400],
  ['UNAUTHORIZED', 401],
  ['METHOD_NOT_FOUND', 404],
  ['NOT_IMPLEMENTED', 501],
  ['APP_NOT_FOUND', 404],
  ['APP_SLUG_TAKEN', 409],
  ['APP_BUSY', 409],
  ['APP_HOME_MISSING', 409],
  ['CHAT_NOT_FOUND', 404],
  ['CHAT_EMPTY_INPUT', 400],
  ['CHAT_BUSY', 409],
  ['GIT_NOT_INITIALIZED', 409],
  ['GIT_COMMIT_FAILED', 500],
  ['GIT_DIFF_FAILED', 422],
  ['GIT_REVERT_FAILED', 500],
  ['GIT_DIRTY_WORKTREE', 409],
  ['AGENT_NO_MODEL', 409],
  ['AGENT_UNAVAILABLE', 503],
  // 402 而不是 409：这不是"状态冲突，等等再试"，是"钱用完了，得先动预算"
  ['BUDGET_EXCEEDED', 402],
  ['TEMPLATE_UNKNOWN', 404],
  ['TEMPLATE_VAR_MISSING', 500],
  ['TEMPLATE_VAR_LEFT', 500],
  ['TEMPLATE_DIR_NOT_EMPTY', 409],
  ['PREVIEW_PORT_EXHAUSTED', 503],
  ['PREVIEW_NOT_RUNNING', 409],
  ['PREVIEW_START_FAILED', 500],
  ['PREVIEW_DEPS_FAILED', 500],
  ['DB_START_FAILED', 500],
  ['DB_NOT_READY', 409],
  ['DB_DUMP_FAILED', 500],
  ['DB_RESTORE_FAILED', 500],
  ['DB_SNAPSHOT_MISSING', 409],
  ['DB_UNSUPPORTED', 501],
  ['DB_MIGRATE_FAILED', 500],
  ['EXPORT_FAILED', 500],
  ['HUB_NOT_CONFIGURED', 409],
  // 包坏了/签名不对是**客户端拒绝**，不是服务器错误 —— 用 422 让调用方知道"内容不可信"
  ['HUB_BAD_BUNDLE', 422],
  ['HUB_BAD_SIGNATURE', 422],
  ['HUB_INSTALL_FAILED', 500],
  ['RELEASE_NO_COMMITS', 409],
  ['RELEASE_FAILED', 500],
  // 409 而不是 500：检查没过不是系统故障，是「当前状态不允许」，用户改代码就能过
  ['RELEASE_CHECKS_FAILED', 409],
  ['INTERNAL', 500],
]

export function httpStatusFor(code: ErrorCode): number {
  for (const [prefix, status] of STATUS_BY_PREFIX) {
    if (code.startsWith(prefix)) return status
  }
  return 500
}

/** 业务错误的唯一载体。抛它，路由层统一转 envelope。 */
export class TenonError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'TenonError'
    this.code = code
    this.details = details
  }

  get httpStatus(): number {
    return httpStatusFor(this.code)
  }

  toPayload(): ErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function isTenonError(err: unknown): err is TenonError {
  return err instanceof TenonError
}
