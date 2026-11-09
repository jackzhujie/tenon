/**
 * 成员管理（只有管理员看得到）。
 *
 * 为什么不做成"一个成员页面"：这个应用可能没有路由，加一个 `/members` 就得给它
 * 引入一套路由，而那会把用户自己写的东西搅进去。做成一个浮层，代价是 0 行路由。
 *
 * ★ 别在前端做权限判断然后"不显示按钮"就当安全了：真正的拦截在 `AuthController`
 *   的 `requireAdmin`。这里藏按钮只是为了让人少点一次会报错的东西。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { SessionUser } from '../../shared/auth-schema'
import { ApiError, auth } from './auth-client'
import type { Tone } from './tone'

export function MembersPanel({
  me,
  tone,
  onClose,
}: {
  me: SessionUser
  tone: Tone
  onClose: () => void
}) {
  const [users, setUsers] = useState<SessionUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<SessionUser['role']>('member')

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => {
    void auth.users().then(
      (value) => setUsers(value.users),
      (cause: unknown) => setError(message(cause, '读不到成员列表')),
    )
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  async function addMember(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await auth.addUser(email.trim(), password, role)
      setEmail('')
      setPassword('')
      setRole('member')
      reload()
    } catch (cause) {
      setError(message(cause, '加不上这个人'))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(id: number): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await auth.removeUser(id)
      reload()
    } catch (cause) {
      setError(message(cause, '删不掉'))
    } finally {
      setBusy(false)
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await auth.changePassword(current, next)
      setCurrent('')
      setNext('')
      setError(null)
      setNotice('密码已改，下次登录用新密码。')
    } catch (cause) {
      setError(message(cause, '改不了密码'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="auth-panel" data-tone={tone} onClick={(event) => event.stopPropagation()}>
        <header className="auth-panel-head">
          <h2>成员</h2>
          <button type="button" className="auth-link" onClick={onClose}>
            关闭
          </button>
        </header>

        {error !== null && <p className="auth-error">{error}</p>}
        {notice !== null && <p className="auth-notice">{notice}</p>}

        <ul className="auth-list">
          {users.map((user) => (
            <li key={user.id}>
              <span className="auth-list-mail">{user.email}</span>
              <span className="auth-role">{user.role === 'admin' ? '管理员' : '成员'}</span>
              {user.id === me.id ? (
                <span className="auth-muted">（你）</span>
              ) : (
                <button
                  type="button"
                  className="auth-link"
                  disabled={busy}
                  onClick={() => void removeMember(user.id)}
                >
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>

        <form className="auth-sub" onSubmit={(event) => void addMember(event)}>
          <h3>加一个人</h3>
          <div className="auth-row">
            <input
              type="email"
              placeholder="邮箱"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <input
              type="text"
              placeholder="初始密码（至少 8 位）"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')}
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <button type="submit" className="auth-submit auth-submit-inline" disabled={busy}>
              添加
            </button>
          </div>
          <p className="auth-muted">把初始密码告诉对方，让他登录后自己改。</p>
        </form>

        <form className="auth-sub" onSubmit={(event) => void changePassword(event)}>
          <h3>改我的密码</h3>
          <div className="auth-row">
            <input
              type="password"
              placeholder="当前密码"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoComplete="current-password"
              required
            />
            <input
              type="password"
              placeholder="新密码（至少 8 位）"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
              required
            />
            <button type="submit" className="auth-submit auth-submit-inline" disabled={busy}>
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}
