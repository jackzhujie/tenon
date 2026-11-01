import { useEffect, useRef, useState } from 'react'
import type { MessagePart, NormalizedMessage } from '@tenon/protocol'
// 只从零依赖子路径拿：主入口会把整张 zod 校验表拖进前端产物
import { stripSelectionBlock } from '@tenon/protocol/browser'
import { TextBlock } from '../../components/TextBlock.js'
import { cn } from '../../lib/cn.js'
import type { LiveTurn, ToolActivity } from '../../hooks/useWorkspace.js'

const TOOL_LABEL: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '修改',
  bash: '执行',
}

/** 一行摘要：能让人一眼看出这个工具动了哪个文件、跑了什么命令 */
function summarize(activity: ToolActivity): string {
  const args = activity.args ?? {}
  const path = args['path']
  if (typeof path === 'string') return path
  const command = args['command']
  if (typeof command === 'string') return command.split('\n')[0] ?? command
  return ''
}

function ToolCard({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false)
  const label = TOOL_LABEL[activity.name] ?? activity.name
  const summary = summarize(activity)
  const running = activity.status === 'running'

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-panel-2/70',
        running ? 'border-brand/30' : 'border-line-soft',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            running ? 'bg-brand tenon-pulse' : activity.status === 'error' ? 'bg-bad' : 'bg-ok/70',
          )}
        />
        <span className={cn('shrink-0 text-[12px]', running ? 'text-brand-soft' : 'text-muted')}>
          {label}
        </span>
        {summary !== '' && (
          <span className="truncate font-mono text-[11px] text-faint">{summary}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-faint">{open ? '收起' : '详情'}</span>
      </button>
      {open && activity.output !== '' && (
        <pre className="max-h-56 overflow-auto border-t border-line-soft bg-[#0a0908] p-3 font-mono text-[11px] leading-[1.65] text-[#bfb6ae]">
          {activity.output}
        </pre>
      )}
    </div>
  )
}

function partToActivity(part: Extract<MessagePart, { type: 'tool' }>): ToolActivity {
  return {
    toolCallId: part.toolCallId,
    name: part.name,
    args: part.args,
    output: part.output ?? '',
    status: part.status,
  }
}

/**
 * `withSelection` 只在**用户消息**上为 true。
 *
 * 服务端会把点选上下文拼在正文第一行发给 Agent（`[TENON-SELECTION] {...}`），
 * 这行是给模型看的，不该出现在用户气泡里 —— 但界面上要让用户知道"这一轮带了什么"，
 * 所以 Composer 顶部的 chip 才是那件事的呈现方式（发送后清空，历史里靠气泡上的 chip）。
 */
function Parts({ parts, withSelection = false }: { parts: MessagePart[]; withSelection?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      {parts.map((part, index) => {
        if (part.type === 'text') {
          const text = withSelection ? stripSelectionBlock(part.text) : part.text
          return text === '' ? null : <TextBlock key={index} text={text} />
        }
        if (part.type === 'tool') return <ToolCard key={part.toolCallId} activity={partToActivity(part)} />
        if (part.type === 'error') {
          return (
            <div
              key={index}
              className="rounded-lg border border-bad/30 bg-[#241413] px-3 py-2 text-[12px] text-bad"
            >
              {part.message}
              {part.file !== undefined && (
                <span className="ml-2 font-mono text-[11px] text-bad/70">{part.file}</span>
              )}
            </div>
          )
        }
        if (part.type === 'file') {
          return (
            <div key={index} className="font-mono text-[11px] text-faint">
              📄 {part.path}
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function Bubble({ message }: { message: NormalizedMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={cn('tenon-rise flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[92%] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-[1.75]',
          isUser
            ? 'bg-brand-dim/80 text-[#f4e7de] ring-1 ring-brand/20'
            : 'bg-panel-2 text-ink ring-1 ring-line-soft',
        )}
      >
        <Parts parts={message.parts} withSelection={isUser} />
      </div>
    </div>
  )
}

function LiveBubble({ live }: { live: LiveTurn }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-1.5">
        {live.tools.map((activity) => (
          <ToolCard key={activity.toolCallId} activity={activity} />
        ))}
        <div className="rounded-xl bg-panel-2 px-3.5 py-2.5 text-[13.5px] leading-[1.75] text-ink ring-1 ring-line-soft">
          {live.text === '' ? (
            <span className="text-faint">思考中…</span>
          ) : (
            <>
              <TextBlock text={live.text} />
              <span className="tenon-caret" />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 贴底滚动：只有用户本来就在底部时才跟着滚，别抢走他正在往上翻的阅读位置 */
function useStickToBottom(deps: readonly unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const onScroll = (): void => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      stick.current = distance < 64
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const node = ref.current
    if (node === null || !stick.current) return
    node.scrollTop = node.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}

export function MessageList({
  messages,
  live,
  empty,
}: {
  messages: NormalizedMessage[]
  live: LiveTurn | null
  empty: React.ReactNode
}) {
  const ref = useStickToBottom([messages, live])
  const isEmpty = messages.length === 0 && live === null

  return (
    /*
     * 空态要**垂直居中**：消息列表是个撑满高度的滚动区，什么都不写的话
     * 「工作区已就绪」会贴在顶部，看起来像一条被截断的消息而不是引导文案。
     */
    <div
      ref={ref}
      className={cn(
        'min-h-0 flex-1 overflow-y-auto px-4 py-4',
        isEmpty && 'flex flex-col justify-center',
      )}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {isEmpty ? empty : null}
        {messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {live !== null && <LiveBubble live={live} />}
      </div>
    </div>
  )
}
