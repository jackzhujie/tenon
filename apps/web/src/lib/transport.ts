/**
 * 端点解析：前端在三种形态下都要能找到本机 server。
 *
 * | 形态 | `baseUrl` | `token` |
 * |---|---|---|
 * | 开发（`pnpm dev:web`） | Vite 注入的 `__TENON_BASE__` | Vite 注入的 `__TENON_TOKEN__` |
 * | Electron / 同源托管 | `location.origin` | server 在 index.html 里注入的 `window.__TENON__` |
 * | 纯 Web（反代在别的域名） | 同左，靠注入 | 同左 |
 *
 * 为什么 token 不能写死在代码里：它是**每次启动随机生成**的（见 `server/src/auth.ts`）。
 * 所以它只能是运行时注入，前端不生成它、不保存它、也不往日志里打。
 */

declare const __TENON_BASE__: string
declare const __TENON_TOKEN__: string

export interface TenonEndpoint {
  /** 不含尾斜杠；同源形态下是 `location.origin` */
  readonly baseUrl: string
  /** 没有就是 `null`（同源托管不需要） */
  readonly token: string | null
}

interface InjectedBridge {
  baseUrl?: string
  token?: string
}

declare global {
  interface Window {
    /** Electron preload / 宿主页面注入。存在时优先级最高 */
    __TENON__?: InjectedBridge
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function resolveEndpoint(): TenonEndpoint {
  const bridge = typeof window === 'undefined' ? undefined : window.__TENON__
  if (bridge !== undefined) {
    /*
     * 只带 token 也算桥接：同源托管时 server 只注入 `{token}`，
     * `baseUrl` 省掉就是 `location.origin`。以前这里要求 baseUrl 非空，
     * 结果**同源形态下注入的 token 被整份丢掉**，界面能打开但所有请求 401。
     */
    const base = bridge.baseUrl === undefined || bridge.baseUrl === '' ? location.origin : bridge.baseUrl
    return {
      baseUrl: trimTrailingSlash(base),
      token: bridge.token === undefined || bridge.token === '' ? null : bridge.token,
    }
  }

  // `__TENON_BASE__` 在生产构建里是空串（Vite define 替换的结果）
  if (typeof __TENON_BASE__ === 'string' && __TENON_BASE__ !== '') {
    return {
      baseUrl: trimTrailingSlash(__TENON_BASE__),
      token:
        typeof __TENON_TOKEN__ === 'string' && __TENON_TOKEN__ !== '' ? __TENON_TOKEN__ : null,
    }
  }

  return { baseUrl: location.origin, token: null }
}

/** 拼一个绝对 URL。同源时 `baseUrl` 就是 origin，直接交给 `new URL` 也不会出错 */
export function endpointUrl(endpoint: TenonEndpoint, path: string): URL {
  return new URL(path, endpoint.baseUrl)
}

/** 给 `fetch` 用的鉴权头。没有 token 时返回空对象（不要发一个空的 Authorization） */
export function authHeaders(endpoint: TenonEndpoint): Record<string, string> {
  return endpoint.token === null ? {} : { authorization: `Bearer ${endpoint.token}` }
}

/**
 * `EventSource` 不能自定义请求头，只能把 token 塞进 query。
 * 这不是妥协：`server/src/auth.ts` 的 `extractToken` 就认这个位置，
 * 且连接仍然只发生在 127.0.0.1 上。
 */
export function withToken(url: URL, endpoint: TenonEndpoint): URL {
  if (endpoint.token !== null) url.searchParams.set('token', endpoint.token)
  return url
}
