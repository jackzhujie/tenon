/**
 * 把"派活卡片"和"子会话的步骤树"配到一起（v1.2.29）。
 *
 * 为什么需要配对：这两样东西来自**两条不同的数据线**——
 * - 卡片来自工具调用（`subagent` 的 tool part），落定后才带 `childConversationId`
 * - 树来自任务图（`buildConversationTrees`），只在**跑的时候**存在
 *
 * 所以运行中那一刻，卡片其实还不知道自己派给了哪个会话（`details` 要等结果落盘），
 * 而树已经在那儿了。不配的话，界面上永远是"一条派活行 + 一张来源不明的树"。
 *
 * 三步，顺序不能换：
 * 1. **精确**：卡片带 `childConversationId` 就按 id 认领 —— 这是唯一不会错的依据
 * 2. **按角色顺序**：还在跑的卡片没有 id，用 `role` 约束 + 先来先得，尽量对上
 * 3. **剩下的树是孤儿**：不能凭空消失（历史截断、会话恢复时会出现），要单独铺
 *
 * 第 2 步可能配错（同时派两个同类角色时，两张卡片的步骤可能互换）。
 * 这是**已知且可接受**的降级：配错时两张卡片都还在、步骤也都看得到，
 * 只是归属换了 —— 比"什么都没有"好得多。要彻底消掉它得让 `details` 在工具
 * **开始前**就带上会话 id，那需要改宿主的工具协议，不在这一版。
 */
import type { ConversationTree } from './task-tree.js'

/** 配对只需要这几个字段 —— 不依赖 `ToolActivity`，好在测试里直接构造 */
export interface DelegationSource {
  readonly toolCallId: string
  readonly name: string
  readonly args: Record<string, unknown> | undefined
  readonly status: 'running' | 'ok' | 'error'
  readonly childConversationId?: string
}

export interface DelegationPlan {
  /** toolCallId → 这棵树（卡片展开时画它的步骤） */
  readonly byToolCall: ReadonlyMap<string, ConversationTree>
  /** 没配上任何卡片的树 —— 仍然要渲染，不能丢 */
  readonly orphans: readonly ConversationTree[]
}

function roleOf(activity: DelegationSource): string | null {
  const role = activity.args?.['role']
  return typeof role === 'string' ? role : null
}

export function planDelegations(
  activities: readonly DelegationSource[],
  trees: readonly ConversationTree[],
): DelegationPlan {
  const byToolCall = new Map<string, ConversationTree>()
  const taken = new Set<string>()

  // ① 精确配对：卡片自己带着子会话 id（已落定的那条一定有）
  for (const activity of activities) {
    const id = activity.childConversationId
    if (id === undefined || taken.has(id)) continue
    const tree = trees.find((item) => item.conversationId === id)
    if (tree === undefined) continue
    byToolCall.set(activity.toolCallId, tree)
    taken.add(id)
  }

  /*
   * ② 运行中的卡片：还没有 id，按角色 + 先后顺序认领剩下的树。
   * 用 `role` 做约束而不是纯顺序 —— 并行派了 explore 和 librarian 时，
   * 纯顺序会在其中一棵先结束时把另一棵配错。
   */
  const remaining = trees.filter((tree) => !taken.has(tree.conversationId))
  for (const activity of activities) {
    if (activity.name !== 'subagent') continue
    if (activity.childConversationId !== undefined) continue
    if (activity.status !== 'running') continue

    const role = roleOf(activity)
    const index = remaining.findIndex((tree) => tree.role === null || tree.role === role)
    if (index < 0) continue
    const tree = remaining[index]!
    byToolCall.set(activity.toolCallId, tree)
    taken.add(tree.conversationId)
    remaining.splice(index, 1)
  }

  return { byToolCall, orphans: remaining }
}
