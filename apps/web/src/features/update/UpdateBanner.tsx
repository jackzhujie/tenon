/**
 * 更新提示条。
 *
 * 位置与形状的两个决定：
 *
 * 1. **在顶栏下面横着一条**，不是弹窗、不是右下角 toast。更新不是"现在必须处理"的事，
 *    弹窗会打断用户正在写的需求；而这条横幅只在"有新版本 / 下载中 / 待重启 / 出错"时出现，
 *    平时占零高度（`unavailable` 与 `current` 直接不渲染）。
 * 2. **只给一个主动作**。检查出有新版时主按钮是「下载」，下载完变成「重启安装」，
 *    出错时变成「重试」。三个按钮并排等于没有重点。
 */
import { useState } from 'react'
import { cn } from '../../lib/cn.js'
import type { AppUpdate, AppUpdateState } from '../../hooks/useAppUpdate.js'

/** 哪些阶段需要让人看见。`idle` / `checking` / `current` 都属于"没事"，不占地方 */
function isVisible(state: AppUpdateState): boolean {
  return (
    state.phase === 'available' ||
    state.phase === 'downloading' ||
    state.phase === 'ready' ||
    state.phase === 'error'
  )
}

export function UpdateBanner({ update }: { update: AppUpdate }) {
  const { state } = update
  /**
   * 「以后再说」记住的是**哪一次提示**，不是"这个阶段"。
   *
   * `epoch` 在用户主动点任何按钮（下载 / 重试 / 重启）时 +1 —— 于是同一个错误
   * 点过"重试"之后再失败也会重新出现。用 key 直接比较就够了，不需要 effect 去清理状态：
   * 在 effect 里 setState 会多渲染一轮，而且这条 react-hooks 规则项目里是 0 error 的。
   */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  const key = state === null ? '' : `${state.phase}:${state.version ?? ''}:${String(epoch)}`

  if (state === null || !isVisible(state) || dismissed === key) return null

  const busy = state.phase === 'downloading'
  const isError = state.phase === 'error'

  /** 用户主动动作：先作废"以后再说"，再交给壳 */
  const act = (run: () => void): void => {
    setDismissed(null)
    setEpoch((current) => current + 1)
    run()
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[11.5px]',
        isError
          ? 'border-bad/30 bg-[#241413]'
          : 'border-line-soft bg-panel-2/60',
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          isError ? 'bg-bad' : busy ? 'bg-brand tenon-pulse' : 'bg-ok/70',
        )}
      />

      <span className={cn('shrink-0', isError ? 'text-bad' : 'text-muted')}>{state.message}</span>

      {/* 出错时把"下一步能做什么"直接写出来，别让用户自己猜 */}
      {state.hint !== null && <span className="truncate text-faint">{state.hint}</span>}

      {/* 下载进度：一条 80px 的细条，比百分比数字更能看出"在动" */}
      {busy && (
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-20 overflow-hidden rounded-full bg-line">
            <span
              className="block h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${String(state.percent ?? 0)}%` }}
            />
          </span>
          <span className="font-mono text-[10px] tabular-nums text-faint">
            {state.percent ?? 0}%
          </span>
        </span>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-3">
        {state.phase === 'available' && (
          <button
            type="button"
            onClick={() => act(update.download)}
            className="text-brand-soft hover:text-brand"
          >
            下载
          </button>
        )}
        {state.phase === 'ready' && (
          <button
            type="button"
            onClick={() => act(update.install)}
            className="text-brand-soft hover:text-brand"
          >
            重启安装
          </button>
        )}
        {isError && (
          <button
            type="button"
            onClick={() => act(update.check)}
            className="text-bad/80 hover:text-bad"
          >
            重试
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(key)}
          className="text-faint hover:text-muted"
        >
          以后再说
        </button>
      </span>
    </div>
  )
}
