/**
 * 自动更新的前端一半：**只读壳递过来的状态**。
 *
 * 为什么不是 RPC：能不能换安装包只有 Electron 主进程知道（见
 * `apps/desktop/src/updater.ts`）。浏览器里打开同一份页面时 `window.__TENON_UPDATE__`
 * 根本不存在 —— 这时整块更新入口**不渲染**，而不是渲染一个点了没反应的按钮。
 *
 * 为什么保留"拉一次 + 订阅"两条路：页面可能在检查已经开始之后才加载完，
 * 只靠订阅会漏掉那一次；只靠拉一次则后面的进度全看不见。
 */
import { useEffect, useState } from 'react'

export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface AppUpdateState {
  phase: UpdatePhase
  currentVersion: string
  version: string | null
  percent: number | null
  message: string
  hint: string | null
}

interface UpdateBridge {
  state(): Promise<AppUpdateState>
  check(): Promise<void>
  download(): Promise<void>
  install(): Promise<void>
  onState(listener: (state: AppUpdateState) => void): () => void
}

declare global {
  interface Window {
    /** 只在 Electron 壳里存在（由 `apps/desktop/src/preload.ts` 注入） */
    __TENON_UPDATE__?: UpdateBridge
  }
}

export interface AppUpdate {
  /** null = 这个环境没有更新这回事（浏览器 / preload 没加载成功） */
  state: AppUpdateState | null
  check(): void
  download(): void
  install(): void
}

export function useAppUpdate(): AppUpdate {
  const [state, setState] = useState<AppUpdateState | null>(null)

  useEffect(() => {
    const bridge = window.__TENON_UPDATE__
    if (bridge === undefined) return

    let alive = true
    void bridge.state().then((next) => {
      if (alive) setState(next)
    })
    const off = bridge.onState((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return {
    state,
    check: () => void window.__TENON_UPDATE__?.check(),
    download: () => void window.__TENON_UPDATE__?.download(),
    install: () => void window.__TENON_UPDATE__?.install(),
  }
}
