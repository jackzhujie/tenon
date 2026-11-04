import type { App, BudgetDimension, UsageSnapshot } from '@tenon/protocol'
import { AppMenu } from '../features/apps/AppMenu.js'
import { PluginsPanel } from '../features/plugins/PluginsPanel.js'
import { ModelPanel } from '../features/settings/ModelPanel.js'
import { UsagePanel } from '../features/usage/UsagePanel.js'
import { PlusIcon } from '../components/icons.js'
import { Button } from '../components/ui/Button.js'
import { cn } from '../lib/cn.js'
import type { ActiveModel, Outcome } from '../hooks/useWorkspace.js'
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

export interface HeaderProps {
  apps: App[]
  activeApp: App | null
  model: ActiveModel | null
  /** 模型设置保存之后重新问一次（顶栏标签立刻跟上） */
  onModelChanged(): Promise<void> | void
  stream: StreamState
  usage: UsageSnapshot | null
  /** 这一轮被额度掐了是哪个维度（null = 没被掐） */
  budgetStopped: BudgetDimension | null
  onSetBudget(maxCostUsd: number | null, maxTokens: number | null): Promise<Outcome>
  onSelectApp(appId: string): void
  onCreate(): void
  /** 删除应用（代码 + 数据库 + 日志一起删） */
  onDeleteApp(appId: string): Promise<void>
  /** 打开发布对话框 */
  onRelease(): void
}

export function Header({
  apps,
  activeApp,
  model,
  onModelChanged,
  stream,
  usage,
  budgetStopped,
  onSetBudget,
  onSelectApp,
  onCreate,
  onDeleteApp,
  onRelease,
}: HeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3">
      <div className="flex items-center gap-2 pr-1">
        <span className="flex size-6 items-center justify-center rounded-md bg-brand text-[12px] font-medium text-[#20120a]">
          榫
        </span>
        <span className="text-[12.5px] tracking-tight text-ink">Tenon</span>
      </div>

      <span className="h-4 w-px bg-line" />

      <AppMenu
        apps={apps}
        activeApp={activeApp}
        onSelect={onSelectApp}
        onCreate={onCreate}
        onDelete={onDeleteApp}
      />

      <Button variant="ghost" size="sm" className="px-1.5" title="新建应用" onClick={onCreate}>
        <PlusIcon className="size-3.5" />
      </Button>

      <div className="ml-auto flex items-center gap-3">
        <ModelPanel model={model} onChanged={onModelChanged} />
        <UsagePanel
          usage={usage}
          stopped={budgetStopped}
          disabled={activeApp === null}
          onSetBudget={onSetBudget}
        />
        <PluginsPanel appId={activeApp?.id ?? null} />
        <StreamDot state={stream} />
        <Button
          variant="outline"
          size="sm"
          disabled={activeApp === null}
          title="把这个版本冻结下来并推到备份库"
          onClick={onRelease}
        >
          发布
        </Button>
      </div>
    </header>
  )
}
