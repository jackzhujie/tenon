/**
 * 登录闸门。
 *
 * 用法（`src/main.tsx` 里已经帮你包好了）：
 * ```tsx
 * <TenonErrorBoundary>
 *   <AuthGate>
 *     <App appName="..." />
 *   </AuthGate>
 * </TenonErrorBoundary>
 * ```
 *
 * 它只做三件事：加载时问一次"我是谁"、没登录就渲染登录页、登录了就放行并在右上角挂一条
 * 账号栏。**不做路由**：这个应用没有路由（也不该因为加了个登录就长出路由来）。
 *
 * 为什么放开手判断"算不算登录"给后端：前端凭 `login()` 返回 200 就认为已登录，
 * 会在会话过期/被管理员删号之后继续显示界面，然后每个请求都 401 —— 用户看到的是
 * "页面打开了但到处转圈"。这里每次加载都问 `/api/auth/status`，答案只有一个来源。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SessionUser } from '../../shared/auth-schema'
import { appTitle, auth } from './auth-client'
import { LoginPage } from './LoginPage'
import { MembersPanel } from './MembersPanel'
import { detectTone } from './tone'
import './auth.css'

interface Snapshot {
  loading: boolean
  needsSetup: boolean
  user: SessionUser | null
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ loading: true, needsSetup: false, user: null })
  const [membersOpen, setMembersOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /* 账号栏与浮层的配色跟随应用底色，而不是系统偏好（见 tone.ts） */
  const [tone] = useState(detectTone)

  const reload = useCallback(() => {
    void auth.status().then(
      (value) => setSnapshot({ loading: false, needsSetup: value.needsSetup, user: value.user }),
      /* 后端没起来时不要卡在"正在确认登录状态"：直接当未登录，登录页会把错误显示出来 */
      () => setSnapshot({ loading: false, needsSetup: false, user: null }),
    )
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  if (snapshot.loading) {
    return (
      <div className="auth-splash" data-tone={tone}>
        正在确认登录状态…
      </div>
    )
  }

  if (snapshot.user === null) {
    return <LoginPage needsSetup={snapshot.needsSetup} title={appTitle()} onDone={reload} />
  }

  const user = snapshot.user

  async function signOut(): Promise<void> {
    setBusy(true)
    try {
      await auth.logout()
    } catch {
      // 网络断了也要回到登录页：卡在原地看着像按钮没反应
    }
    setBusy(false)
    reload()
  }

  return (
    <>
      <div className="auth-bar" data-tone={tone}>
        <span className="auth-who" title={user.email}>
          {user.email}
        </span>
        <span className="auth-role">{user.role === 'admin' ? '管理员' : '成员'}</span>
        {user.role === 'admin' && (
          <button type="button" className="auth-link" onClick={() => setMembersOpen(true)}>
            成员
          </button>
        )}
        <button type="button" className="auth-link" onClick={() => void signOut()} disabled={busy}>
          退出
        </button>
      </div>

      {children}

      {membersOpen && <MembersPanel me={user} tone={tone} onClose={() => setMembersOpen(false)} />}
    </>
  )
}
