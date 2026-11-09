/**
 * 登录 / 初始化页。
 *
 * 一个组件两种形态，因为它们只差"要不要再输一遍密码"和一句说明 ——
 * 拆成两个文件会让「第一次打开」和「之后每次打开」的视觉漂移。
 *
 * 提交成功后不自己跳转，交给 `onDone`：AuthGate 重新问一次 `/api/auth/status`，
 * 这样"现在算不算登录"永远由后端说了算，而不是前端凭一次 200 猜的。
 */
import { useState, type FormEvent } from 'react'
import { ApiError, auth } from './auth-client'
import { detectTone } from './tone'

export function LoginPage({
  needsSetup,
  title,
  onDone,
}: {
  needsSetup: boolean
  title: string
  onDone: () => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /* 跟随应用自己的底色（见 tone.ts）；只在挂载时算一次 */
  const [tone] = useState(detectTone)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (needsSetup && password !== confirm) {
      setError('两次输入的密码不一样')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (needsSetup) await auth.setup(email.trim(), password)
      else await auth.login(email.trim(), password)
      onDone()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '连不上后端，确认服务起来了再试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page" data-tone={tone}>
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <p className="auth-eyebrow">{needsSetup ? '第一次打开' : '需要登录'}</p>
        <h1 className="auth-title">{title}</h1>
        <p className="auth-hint">
          {needsSetup
            ? '这个应用还没有账号。先创建一个管理员，之后由管理员在「成员」里加人。'
            : '用管理员给你的邮箱和密码登录。'}
        </p>

        <label className="auth-field">
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            placeholder="you@example.com"
            required
          />
        </label>

        <label className="auth-field">
          <span>{needsSetup ? '设一个密码（至少 8 位）' : '密码'}</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            required
          />
        </label>

        {needsSetup && (
          <label className="auth-field">
            <span>再输一遍</span>
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        )}

        {error !== null && <p className="auth-error">{error}</p>}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? '处理中…' : needsSetup ? '创建管理员并进入' : '登录'}
        </button>
      </form>
    </div>
  )
}
