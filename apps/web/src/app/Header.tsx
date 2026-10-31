import type { App } from '@tenon/protocol'
import { AppMenu } from '../features/apps/AppMenu.js'
import { PlusIcon } from '../components/icons.js'
import { Button } from '../components/ui/Button.js'
import { cn } from '../lib/cn.js'
import type { ActiveModel } from '../hooks/useWorkspace.js'
import type { StreamState } from '../lib/stream.js'

const STREAM_LABEL: Record<StreamState, string> = {
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重连中',
  failed: '已断开',
  stopped: '未连接',
}

function StreamDot({ state }: { state: StreamState }) {
  const ok = state === 'open'
  const bad = state === 'failed'
  return (
    <span className="flex items-center gap-1.5" title={`事件流：${STREAM_LABEL[state]}`}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          ok ? 'bg-ok' : bad ? 'bg-bad' : 'bg-warn tenon-pulse',
        )}
      />
      <span className="text-[10.5px] text-faint">{STREAM_LABEL[state]}</span>
    </span>
  )
}

function ModelTag({ model }: { model: ActiveModel | null }) {
  if (model === null) {
    return <span className="text-[10.5px] text-warn">未配置模型</span>
  }
  const faux = model.mode === 'faux'
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-0.5 font-mono text-[10px]',
        faux
          ? 'border-warn/30 bg-warn/10 text-warn'
          : 'border-line bg-panel-2 text-muted',
      )}
      title={faux ? '当前是本地假模型，回复内容是固定文案，仅用于验证链路' : model.providerId}
    >
      {faux ? '假模型 · 仅验证链路' : model.modelId}
    </span>
  )
}

export interface HeaderProps {
  apps: App[]
  activeApp: App | null
  model: ActiveModel | null
  stream: StreamState
  onSelectApp(appId: string): void
  onCreate(): void
}

export function Header({ apps, activeApp, model, stream, onSelectApp, onCreate }: HeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3">
      <div className="flex items-center gap-2 pr-1">
        <span className="flex size-6 items-center justify-center rounded-md bg-brand text-[12px] font-medium text-[#20120a]">
          榫
        </span>
        <span className="text-[12.5px] tracking-tight text-ink">Tenon</span>
      </div>

      <span className="h-4 w-px bg-line" />

      <AppMenu apps={apps} activeApp={activeApp} onSelect={onSelectApp} onCreate={onCreate} />

      <Button variant="ghost" size="sm" className="px-1.5" title="新建应用" onClick={onCreate}>
        <PlusIcon className="size-3.5" />
      </Button>

      <div className="ml-auto flex items-center gap-3">
        <ModelTag model={model} />
        <StreamDot state={stream} />
      </div>
    </header>
  )
}
