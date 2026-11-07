import { Health } from '../shared/schema'

/**
 * 后端调用只有一个出口：**相对路径 `/api/...`**。
 *
 * 走网关时由网关按前缀分给 Nest，直接开 vite 端口时由 vite 的 proxy 转发 ——
 * 两条路同一个地址，所以这里不需要知道自己是"被 iframe 打开"还是"直接打开"。
 *
 * 返回值用 `shared/schema.ts` 的 zod 校验一遍：后端改了字段名而前端没跟上时，
 * 这里会直接报「哪个字段不对」，而不是等到界面上某个 `undefined.map` 才炸。
 */
async function request<T>(path: string, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await fetch(`/api${path}`, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`${response.status} ${response.statusText}${detail === '' ? '' : `：${detail}`}`)
  }
  return schema.parse(await response.json())
}

export const api = {
  health: (): Promise<Health> => request('/health', Health),
}
