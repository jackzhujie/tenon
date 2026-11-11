import { useEffect, useState } from 'react'
import type { PreviewStatus, Readiness } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import {
  DiffIcon,
  ExternalIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
  RestartIcon,
} from '../../components/icons.js'
import { cn } from '../../lib/cn.js'
import { INSPECTOR_HASH_KEY } from '../../lib/selection.js'
import { useT } from '../../lib/i18n.js'
import type { PreviewKey } from '../../lib/messages/preview.js'

type StageState = Readiness['deps']

const STAGE_KEY: Record<keyof Readiness, PreviewKey> = {
  deps: 'preview.step.deps',
  db: 'preview.step.db',
  server: 'preview.step.server',
  preview: 'preview.step.preview',
}

/** 顺序就是起服务的顺序，进度条按它推进 */
const STAGES: Array<keyof Readiness> = ['deps', 'db', 'server', 'preview']

function stageDot(state: StageState): string {
  if (state === 'ready') return 'bg-ok'
  if (state === 'failed') return 'bg-bad'
  return 'bg-warn tenon-pulse'
}

function StagePills({ readiness }: { readiness: Readiness }) {
  const { t } = useT()
  return (
    <div className="flex items-center gap-2.5">
      {STAGES.map((key) => (
        <span key={key} className="flex items-center gap-1">
          <span className={cn('size-1.5 rounded-full', stageDot(readiness[key]))} />
          <span className="text-[10.5px] text-faint">{t(STAGE_KEY[key])}</span>
        </span>
      ))}
    </div>
  )
}

const PROGRESS_WIDTH: Record<number, string> = {
  0: 'w-[8%]',
  1: 'w-1/3',
  2: 'w-1/2',
  3: 'w-2/3',
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-10 text-center">
      {children}
    </div>
  )
}

export interface PreviewPanelProps {
  appId: string | null
  preview: PreviewStatus | null
  fullscreen: boolean
  /** 精调 inspector 的会话 token（拼进 iframe 的 hash，见 useInspectorSelection） */
  inspectorToken: string | null
  /** 这一版改了什么 —— 打开改动面板（覆盖在预览之上，iframe 不卸载） */
  onOpenDiff(): void
  onStart(restart?: boolean): void
  onToggleFullscreen(): void
}

export function PreviewPanel({
  appId,
  preview,
  fullscreen,
  inspectorToken,
  onOpenDiff,
  onStart,
  onToggleFullscreen,
}: PreviewPanelProps) {
  const { t } = useT()
  const [reloadKey, setReloadKey] = useState(0)

  // 换了应用就把 iframe 换掉，别让上一个应用的页面留在里面
  useEffect(() => {
    setReloadKey((value) => value + 1)
  }, [appId])

  const state = preview?.state ?? 'stopped'
  const url = preview?.url ?? null
  const readiness = preview?.readiness ?? {
    deps: 'pending',
    db: 'pending',
    server: 'pending',
    preview: 'pending',
  }
  const reached = STAGES.filter((key) => readiness[key] === 'ready').length
  const stageHint =
    readiness.deps !== 'ready'
      ? t('preview.wait.deps')
      : readiness.db !== 'ready'
        ? t('preview.wait.db')
        : readiness.server !== 'ready'
          ? t('preview.wait.server')
          : t('preview.wait.firstScreen')

  return (
    /* 同 ChatPanel：`flex-1` 少了，下面的 `relative flex-1` 会塌成 0 高，
       空态文字就贴在标题栏下沿，而不是居中 */
    <div className="flex min-h-0 flex-1 flex-col bg-[#080706]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft bg-panel/50 px-3">
        <span className="text-[11.5px] text-muted">{t('preview.title')}</span>
        {state === 'starting' && <StagePills readiness={readiness} />}
        {state === 'ready' && preview?.gatewayPort != null && (
          <span className="font-mono text-[10.5px] text-faint">:{preview.gatewayPort}</span>
        )}
        {state === 'failed' && <span className="text-[11px] text-bad">{t('preview.failed')}</span>}

        <span className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title={t('preview.openDiff')}
            disabled={appId === null}
            onClick={onOpenDiff}
          >
            <DiffIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title={t('preview.reload')}
            disabled={url === null}
            onClick={() => setReloadKey((value) => value + 1)}
          >
            <RefreshIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title={t('preview.restart')}
            disabled={appId === null}
            onClick={() => onStart(true)}
          >
            <RestartIcon className="size-3.5" />
          </Button>
          {url !== null && (
            <Button
              variant="ghost"
              size="sm"
              className="px-1.5"
              title={t('preview.openTab')}
              onClick={() => window.open(url, '_blank', 'noreferrer')}
            >
              <ExternalIcon className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title={fullscreen ? t('preview.fullscreenOff') : t('preview.fullscreenOn')}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <MinimizeIcon className="size-3.5" /> : <MaximizeIcon className="size-3.5" />}
          </Button>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {appId === null && (
          <Centered>
            <p className="text-[12.5px] text-faint">{t('preview.empty.pick')}</p>
          </Centered>
        )}

        {appId !== null && state === 'stopped' && (
          <Centered>
            <p className="text-[12.5px] text-muted">{t('preview.empty.notStarted')}</p>
            <Button variant="outline" size="sm" onClick={() => onStart(false)}>
              {t('preview.start')}
            </Button>
          </Centered>
        )}

        {appId !== null && state === 'starting' && (
          <Centered>
            <div className="w-56 space-y-2">
              <StagePills readiness={readiness} />
              <div className="h-1 overflow-hidden rounded-full bg-line-soft">
                <div
                  className={cn(
                    'h-full rounded-full bg-brand transition-[width] duration-500',
                    PROGRESS_WIDTH[reached] ?? 'w-full',
                  )}
                />
              </div>
              <p className="text-[11.5px] text-faint">{stageHint}</p>
            </div>
          </Centered>
        )}

        {appId !== null && state === 'failed' && (
          <Centered>
            <p className="max-w-[52ch] text-[12px] leading-relaxed text-bad">
              {preview?.error ?? t('preview.error')}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onStart(true)}>
                {t('preview.retry')}
              </Button>
            </div>
          </Centered>
        )}

        {state === 'ready' && url !== null && (
          /*
           * 故意**不加** `sandbox`：生成的应用在网关端口上，与本页不同源 ——
           * 本来就拿不到父页面的 DOM 和 storage。加了 sandbox 反而可能掐掉 HMR 的 WebSocket
           * 或 localStorage，症状是「页面能开但热更新不生效」，极难查。
           * 真正需要更严的隔离时（M2 的探针注入）再一起设计。
           */
          <iframe
            key={reloadKey}
            /*
             * token 走 hash 不走 query：query 会进网关与 dev server 的访问日志，
             * hash 只在浏览器里存在。应用侧的 inspector 从 `location.hash` 读它。
             */
            src={inspectorToken === null ? url : `${url}#${INSPECTOR_HASH_KEY}=${inspectorToken}`}
            title={t('preview.iframeTitle')}
            className="size-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  )
}
