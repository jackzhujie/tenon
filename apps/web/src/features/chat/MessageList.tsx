import { useEffect, useRef, useState } from 'react'
import type { MessagePart, NormalizedMessage, TaskGraph } from '@tenon/protocol'
// 只从零依赖子路径拿：主入口会把整张 zod 校验表拖进前端产物
import { formatCost, formatTokens, stripSelectionBlock } from '@tenon/protocol/browser'
import { TextBlock } from '../../components/TextBlock.js'
import { cn } from '../../lib/cn.js'
import { dotClass, roleLabel, statusText, titleOf } from '../../lib/agent-labels.js'
import { groupMessages } from '../../lib/message-groups.js'
import { planDelegations } from '../../lib/delegation.js'
import { buildConversationTrees, rootActivity, type ConversationTree } from '../../lib/task-tree.js'
import {
  describeExploration,
  groupActivities,
  latestHint,
  type Activity,
} from '../../lib/tool-groups.js'
import type { LiveTurn, ToolActivity } from '../../hooks/useWorkspace.js'

/**
 * 工具名 → 中文标签。
 *
 * 没登记的会原样显示（`subagent` 那种看起来像内部标识符的名字，用户读不懂），
 * 所以**新增工具时顺手补一行** —— 界面上出现英文工具名就是这里漏了。
 */
const TOOL_LABEL: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '修改',
  bash: '执行',
  subagent: '派活',
  add_backend: '加后端',
  install_component: '装组件',
  remove_component: '卸组件',
  list_components: '列组件',
  typecheck: '类型检查',
  git_diff: '看改动',
  preview_assert: '验页面',
  preview_screenshot: '看页面',
  preview_click: '点页面',
  preview_open: '开页面',
}

/** 一行摘要：能让人一眼看出这个工具动了哪个文件、跑了什么命令 */
function summarize(activity: Activity): string {
  const args = activity.args ?? {}
  const path = args['path']
  if (typeof path === 'string') return path
  const command = args['command']
  if (typeof command === 'string') return command.split('\n')[0] ?? command
  // 派活：`Explore · 找出前端入口文件` —— 角色比 task 更能说明"派给了谁"
  const role = args['role']
  const task = args['task']
  if (typeof role === 'string' && typeof task === 'string') return `${role} · ${task}`
  // 组件 / 后端那种按 id 操作的
  const id = args['id']
  if (typeof id === 'string') return id
  return ''
}

function Dot({ status }: { status: Activity['status'] }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'running'
          ? 'bg-brand tenon-pulse'
          : status === 'error'
            ? 'bg-bad'
            : 'bg-ok/70',
      )}
    />
  )
}

function ToolCard({ activity, dense = false }: { activity: ToolActivity; dense?: boolean }) {
  const [open, setOpen] = useState(false)
  const label = TOOL_LABEL[activity.name] ?? activity.name
  const summary = summarize(activity)
  const running = activity.status === 'running'
  const hasSpend = activity.spend !== undefined && activity.spend.totalTokens > 0

  return (
    <div
      className={cn(
        // 不填底色：卡片只靠 1px 边框立住。填色一多，整屏就是一片灰块叠灰块。
        'overflow-hidden rounded-lg border',
        dense ? 'border-line-soft/50' : '',
        running ? 'border-brand/30' : 'border-line-soft',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn('flex w-full items-center gap-2 text-left', dense ? 'px-2 py-1' : 'px-3 py-1.5')}
      >
        <Dot status={activity.status} />
        <span className={cn('shrink-0 text-[12px]', running ? 'text-brand-soft' : 'text-muted')}>
          {label}
        </span>
        {summary !== '' && (
          <span className="truncate font-mono text-[11px] text-faint">{summary}</span>
        )}
        {/*
         * 派活花了多少。放在"详情"左边、用弱色：它是解释性信息，不该抢结论的位置。
         * 成本为 0 时不显示（`faux` 不报价，写 `$0` 会被读成"很便宜"）。
         */}
        {hasSpend && (
          <span
            className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-faint"
            title="这一次派活消耗的用量（不是这个角色的累计）"
          >
            {formatTokens(activity.spend!.totalTokens)}
            {activity.spend!.costUsd > 0 ? ` · ${formatCost(activity.spend!.costUsd)}` : ''}
          </span>
        )}
        <span className={cn('shrink-0 text-[10px] text-faint', hasSpend ? 'ml-2' : 'ml-auto')}>
          {open ? '收起' : '详情'}
        </span>
      </button>
      {/*
       * 输出为空时也要给一句 —— 原来这里要求 `activity.output !== ''`，
       * 于是"点了详情什么都没发生"。那正是用户报的"点详情没反应"：
       * 工具还在跑（流式输出没到）时，点开就是一片空白。
       */}
      {open &&
        (activity.output !== '' ? (
          <pre className="max-h-56 overflow-auto border-t border-line-soft bg-[#0a0908] p-3 font-mono text-[11px] leading-[1.65] text-[#bfb6ae]">
            {activity.output}
          </pre>
        ) : (
          <div className="border-t border-line-soft px-3 py-2 text-[11px] text-faint">
            {running ? '还在执行，输出会一段一段出来' : '这次调用没有输出'}
          </div>
        ))}
    </div>
  )
}

/**
 * 一组"探索动作"（v1.2.27）。
 *
 * 收起时只有一行 —— 这是这次改动的全部目的：`cat package.json` / `find src …` /
 * `读取 README.md` 那种连续七八条不该占掉整屏。展开还是逐条原文（复用 ToolCard）。
 */
function ExploreCard({ items }: { items: readonly ToolActivity[] }) {
  const [open, setOpen] = useState(false)
  const running = items.some((item) => item.status === 'running')
  const hint = latestHint(items)

  return (
    <div className="overflow-hidden rounded-lg border border-line-soft">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <Dot status={running ? 'running' : 'ok'} />
        <span className={cn('shrink-0 text-[12px]', running ? 'text-brand-soft' : 'text-muted')}>
          查看代码
        </span>
        <span className="shrink-0 text-[11px] text-faint">{describeExploration(items)}</span>
        {!open && hint !== '' && (
          <span className="truncate font-mono text-[10.5px] text-faint/70">{hint}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-line-soft/60 p-1.5">
          {items.map((item) => (
            <ToolCard key={item.toolCallId} activity={item} dense />
          ))}
        </div>
      )}
    </div>
  )
}

/** 子会话的步骤行（运行中的派活卡与孤儿树共用同一套渲染） */
function TreeRows({ rows }: { rows: ConversationTree['rows'] }) {
  return (
    <div className="space-y-0.5 border-t border-brand/15 px-2 py-1">
      {rows.map((row) => (
        <div
          key={row.node.id}
          className="flex items-center gap-1.5 text-[11px] leading-5"
          style={{ paddingLeft: 4 + row.depth * 14 }}
        >
          <span className={cn('size-1.5 shrink-0 rounded-full', dotClass(row.node.status))} />
          {/*
           * 子会话自己的 generation 节点跟卡片标题是同一个人（都是 Explore），
           * 再写一遍只是噪声 —— 那种节点只显示它在哪个阶段。
           */}
          {row.node.kind !== 'generation' || row.node.scope !== 'delegated' ? (
            <span className="shrink-0 text-muted">{titleOf(row.node)}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-faint">{statusText(row.node)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 一次派活（v1.2.29）。
 *
 * **同一张卡片两个状态**：跑的时候展开着给你看步骤（树来自任务图），
 * 跑完之后收起、留一行"花了多少 · 子会话几号"，点开是子 Agent 的结论。
 *
 * 为什么要留痕：任务图在 pi 静止时会被回收，所以"刚才派过活"这件事本来只剩
 * 一句"派了 Explore · 3.2k"，点开是空的（那不是结论，是子 Agent 的原始输出）。
 * 用户的原话"完全看不出父子 Agent"说的不是跑的那一刻，而是**回头再看的时候**。
 *
 * 为什么标题用品牌色：它跟普通工具不是一回事 —— 这条下面是另一个 Agent 干的活。
 */
function DelegationCard({
  activity,
  tree,
}: {
  activity: ToolActivity
  /** 运行中的那棵树（跑完后 pi 会回收，所以这里通常是空） */
  tree?: ConversationTree
}) {
  const role = typeof activity.args?.['role'] === 'string' ? activity.args['role'] : null
  const task = typeof activity.args?.['task'] === 'string' ? activity.args['task'] : ''
  const running = activity.status === 'running' || tree?.active === true
  /*
   * 默认展开只看"是否还在跑"：跑的时候用户在等，步骤是唯一能看的东西；
   * 跑完收起来 —— 历史里几张展开的子 Agent 结论会把对话淹掉。
   * 用户点过一次就听用户的（`manual`），不因为状态变化再抢回来。
   */
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? running
  const hasSpend = activity.spend !== undefined && activity.spend.totalTokens > 0
  /* 会话 id 去掉可能的前缀，只留能对上号的部分 */
  const conversation = activity.childConversationId?.replace(/^conv_?/i, '') ?? null

  return (
    /*
     * 派活卡**不填底色**，只留品牌色边框 —— 它要跟普通工具行区分开的是"这是另一个 Agent"，
     * 靠标题颜色和边框就够了；再加一层底色，满宽之后会变成一条很重的色带。
     */
    <div className="overflow-hidden rounded-lg border border-brand/25">
      <button
        type="button"
        onClick={() => setManual((value) => !(value ?? open))}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            activity.status === 'error' ? 'bg-bad' : running ? 'bg-brand tenon-pulse' : 'bg-ok/70',
          )}
        />
        <span className="shrink-0 text-[12px] text-brand-soft">{roleLabel(role) ?? '子 Agent'}</span>
        {task !== '' && <span className="truncate text-[11px] text-faint">{task}</span>}
        {/* 跑完要知道"结束得干不干净"，所以状态词比步数重要 */}
        <span
          className={cn(
            'ml-auto shrink-0 text-[10px]',
            activity.status === 'error' ? 'text-bad' : running ? 'text-brand-soft' : 'text-faint',
          )}
        >
          {activity.status === 'error' ? '失败' : running ? '运行中' : '已结束'}
        </span>
        {hasSpend && (
          <span
            className="shrink-0 font-mono text-[10px] tabular-nums text-faint"
            title="这一次派活消耗的用量（不是这个角色的累计）"
          >
            {formatTokens(activity.spend!.totalTokens)}
            {activity.spend!.costUsd > 0 ? ` · ${formatCost(activity.spend!.costUsd)}` : ''}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-faint">{open ? '收起' : '展开'}</span>
      </button>

      {open &&
        (tree !== undefined ? (
          <TreeRows rows={tree.rows} />
        ) : (
          <div className="border-t border-brand/15">
            {activity.output !== '' ? (
              <div className="max-h-72 overflow-auto px-3 py-2 text-[12.5px] leading-[1.7] text-ink/90">
                <TextBlock text={activity.output} />
              </div>
            ) : (
              <div className="px-3 py-2 text-[11px] text-faint">
                {running ? '还在跑，步骤会一段一段出来' : '这次派活没有留下结论'}
              </div>
            )}
            {/*
             * 留痕的"物证"：会话 id。将来点开去翻它的完整记录就靠这个。
             * 放页脚而不是标题 —— 它是核对用的，不是每次都要读的。
             */}
            {conversation !== null && (
              <div className="border-t border-brand/10 px-3 py-1 font-mono text-[10px] text-faint/80">
                子会话 #{conversation}
              </div>
            )}
          </div>
        ))}
    </div>
  )
}

/**
 * 一张**找不到派活卡片**的树（v1.2.27，v1.2.29 起只做兜底）。
 *
 * 什么情况下会出现：历史被截断、会话恢复后图里有节点但对不上消息。
 * 宁可多显示一块，也不能让它凭空消失 —— 那会让用户以为"没派过活"。
 */
function SubagentCard({
  role,
  rows,
  active,
}: {
  role: string | null
  rows: ConversationTree['rows']
  active: boolean
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className="overflow-hidden rounded-lg border border-brand/25">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', active ? 'bg-brand tenon-pulse' : 'bg-ok/70')} />
        <span className="shrink-0 text-[12px] text-brand-soft">{roleLabel(role) ?? '子 Agent'}</span>
        <span className="shrink-0 text-[10.5px] text-faint">{rows.length} 步</span>
        <span className="ml-auto shrink-0 text-[10px] text-faint">{open ? '收起' : '展开'}</span>
      </button>
      {open && <TreeRows rows={rows} />}
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
    ...(part.spend === undefined ? {} : { spend: part.spend }),
    ...(part.childConversationId === undefined
      ? {}
      : { childConversationId: part.childConversationId }),
  }
}

/**
 * 把一串工具调用渲染成"探索组 + 单条"交替的形状（历史与实时共用）。
 *
 * `subagent` 走自己的卡片：它下面挂的是**另一个 Agent 干的活**，
 * 和"读了个文件"不是一回事（`DelegationCard` 里解释了为什么）。
 */
function Activities({
  activities,
  treeOf,
}: {
  activities: readonly ToolActivity[]
  /** toolCallId → 子会话的步骤树（只有正在跑的那张才有：跑完 pi 会回收节点） */
  treeOf?: (toolCallId: string) => ConversationTree | undefined
}) {
  const entries = groupActivities(activities)
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'explore') {
          return <ExploreCard key={`explore-${entry.items[0]?.toolCallId ?? ''}`} items={entry.items} />
        }
        const activity = entry.activity
        if (activity.name !== 'subagent') {
          return <ToolCard key={activity.toolCallId} activity={activity} />
        }
        const tree = treeOf?.(activity.toolCallId)
        return (
          <DelegationCard
            key={activity.toolCallId}
            activity={activity}
            {...(tree === undefined ? {} : { tree })}
          />
        )
      })}
    </>
  )
}

/**
 * `withSelection` 只在**用户消息**上为 true。
 *
 * 服务端会把点选上下文拼在正文第一行发给 Agent（`[TENON-SELECTION] {...}`），
 * 这行是给模型看的，不该出现在用户气泡里 —— 但界面上要让用户知道"这一轮带了什么"，
 * 所以 Composer 顶部的 chip 才是那件事的呈现方式（发送后清空，历史里靠气泡上的 chip）。
 */
function Parts({
  parts,
  withSelection = false,
  treeOf,
}: {
  parts: MessagePart[]
  withSelection?: boolean
  treeOf?: (toolCallId: string) => ConversationTree | undefined
}) {
  /*
   * 相邻的工具 part 要先收集再编组：`read → read → bash(只读)` 是一条连续探索，
   * 中间夹一段文字才算断开（文字是结论，两边的探索不该被并到一起）。
   */
  const chunks: Array<
    { kind: 'text'; text: string } | { kind: 'tool'; activity: ToolActivity } | { kind: 'other'; part: MessagePart }
  > = []
  for (const part of parts) {
    if (part.type === 'text') {
      const text = withSelection ? stripSelectionBlock(part.text) : part.text
      if (text !== '') chunks.push({ kind: 'text', text })
      continue
    }
    if (part.type === 'tool') {
      chunks.push({ kind: 'tool', activity: partToActivity(part) })
      continue
    }
    chunks.push({ kind: 'other', part })
  }

  const rendered: React.ReactNode[] = []
  let buffer: ToolActivity[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    rendered.push(
      <Activities
        key={`tools-${buffer[0]?.toolCallId ?? String(rendered.length)}`}
        activities={buffer}
        {...(treeOf === undefined ? {} : { treeOf })}
      />,
    )
    buffer = []
  }

  chunks.forEach((chunk, index) => {
    if (chunk.kind === 'tool') {
      buffer.push(chunk.activity)
      return
    }
    flush()
    if (chunk.kind === 'text') {
      rendered.push(<TextBlock key={`text-${index}`} text={chunk.text} />)
      return
    }
    const part = chunk.part
    if (part.type === 'error') {
      rendered.push(
        <div
          key={`error-${index}`}
          className="rounded-lg border border-bad/30 bg-[#241413] px-3 py-2 text-[12px] text-bad"
        >
          {part.message}
          {part.file !== undefined && (
            <span className="ml-2 font-mono text-[11px] text-bad/70">{part.file}</span>
          )}
        </div>,
      )
    } else if (part.type === 'file') {
      rendered.push(
        <div key={`file-${index}`} className="font-mono text-[11px] text-faint">
          📄 {part.path}
        </div>,
      )
    }
  })
  flush()

  return <div className="flex flex-col gap-1.5">{rendered}</div>
}

function Bubble({
  message,
  treeOf,
}: {
  message: NormalizedMessage
  treeOf?: (toolCallId: string) => ConversationTree | undefined
}) {
  const isUser = message.role === 'user'
  return (
    <div className={cn('tenon-rise flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'text-[13.5px] leading-[1.75]',
          /*
           * 助手消息**不画气泡**：正文直接铺在面板上、与工具行同宽（满宽）。
           * 满宽再套一层灰底就成了"整列灰墙"，所以这里刻意没有 bg / ring / padding。
           * 用户消息反过来 —— 那是唯一需要"我发的"这个视觉标记的东西，留着气泡。
           */
          isUser
            ? 'max-w-[92%] rounded-xl bg-brand-dim/80 px-3.5 py-2.5 text-[#f4e7de] ring-1 ring-brand/20'
            : 'w-full text-ink',
        )}
      >
        <Parts
          parts={message.parts}
          withSelection={isUser}
          {...(treeOf === undefined ? {} : { treeOf })}
        />
      </div>
    </div>
  )
}

function LiveBubble({
  live,
  graph,
  treeOf,
  children,
}: {
  live: LiveTurn
  graph: TaskGraph | null
  treeOf?: (toolCallId: string) => ConversationTree | undefined
  /** 子 Agent 的树插在"工具"与"正文"之间 —— 它是这一步正在发生的事 */
  children?: React.ReactNode
}) {
  const activity = rootActivity(graph)

  return (
    <div className="flex justify-start">
      <div className="w-full space-y-1.5">
        {/* 工具卡片与探索组：和历史上的同一条渲染路径，避免"跑的时候一堆、跑完变一行" */}
        {live.tools.length > 0 && (
          <Activities activities={live.tools} {...(treeOf === undefined ? {} : { treeOf })} />
        )}

        {children}

        {live.text === '' ? (
          /*
           * 还没出正文时只给一行状态，**不画气泡**：一个空的圆角块看着像"答了一半"，
           * 而这一刻其实是"它还在动"。面板拆掉之后，"现在在干什么"就落在这里。
           */
          <div className="flex items-center gap-2 text-[11.5px] text-faint">
            <span className="size-1.5 rounded-full bg-brand tenon-pulse" />
            {activity ?? '思考中…'}
          </div>
        ) : (
          <div className="text-[13.5px] leading-[1.75] text-ink">
            <TextBlock text={live.text} />
            <span className="tenon-caret" />
          </div>
        )}
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
  graph = null,
  empty,
}: {
  messages: NormalizedMessage[]
  live: LiveTurn | null
  /** 任务图：只用来在实时气泡里画出子 Agent 的层级（它只描述"现在"） */
  graph?: TaskGraph | null
  empty: React.ReactNode
}) {
  const ref = useStickToBottom([messages, live, graph])
  const isEmpty = messages.length === 0 && live === null
  /*
   * ★ 跨消息合并：pi 的历史里**每个工具调用是独立的一条 assistant 消息**，
   * 所以合并必须发生在消息层，不是 `parts` 层（第一版就在这里错了，界面一条没少）。
   */
  /*
   * 实时里正挂着的工具，历史里会**再来一份**：pi 先落一条"工具调用"的 assistant 消息，
   * 结果要等工具跑完。于是同一个 toolCallId 同时出现在 `live.tools` 与历史消息里，
   * 界面上就是两张一模一样的卡片（子 Agent 那种要跑好几秒的尤其显眼）。
   * 以实时那份为准 —— 它有最新状态。
   */
  const liveIds = new Set((live?.tools ?? []).map((tool) => tool.toolCallId))
  const items = groupMessages(messages, partToActivity)
    .map((item) =>
      item.kind === 'tools'
        ? { ...item, activities: item.activities.filter((tool) => !liveIds.has(tool.toolCallId)) }
        : item,
    )
    .filter((item) => item.kind !== 'tools' || item.activities.length > 0)
  /*
   * 子 Agent 的树**不挂在 live 上**：子会话在跑的那几秒里，实时气泡可能已经被
   * 上一条工具结果消息清掉了（`message.end` 先到），于是"树明明存在却看不见"。
   * 图里有东西就渲染 —— 它描述的是"现在"，与气泡在不在无关。
   */
  const trees = buildConversationTrees(graph)
  /*
   * 派活卡片 ↔ 子会话树：两条数据线（卡片来自工具调用，树来自任务图）要配到一起，
   * 否则运行中是"一条派活行 + 一张来源不明的树"，跑完又只剩一句话。
   * 配对规则在 `lib/delegation.ts` 里（含并行派活不串的用例）。
   */
  const plan = planDelegations(
    [
      ...items.flatMap((item) => (item.kind === 'tools' ? item.activities : [])),
      ...(live?.tools ?? []),
    ],
    trees,
  )
  const treeOf = (toolCallId: string): ConversationTree | undefined =>
    plan.byToolCall.get(toolCallId)

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
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {isEmpty ? empty : null}
        {items.map((item) =>
          item.kind === 'tools' ? (
            /*
             * 工具行与正文**同宽（满宽）**。曾经这里靠 flex 冒充满宽、气泡却是 `max-w-[92%]`，
             * 一屏里"文字块窄、卡片宽"来回切，右边缘全是参差（844px 下差 61px）。
             * 现在两边都满宽，左边对齐、右边也齐。
             */
            <div key={item.key} className="flex w-full flex-col gap-1.5">
              <Activities activities={item.activities} treeOf={treeOf} />
            </div>
          ) : (
            <Bubble key={item.key} message={item.message} treeOf={treeOf} />
          ),
        )}
        {live !== null ? (
          <LiveBubble live={live} graph={graph} treeOf={treeOf}>
            {plan.orphans.map((tree) => (
              <SubagentCard
                key={tree.conversationId}
                role={tree.role}
                rows={tree.rows}
                active={tree.active}
              />
            ))}
          </LiveBubble>
        ) : (
          /* 气泡没了但树还在（子会话比正文活得久）：单独铺一次，别让它消失 */
          plan.orphans.length > 0 && (
            <div className="w-full space-y-1.5">
              {plan.orphans.map((tree) => (
                <SubagentCard
                  key={tree.conversationId}
                  role={tree.role}
                  rows={tree.rows}
                  active={tree.active}
                />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
