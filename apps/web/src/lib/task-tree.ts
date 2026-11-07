/**
 * 把任务图整理成"主子层级"（v1.2.27）。
 *
 * 原来的做法是在日志上方单独一条「任务」面板。问题不是信息不够，而是**位置错了**：
 * 用户看的是左边的对话流，"它现在在干什么"却要往另一个控件里瞟一眼。
 * trae / Claude Code 的做法是把子 Agent 的步骤直接折在派它的那一步下面 —— 这里照做。
 *
 * 三个必须接受的现实：
 *
 * 1. **这张图只描述"现在"。** pi 静止时会回收节点，所以跑完再查是空数组。
 *    因此层级只在**跑的时候**存在；跑完只剩对话里那张"派了 Explore · 12.3k"的卡片。
 *    这不是缺陷，是宿主的设计 —— 别指望拿它当"派活历史"。
 * 2. **分组键是会话 id，不是 toolCallId。** 图里没有 toolCallId，所以这里按
 *    `conversationId` 分组：一个子会话 = 一张卡片。跟"第几个 subagent 工具调用"无关，
 *    并行派两个也不会串。
 * 3. **深度要在会话内部重算。** 图里的 `parentId` 会指到父会话里的工具任务（那是对话
 *    这一侧的节点）。如果直接用它算缩进，子会话的第一层会被缩两层。所以只沿着
 *    "父节点也在同一会话里"的链往上数。
 */
import type { TaskGraph, TaskGraphNode } from '@tenon/protocol'

export interface TreeRow {
  readonly node: TaskGraphNode
  /** 相对**本会话**的缩进层级（0 起） */
  readonly depth: number
}

export interface ConversationTree {
  readonly conversationId: string
  /** 派给谁（`explore` / `librarian` …）。图里查不到就是 null */
  readonly role: string | null
  readonly rows: readonly TreeRow[]
  /** 还有节点在动（跑 / 排队 / 等重试 / 等子任务） */
  readonly active: boolean
}

const ACTIVE: ReadonlySet<TaskGraphNode['status']> = new Set(['pending', 'running', 'waiting', 'sleeping'])

/** 同一会话内的相对深度。父节点不在本会话就停 —— 否则子会话会被父会话的深度带偏 */
function depthWithin(node: TaskGraphNode, byId: Map<string, TaskGraphNode>): number {
  let depth = 0
  let current = node.parentId
  const seen = new Set<string>([node.id])
  while (current !== null) {
    if (seen.has(current)) return depth
    seen.add(current)
    const parent = byId.get(current)
    if (parent === undefined || parent.conversationId !== node.conversationId) return depth
    depth += 1
    current = parent.parentId
  }
  return depth
}

/**
 * 每个活跃子会话一张树。按"第一个节点在父数组里的顺序"排 ——
 * 图本身是深度优先压平的，所以这个顺序就等于"派活的先后"。
 */
export function buildConversationTrees(graph: TaskGraph | null): ConversationTree[] {
  if (graph === null || graph.nodes.length === 0) return []
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  const groups = new Map<string, TaskGraphNode[]>()
  for (const node of graph.nodes) {
    if (node.scope !== 'delegated') continue
    const list = groups.get(node.conversationId)
    if (list === undefined) groups.set(node.conversationId, [node])
    else list.push(node)
  }

  const trees: ConversationTree[] = []
  for (const [conversationId, nodes] of groups) {
    const rows = nodes.map((node) => ({ node, depth: depthWithin(node, byId) }))
    // 角色在子会话的节点上是继承来的（`normalizeTaskGraph` 会从派它的工具任务上抄一份）
    const role = nodes.find((node) => node.role !== null)?.role ?? null
    trees.push({
      conversationId,
      role,
      rows,
      active: nodes.some((node) => ACTIVE.has(node.status)),
    })
  }
  return trees
}

/**
 * 主对话自己现在在干什么（一句话）。
 *
 * 子 Agent 的步骤有卡片可挂，主对话的没有 —— 原来那行"主对话 · 等模型"在面板里，
 * 面板拆掉之后这句话要有个去处：放进实时气泡（它正是"此刻"的位置）。
 */
export function rootActivity(graph: TaskGraph | null): string | null {
  if (graph === null) return null
  const root = graph.nodes.find(
    (node) => node.scope === 'root' && node.kind === 'generation' && ACTIVE.has(node.status),
  )
  if (root === undefined) return null
  switch (root.phase) {
    case 'prepare':
      return '整理上下文'
    case 'request':
      return '等模型回复'
    case 'tools':
      return '还在串工具'
    case 'call':
      return '调度工具'
    case 'execute':
      return '执行中'
    default:
      return null
  }
}
