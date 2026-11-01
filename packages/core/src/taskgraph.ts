/**
 * 任务图归一化（M4 任务图面板，DESIGN §5.5）。
 *
 * pi 的 `TaskGraph` 是"宿主视角"的：一份 `Record<taskId, TaskGraphNode>`，
 * 里面有任务树（`owner`）、细阶段（`phase`）、等待关系（`on`）、以及**这个 task 拥有哪些会话**
 * （`conversations`）。前端要的是"人视角"的：谁在跑、跑在哪、谁派的。
 *
 * 所以这里做三件事，每件都有个具体的坑：
 *
 * 1. **会话树 ≠ 任务树。** 子会话里的 generation task 在 pi 眼里 `owner` 是空的
 *    （它是会话自己的任务），但用户看到的是"那个 subagent 工具跑出来的"。
 *    所以 `parentId` 优先用 `owner`，没有就退回"派生出这个会话的工具 task"。
 *
 * 2. **角色不在图里。** pi 只知道 `pi.tool`，不知道这个工具是 `subagent` 还是 `bash`。
 *    角色要从工具 task 的 `checkpoint.arguments.role` 取（服务端查一次，塞进 `roles`），
 *    再**继承给子会话**——`spawned` 里那个会话 id 就是派出去的子 Agent。
 *
 * 3. **静止时节点被回收。** 这里返回空数组不是 bug：跑完就没了。别拿它当派活历史。
 */
import type { TaskGraph, TaskGraphNode } from '@tenon/protocol'

/** pi 的 `TaskGraphState`（宽一点：宿主升级加了 status 也不该炸） */
export interface RawTaskState {
  readonly status: TaskGraphNode['status']
  readonly phase?: string
  readonly on?: readonly (string | number)[]
  readonly outcome?: string
}

/** pi 的 `TaskGraphNode`。id 一律用 `String()` 收口：宿主可能给 number 也可能是 branded */
export interface RawTaskNode {
  readonly id: string | number
  readonly kind: string
  readonly conversationId: string | number
  readonly owner?: string | number
  readonly background: boolean
  readonly state: RawTaskState
  readonly conversations: readonly (string | number)[]
}

export interface RawTaskGraph {
  readonly tasks: Readonly<Record<string, RawTaskNode>>
}

export interface NormalizeOptions {
  rootConversationId: string
  /** task id → 角色 id（服务端从 `checkpoint.arguments.role` 取出来的） */
  roles?: Readonly<Record<string, string>>
}

/** 宿主的 kind 带 `pi.` 前缀；前端不该知道宿主的命名空间 */
export function stripKind(kind: string): string {
  return kind.startsWith('pi.') ? kind.slice(3) : kind
}

/**
 * 哪些 task 值得为它查一次 `getTask()`。
 *
 * 判据是「工具 task 且已经拥有会话」：那正是 `subagent` 派活成立的瞬间
 * （`createConversation` 之后再 submit）。只在这个窗口里查，一轮对话大约 1 次，
 * 而不是对每个节点盲查 —— 那会让每一帧都多 N 次数据库读。
 */
export function tasksNeedingRole(graph: RawTaskGraph): string[] {
  const ids: string[] = []
  for (const [id, node] of Object.entries(graph.tasks)) {
    if (stripKind(node.kind) !== 'tool') continue
    if (node.conversations.length === 0) continue
    ids.push(id)
  }
  return ids
}

/** 十进制 id 按数值排，非十进制按字典序；混在一起时数值优先 */
function compareId(a: string, b: string): number {
  const left = Number(a)
  const right = Number(b)
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right
  if (Number.isFinite(left)) return -1
  if (Number.isFinite(right)) return 1
  return a.localeCompare(b)
}

export function normalizeTaskGraph(graph: RawTaskGraph, options: NormalizeOptions): TaskGraph {
  const roles = options.roles ?? {}

  // 会话 → 派生出它的工具 task。一个会话只会有一个派生者（createConversation 只调一次）
  const spawnedBy = new Map<string, string>()
  for (const [id, node] of Object.entries(graph.tasks)) {
    for (const conversationId of node.conversations) {
      const key = String(conversationId)
      if (!spawnedBy.has(key)) spawnedBy.set(key, id)
    }
  }

  const nodes: TaskGraphNode[] = []
  for (const [id, node] of Object.entries(graph.tasks)) {
    const conversationId = String(node.conversationId)
    const ownerId = node.owner === undefined ? null : String(node.owner)
    const delegator = spawnedBy.get(conversationId) ?? null
    const scope = conversationId === options.rootConversationId ? 'root' : 'delegated'
    // 自己拥有自己是畸形数据（不该出现），但真出现时不能让它成为自己的父 ——
    // 那会让 UI 的"缩进一层"变成无穷递归，也让节点永远找不到根
    const selfOwned = ownerId === id
    const parentId = selfOwned ? null : (ownerId ?? (delegator === id ? null : delegator))

    nodes.push({
      id,
      kind: stripKind(node.kind),
      conversationId,
      scope,
      ownerId,
      parentId,
      status: node.state.status,
      phase: node.state.phase ?? null,
      waitingOn: (node.state.on ?? []).map(String),
      spawned: node.conversations.map(String),
      role: roles[id] ?? null,
    })
  }

  // 角色继承：子会话里的 generation task 自己没有 args，角色在派它的工具 task 上
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.role !== null || node.scope !== 'delegated') continue
    const delegator = spawnedBy.get(node.conversationId)
    node.role = delegator === undefined ? null : (byId.get(delegator)?.role ?? null)
  }

  return {
    rootConversationId: options.rootConversationId,
    nodes: sortByTree(nodes),
  }
}

/**
 * 深度优先压平成一维列表，父在子前 —— UI 直接按顺序渲染 + 缩进就是一棵树。
 *
 * 为什么要自己排：`Record` 的键顺序在 JS 里是"整数键升序"，看着像有序，
 * 但**子节点可能出现在父节点之前**（id 小不代表先被创建，回收后 id 会复用）。
 */
function sortByTree(nodes: readonly TaskGraphNode[]): TaskGraphNode[] {
  const children = new Map<string, TaskGraphNode[]>()
  const roots: TaskGraphNode[] = []
  const known = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    if (node.parentId === null || !known.has(node.parentId)) {
      roots.push(node)
      continue
    }
    const bucket = children.get(node.parentId) ?? []
    bucket.push(node)
    children.set(node.parentId, bucket)
  }
  roots.sort((a, b) => compareId(a.id, b.id))
  for (const bucket of children.values()) bucket.sort((a, b) => compareId(a.id, b.id))

  const ordered: TaskGraphNode[] = []
  const seen = new Set<string>()
  const walk = (node: TaskGraphNode): void => {
    // 环（理论上不会有）会让递归停不下来；见过就跳过
    if (seen.has(node.id)) return
    seen.add(node.id)
    ordered.push(node)
    for (const child of children.get(node.id) ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  // 落在环里的节点没有根可循，追加在末尾而不是丢掉
  for (const node of nodes) if (!seen.has(node.id)) walk(node)
  return ordered
}
