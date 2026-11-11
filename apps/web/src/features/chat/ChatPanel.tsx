import type {
  App,
  AppStatus,
  GitCommit,
  NormalizedMessage,
  SelectionContext,
  TaskGraph,
} from '@tenon/protocol'
import { Composer, type ComposerPrefill } from './Composer.js'
import { MessageList } from './MessageList.js'
import type { LiveTurn } from '../../hooks/useWorkspace.js'
import type { StreamState } from '../../lib/stream.js'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import { relativeTime } from '../../lib/relative-time.js'
import { useT } from '../../lib/i18n.js'
import type { ChatKey } from '../../lib/messages/chat.js'

const STATUS_KEY: Record<AppStatus, ChatKey> = {
  idle: 'chat.status.idle',
  running: 'chat.status.running',
  error: 'chat.status.error',
  archived: 'chat.status.archived',
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useT()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div
        data-brand="tenon"
        className="flex size-11 items-center justify-center rounded-xl border border-line bg-panel-2 text-lg text-brand"
      >
        {/* i18n-ignore 品牌字，不是文案 */}
        榫
      </div>
      <div className="space-y-1.5">
        <p className="text-[13.5px] text-ink">{t('chat.empty.noApps.title')}</p>
        <p className="max-w-[36ch] text-[12px] leading-relaxed text-faint">
          {t('chat.empty.noApps.body')}
        </p>
      </div>
      <Button variant="primary" onClick={onCreate}>
        {t('chat.empty.noApps.create')}
      </Button>
    </div>
  )
}

function NoAppSelected() {
  const { t } = useT()
  return (
    <div className="flex h-full items-center justify-center px-8 text-center">
      <p className="text-[12.5px] text-faint">{t('chat.empty.pickApp')}</p>
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
  /** 日志面板「发送给 Agent」塞进来的文本，透传给 Composer */
  prefill?: ComposerPrefill | null
  /**
   * 任务图（v1.2.27）。**不再是页面底部那块独立面板** —— 子 Agent 的步骤要显示在
   * 对话里（派它的那一步旁边），所以图从这一路透到消息列表。
   */
  graph?: TaskGraph | null
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
  prefill = null,
  graph = null,
}: ChatPanelProps) {
  // hook 要在 early return 之前调，否则两个分支的 hook 数量不一致
  const { t, locale } = useT()
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
          {status === null ? t('chat.status.preparing') : t(STATUS_KEY[status])}
        </span>
        {latest !== undefined && (
          <>
            <span className="text-[11px] text-faint">·</span>
            <span
              className="truncate font-mono text-[10.5px] text-faint"
              title={`${latest.sha.slice(0, 8)} ${latest.message}`}
            >
              {latest.sha.slice(0, 7)} · {relativeTime(latest.at, { t, locale })}
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[10.5px] text-faint">
          {t('chat.versions', { count: commits.length })}
        </span>
      </div>

      <MessageList
        messages={messages}
        live={live}
        graph={graph}
        empty={
          <div className="mt-10 space-y-2 px-2 text-center">
            <p className="text-[13px] text-muted">{t('chat.ready.title')}</p>
            <p className="mx-auto max-w-[40ch] text-[12px] leading-relaxed text-faint">
              {t('chat.ready.body.before')}
              <span className="font-mono">repo/</span>
              {t('chat.ready.body.after')}
            </p>
          </div>
        }
      />

      <Composer
        prefill={prefill}
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
