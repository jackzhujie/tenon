import { useEffect, useState } from 'react'
import type { PreviewStatus, Readiness } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import {
  ExternalIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
  RestartIcon,
} from '../../components/icons.js'
import { cn } from '../../lib/cn.js'

type StageState = Readiness['deps']

const STAGE_LABEL: Record<keyof Readiness, string> = {
  deps: '依赖',
  server: '服务',
  preview: '首屏',
}

function stageDot(state: StageState): string {
  if (state === 'ready') return 'bg-ok'
  if (state === 'failed') return 'bg-bad'
  return 'bg-warn tenon-pulse'
}

function StagePills({ readiness }: { readiness: Readiness }) {
  const keys: Array<keyof Readiness> = ['deps', 'server', 'preview']
  return (
    <div className="flex items-center gap-2.5">
      {keys.map((key) => (
        <span key={key} className="flex items-center gap-1">
          <span className={cn('size-1.5 rounded-full', stageDot(readiness[key]))} />
          <span className="text-[10.5px] text-faint">{STAGE_LABEL[key]}</span>
        </span>
      ))}
    </div>
  )
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
  onStart(restart?: boolean): void
  onToggleFullscreen(): void
}

export function PreviewPanel({
  appId,
  preview,
  fullscreen,
  onStart,
  onToggleFullscreen,
}: PreviewPanelProps) {
  const [reloadKey, setReloadKey] = useState(0)

  // 换了应用就把 iframe 换掉，别让上一个应用的页面留在里面
  useEffect(() => {
    setReloadKey((value) => value + 1)
  }, [appId])

  const state = preview?.state ?? 'stopped'
  const url = preview?.url ?? null
  const readiness = preview?.readiness ?? { deps: 'pending', server: 'pending', preview: 'pending' }

  return (
    /* 同 ChatPanel：`flex-1` 少了，下面的 `relative flex-1` 会塌成 0 高，
       空态文字就贴在标题栏下沿，而不是居中 */
    <div className="flex min-h-0 flex-1 flex-col bg-[#080706]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft bg-panel/50 px-3">
        <span className="text-[11.5px] text-muted">预览</span>
        {state === 'starting' && <StagePills readiness={readiness} />}
        {state === 'ready' && preview?.gatewayPort != null && (
          <span className="font-mono text-[10.5px] text-faint">:{preview.gatewayPort}</span>
        )}
        {state === 'failed' && <span className="text-[11px] text-bad">启动失败</span>}

        <span className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title="刷新页面"
            disabled={url === null}
            onClick={() => setReloadKey((value) => value + 1)}
          >
            <RefreshIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title="重启预览（改了依赖或配置后用）"
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
              title="在新标签页打开"
              onClick={() => window.open(url, '_blank', 'noreferrer')}
            >
              <ExternalIcon className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            title={fullscreen ? '退出全屏' : '预览全屏'}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <MinimizeIcon className="size-3.5" /> : <MaximizeIcon className="size-3.5" />}
          </Button>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {appId === null && (
          <Centered>
            <p className="text-[12.5px] text-faint">选择一个应用后在这里预览</p>
          </Centered>
        )}

        {appId !== null && state === 'stopped' && (
          <Centered>
            <p className="text-[12.5px] text-muted">预览未启动</p>
            <Button variant="outline" size="sm" onClick={() => onStart(false)}>
              启动预览
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
                    readiness.preview === 'ready'
                      ? 'w-full'
                      : readiness.server === 'ready'
                        ? 'w-2/3'
                        : readiness.deps === 'ready'
                          ? 'w-1/3'
                          : 'w-1/6',
                  )}
                />
              </div>
              <p className="text-[11.5px] text-faint">
                {readiness.deps !== 'ready'
                  ? '首次启动会安装依赖，请稍等…'
                  : readiness.server !== 'ready'
                    ? '正在启动开发服务器…'
                    : '等待首屏响应…'}
              </p>
            </div>
          </Centered>
        )}

        {appId !== null && state === 'failed' && (
          <Centered>
            <p className="max-w-[52ch] text-[12px] leading-relaxed text-bad">
              {preview?.error ?? '预览启动失败'}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onStart(true)}>
                重试
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
            src={url}
            title="应用预览"
            className="size-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  )
}
