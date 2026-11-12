/**
 * 前后端共用的账号契约（zod）。
 *
 * 后端用它校验入参、前端用它拿类型 —— 只有一份定义，所以"邮箱要 8 位还是 6 位"
 * 不会出现两边各说一套。加字段时先改这里，两边的类型检查会一起提醒。
 */
import { z } from 'zod'

export const Role = z.enum(['admin', 'member'])

/** 对外的用户形状。**没有** `passwordHash` —— 它不是"前端用不到"，是不该出后端 */
export const SessionUser = z.object({
  id: z.number().int(),
  email: z.string(),
  role: Role,
})
export type SessionUser = z.infer<typeof SessionUser>

/** `GET /api/auth/status`：要不要初始化、现在是谁 */
export const AuthStatus = z.object({
  needsSetup: z.boolean(),
  user: SessionUser.nullable(),
})
export type AuthStatus = z.infer<typeof AuthStatus>

/** `POST /api/auth/setup` —— 第一个管理员 */
export const SetupInput = z.object({
  email: z.string().email('not a valid email address'),
  password: z.string().min(8, 'the password must be at least 8 characters'),
})

/** `POST /api/auth/login` —— 密码只要求非空：规则变化不该把老账号挡在门外 */
export const LoginInput = z.object({
  email: z.string().email('not a valid email address'),
  password: z.string().min(1, 'the password is required'),
})

/** `POST /api/auth/users` —— 管理员加人 */
export const NewUserInput = z.object({
  email: z.string().email('not a valid email address'),
  password: z.string().min(8, 'the password must be at least 8 characters'),
  role: Role.default('member'),
})

/** `POST /api/auth/password` —— 改自己的口令 */
export const PasswordInput = z.object({
  current: z.string().min(1, 'the current password is required'),
  next: z.string().min(8, 'the new password must be at least 8 characters'),
})

/** `GET /api/auth/users` */
export const UserList = z.object({ users: z.array(SessionUser) })
export type UserList = z.infer<typeof UserList>

/** 登录/初始化/加人的响应 */
export const UserEnvelope = z.object({ user: SessionUser })
export type UserEnvelope = z.infer<typeof UserEnvelope>
