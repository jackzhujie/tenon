import type { App, AppStatus, GitCommit, NormalizedMessage, SelectionContext } from '@tenon/protocol'
import { Composer } from './Composer.js'
import { MessageList } from './MessageList.js'
import type { LiveTurn } from '../../hooks/useWorkspace.js'
import type { StreamState } from '../../lib/stream.js'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'

const STATUS_TEXT: Record<AppStatus, string> = {
  idle: '空闲',
  running: '运行中',
  error: '出错',
  archived: '已归档',
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86_400)} 天前`
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-line bg-panel-2 text-lg text-brand">
        榫
      </div>
      <div className="space-y-1.5">
        <p className="text-[13.5px] text-ink">还没有应用</p>
        <p className="max-w-[36ch] text-[12px] leading-relaxed text-faint">
          建一个之后，这里就是对话的地方。Agent 会直接改工作区里的代码，
          每一轮结束自动提交一次 git。
        </p>
      </div>
      <Button variant="primary" onClick={onCreate}>
        新建应用
      </Button>
    </div>
  )
}

function NoAppSelected() {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <p className="text-[12.5px] text-faint">从左上角选择一个应用，或者新建一个。</p>
    </div>
  )
}

export interface ChatPanelProps {
  app: App | null
  status: AppStatus | null
  messages: NormalizedMessage[]
  live: LiveTurn | null
  commits: GitCommit[]
  stream: StreamState
  submitting: boolean
  hasApps: boolean
  selection: SelectionContext | null
  onSend(content: string): void
  onStop(): void
  onCreate(): void
  onClearSelection(): void
}

export function ChatPanel({
  app,
  status,
  messages,
  live,
  commits,
  stream,
  submitting,
  hasApps,
  selection,
  onSend,
  onStop,
  onCreate,
  onClearSelection,
}: ChatPanelProps) {
  if (!hasApps) return <EmptyState onCreate={onCreate} />
  if (app === null) return <NoAppSelected />

  const latest = commits[0]

  return (
    /*
     * `flex-1` 不能省：这个 div 是 `<section class="flex flex-col">` 的 flex 子项，
     * 不给增长就退回内容高度 —— 里面的 `flex-1 overflow-y-auto` 会连带塌成 0，
     * 症状是「消息列表不滚动、也不显示」，但 DOM 里文本明明在。
     */
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-4">
        <span
          className={cn(
            'size-1.5 rounded-full',
            status === 'running' ? 'bg-brand tenon-pulse' : status === 'error' ? 'bg-bad' : 'bg-ok/60',
          )}
        />
        <span className="text-[11.5px] text-muted">
          {status === null ? '准备中' : STATUS_TEXT[status]}
        </span>
        {latest !== undefined && (
          <>
            <span className="text-[11px] text-faint">·</span>
            <span
              className="truncate font-mono text-[10.5px] text-faint"
              title={`${latest.sha.slice(0, 8)} ${latest.message}`}
            >
              {latest.sha.slice(0, 7)} · {relativeTime(latest.at)}
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[10.5px] text-faint">{commits.length} 个版本</span>
      </div>

      <MessageList
        messages={messages}
        live={live}
        empty={
          <div className="mt-10 space-y-2 px-2 text-center">
            <p className="text-[13px] text-muted">工作区已就绪</p>
            <p className="mx-auto max-w-[40ch] text-[12px] leading-relaxed text-faint">
              描述你要的界面，Agent 会读写 <span className="font-mono">repo/</span> 里的文件，
              右侧预览会跟着热更新。
            </p>
          </div>
        }
      />

      <Composer
        disabled={app === null}
        submitting={submitting || status === 'running'}
        stream={stream}
        selection={selection}
        onSend={onSend}
        onStop={onStop}
        onClearSelection={onClearSelection}
      />
    </div>
  )
}
