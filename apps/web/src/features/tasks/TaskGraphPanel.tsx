/**
 * 任务图面板（M4 第 2 步）。
 *
 * 存在的理由：主 Agent 把活派给子 Agent 之后，界面上只有一张工具卡片 ——
 * 看不见"子会话真的在跑吗、跑到哪一步了、还是卡住了"。这张面板就是那扇窗。
 *
 * 三个刻意的取舍：
 *
 * 1. **空闲时整个面板不渲染**，不占那 28px。它出现本身就是信号（"现在有任务在跑"）。
 *    代价是跑完就消失 —— 这是对的：pi 静止时会回收节点，硬留最后一帧会显示
 *    一批"还在运行"的幽灵任务。要回顾这一轮干了什么，看对话里的工具卡片。
 * 2. **层级用缩进表达，不做图形化。** 一张图最多几个节点，树线画得再花也不如
 *    少 12px 缩进好读；真正要一眼看出的是"子会话挂在谁下面"。
 * 3. **状态说人话。** pi 的 `phase` 是 `prepare` / `request` / `tools` / `call` / `execute`，
 *    直接显示等于让用户读宿主的内部枚举。
 */
import { useState } from 'react'
import type { TaskGraph, TaskGraphNode } from '@tenon/protocol'
import { ChevronDownIcon } from '../../components/icons.js'
import { cn } from '../../lib/cn.js'

/** 角色 id → 展示名。**别从 `@tenon/agent` import**：那是服务端包，会把 pi 打进前端产物 */
const ROLE_LABEL: Record<string, string> = {
  builder: 'Builder',
  explore: 'Explore',
  librarian: 'Librarian',
  codeact: 'CodeAct',
  e2e: 'E2E',
  reviewer: 'Reviewer',
}

function roleLabel(role: string | null): string | null {
  if (role === null) return null
  return ROLE_LABEL[role] ?? role
}

const PHASE_TEXT: Record<string, string> = {
  prepare: '准备上下文',
  request: '等模型',
  tools: '串工具',
  call: '调度工具',
  execute: '执行中',
}

function statusText(node: TaskGraphNode): string {
  switch (node.status) {
    case 'pending':
      return '排队'
    case 'running':
      return PHASE_TEXT[node.phase ?? ''] ?? '运行中'
    case 'waiting':
      return node.waitingOn.length > 0 ? `等 ${node.waitingOn.length} 个子任务` : '等待'
    case 'sleeping':
      return '等重试'
    case 'completing':
      return '收尾'
  }
}

const DOT_CLASS: Record<TaskGraphNode['status'], string> = {
  pending: 'bg-faint',
  running: 'bg-brand',
  waiting: 'bg-warn',
  sleeping: 'bg-warn',
  completing: 'bg-ok',
}

function titleOf(node: TaskGraphNode): string {
  if (node.kind === 'generation') {
    if (node.scope === 'root') return '主对话'
    return roleLabel(node.role) ?? '子 Agent'
  }
  if (node.kind === 'tool') {
    const label = roleLabel(node.role)
    return label === null ? '工具调用' : `派活 ${label}`
  }
  return node.kind
}

/**
 * 缩进层级。
 *
 * 不能直接数 `parentId` 链的长度了事：图是服务端排好序的，但**父节点可能不在这一帧里**
 * （回收是逐个发生的）。所以父找不到就当 0，并且用一个 `seen` 挡住环。
 */
function depthOf(node: TaskGraphNode, byId: Map<string, TaskGraphNode>): number {
  let depth = 0
  let current = node.parentId
  const seen = new Set<string>([node.id])
  while (current !== null) {
    if (seen.has(current)) return depth
    seen.add(current)
    const parent = byId.get(current)
    if (parent === undefined) return depth
    depth += 1
    current = parent.parentId
  }
  return depth
}

/** 收起时那一行说什么：优先"派出去的那个"——它是用户最可能关心的 */
function summaryOf(nodes: readonly TaskGraphNode[]): string {
  const delegated = nodes.find((node) => node.scope === 'delegated' && node.status !== 'completing')
  const running = nodes.find((node) => node.status === 'running')
  const pick = delegated ?? running ?? nodes[0]
  return pick === undefined ? '' : `${titleOf(pick)} ${statusText(pick)}`
}

export interface TaskGraphPanelProps {
  graph: TaskGraph
}

export function TaskGraphPanel({ graph }: TaskGraphPanelProps) {
  const [open, setOpen] = useState(false)
  if (graph.nodes.length === 0) return null

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const delegatedCount = graph.nodes.filter((node) => node.scope === 'delegated').length

  return (
    <div className="flex shrink-0 flex-col border-t border-line-soft bg-panel/40">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1.5 text-[11.5px] text-muted hover:text-ink"
          title={open ? '收起任务图' : '展开任务图'}
        >
          <ChevronDownIcon className={cn('size-3 transition-transform', open ? 'rotate-0' : '-rotate-90')} />
          任务
        </button>

        <span className="rounded-full bg-panel-2 px-1.5 py-px text-[10px] leading-4 tabular-nums text-muted">
          {graph.nodes.length}
        </span>

        {delegatedCount > 0 && (
          <span
            className="rounded-full bg-brand/15 px-1.5 py-px text-[10px] leading-4 text-brand-soft"
            title={`${delegatedCount} 个子会话在跑`}
          >
            {delegatedCount} 个子会话
          </span>
        )}

        {!open && (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">{summaryOf(graph.nodes)}</span>
        )}
      </div>

      {open && (
        <div className="max-h-40 overflow-y-auto border-t border-line-soft/70 py-1">
          {graph.nodes.map((node) => (
            <div
              key={node.id}
              className="flex items-center gap-2 pr-3 text-[11px] leading-5"
              style={{ paddingLeft: 12 + depthOf(node, byId) * 14 }}
            >
              <span className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[node.status])} />
              <span
                className={cn(
                  'shrink-0',
                  node.scope === 'delegated' ? 'text-brand-soft' : 'text-muted',
                )}
              >
                {titleOf(node)}
              </span>
              <span className="min-w-0 flex-1 truncate text-faint">{statusText(node)}</span>
              {node.spawned.length > 0 && (
                <span className="shrink-0 font-mono text-[10px] text-faint" title="派出去的子会话">
                  派 {node.spawned.map((id) => `#${id}`).join(' ')}
                </span>
              )}
              {/* 只有子会话的编号有信息量：主对话永远是根会话那个号，写出来只是噪声 */}
              {node.scope === 'delegated' && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint/70">
                  #{node.conversationId}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
