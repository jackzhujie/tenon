/**
 * 账号接口的调用出口。
 *
 * 和后端共用 `shared/auth-schema.ts` 的契约：返回体一律过一遍 zod，后端改了字段名
 * 而页面没跟上时，这里会立刻说"哪个字段不对"，而不是等到界面上某个 `undefined.map`。
 *
 * ★ 会话在 httpOnly cookie 里，所以**没有任何 token 需要前端保存**。
 *   `credentials: 'same-origin'` 是默认值，这里显式写出来的理由只有一个：
 *   以后有人把接口挪到别的域名，这行是唯一会提醒他"登录会失效"的地方。
 */
import {
  AuthStatus,
  UserEnvelope,
  UserList,
  type SessionUser,
} from '../../shared/auth-schema'

/** 带状态码的错误：页面要靠 401 区分"没登录"和"真出错了" */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface Parser<T> {
  parse(value: unknown): T
}

async function errorText(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 300)
  if (text === '') return `${response.status} ${response.statusText}`
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const message = (parsed as { message?: unknown }).message
      if (typeof message === 'string' && message !== '') return message
      if (Array.isArray(message)) return message.join('；')
    }
  } catch {
    /* 不是 JSON（502 的纯文本之类）就原样用 */
  }
  return text
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new ApiError(response.status, await errorText(response))
  return response
}

async function request<T>(path: string, init: RequestInit, schema: Parser<T>): Promise<T> {
  const response = await send(path, init)
  return schema.parse(await response.json())
}

/** 204 的接口没有响应体，`response.json()` 会抛 —— 所以单独一条 */
async function requestVoid(path: string, init: RequestInit): Promise<void> {
  await send(path, init)
}

export const auth = {
  status: (): Promise<{ needsSetup: boolean; user: SessionUser | null }> =>
    request('/auth/status', { method: 'GET' }, AuthStatus),

  setup: (email: string, password: string): Promise<{ user: SessionUser }> =>
    request('/auth/setup', { method: 'POST', body: JSON.stringify({ email, password }) }, UserEnvelope),

  login: (email: string, password: string): Promise<{ user: SessionUser }> =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, UserEnvelope),

  logout: (): Promise<void> => requestVoid('/auth/logout', { method: 'POST' }),

  users: (): Promise<{ users: SessionUser[] }> =>
    request('/auth/users', { method: 'GET' }, UserList),

  addUser: (email: string, password: string, role: SessionUser['role']): Promise<{ user: SessionUser }> =>
    request('/auth/users', { method: 'POST', body: JSON.stringify({ email, password, role }) }, UserEnvelope),

  removeUser: (id: number): Promise<void> => requestVoid(`/auth/users/${id}`, { method: 'DELETE' }),

  changePassword: (current: string, next: string): Promise<void> =>
    requestVoid('/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
}

/** 页面标题当应用名用：AuthGate 在登录前拿不到 App 里的任何 props */
export function appTitle(): string {
  const title = document.title.trim()
  return title === '' ? '这个应用' : title
}
