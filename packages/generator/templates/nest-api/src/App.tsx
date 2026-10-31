import { useCallback, useEffect, useState } from 'react'
import type { Item } from '../shared/schema'
import { api, type HealthPayload } from './api'

export function App() {
  const [items, setItems] = useState<Item[]>([])
  const [title, setTitle] = useState('')
  const [health, setHealth] = useState<HealthPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setItems(await api.list())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [refresh])

  async function submit(): Promise<void> {
    if (title.trim() === '' || busy) return
    setBusy(true)
    try {
      await api.create(title.trim())
      setTitle('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggle(item: Item): Promise<void> {
    try {
      await api.setDone(item.id, !item.done)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function remove(item: Item): Promise<void> {
    try {
      await api.remove(item.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const left = items.filter((item) => !item.done).length

  return (
    <main className="shell">
      <header className="head">
        <div>
          <h1>{{appName}}</h1>
          <p className="sub">
            {items.length === 0 ? '还没有事项' : `${left} 件待办 · 共 ${items.length} 件`}
          </p>
        </div>
        {health !== null && (
          <span className="chip" title={`迁移 ${health.db.migrations} 条 · 连接池上限 ${health.db.poolMax}`}>
            {health.db.version} · pool {health.db.poolMax ?? '?'}
          </span>
        )}
      </header>

      <form
        className="compose"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="写点什么，回车添加"
          maxLength={120}
        />
        <button type="submit" disabled={busy || title.trim() === ''}>
          添加
        </button>
      </form>

      {error !== null && (
        <p className="error">
          {error}
          <button type="button" className="link" onClick={() => void refresh()}>
            重试
          </button>
        </p>
      )}

      <ul className="list">
        {items.map((item) => (
          <li key={item.id} className={item.done ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={item.done} onChange={() => void toggle(item)} />
              <span>{item.title}</span>
            </label>
            <button type="button" className="link" onClick={() => void remove(item)}>
              删除
            </button>
          </li>
        ))}
      </ul>

      <footer className="foot">
        前端 React + Vite · 后端 NestJS + TypeORM · 数据在 PostgreSQL（本地是 WASM 版）
      </footer>
    </main>
  )
}
