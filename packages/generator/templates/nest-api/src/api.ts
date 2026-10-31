import type { Item } from '../shared/schema'

/**
 * 后端调用只有一个出口：**相对路径 `/api/...`**。
 *
 * 走网关时由网关按前缀分给 Nest，直接开 vite 端口时由 vite 的 proxy 转发 ——
 * 两条路同一个地址，所以这里不需要知道自己是"被 iframe 打开"还是"直接打开"。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`${response.status} ${response.statusText}${detail === '' ? '' : `：${detail}`}`)
  }
  return (await response.json()) as T
}

export interface HealthPayload {
  ok: boolean
  db: { database: string | null; version: string; poolMax: number | null; migrations: number }
  at: string
}

export const api = {
  health: (): Promise<HealthPayload> => request<HealthPayload>('/health'),
  list: async (): Promise<Item[]> => (await request<{ items: Item[] }>('/items')).items,
  create: (title: string): Promise<Item> =>
    request<Item>('/items', { method: 'POST', body: JSON.stringify({ title }) }),
  setDone: (id: number, done: boolean): Promise<Item> =>
    request<Item>(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
  remove: async (id: number): Promise<void> => {
    await request<{ ok: true }>(`/items/${id}`, { method: 'DELETE' })
  },
}
