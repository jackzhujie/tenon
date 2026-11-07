/**
 * 跨消息合并"工具步骤"（v1.2.27）。
 *
 * ## 为什么不能在一条消息内部合并
 *
 * 第一版就是这么写的（在 `Parts` 里对 `parts` 分组），结果真跑一轮发现**完全没合并** ——
 * 因为 pi 的历史里**每个工具调用是独立的一条 assistant 消息**：
 *
 * ```
 * assistant [tool: bash ls -la]
 * assistant [tool: read package.json]
 * assistant [tool: bash cat src/App.tsx …]
 * assistant [text: 排查结论…]
 * ```
 *
 * 所以真正该合并的是**连续的"只有工具、没有正文"的 assistant 消息**。
 * 探针脚本（`scripts/_probe-parts.ts` 那类）一条命令就能看出来，靠猜会一直猜错。
 *
 * ## 三条边界
 *
 * - **带正文的消息不参与合并**：正文是结论，它把前后的工具分开是对的
 * - **带错误的消息不参与合并**：失败必须独立可见
 * - **用户消息当然不参与**：那是轮的边界
 */
import type { MessagePart, NormalizedMessage } from '@tenon/protocol'

/**
 * 这条消息是不是"纯工具步骤"：全部 parts 都是 tool（允许空 parts 的跳过）。
 *
 * 不把 `file` / `image` 算进来：它们有内容要显示，塞进工具组里会被藏掉。
 */
export function isToolOnlyMessage(message: NormalizedMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.parts.length === 0) return false
  return message.parts.every((part) => part.type === 'tool')
}

export type MessageItem<A> =
  | { readonly kind: 'message'; readonly message: NormalizedMessage; readonly key: string }
  | { readonly kind: 'tools'; readonly activities: readonly A[]; readonly key: string }

/**
 * 把消息流整理成渲染项：连续的纯工具消息并成一项，其余原样。
 *
 * `key` 用第一条的 id（工具组）或消息 id —— React 重排时不会错位。
 */
export function groupMessages<A>(
  messages: readonly NormalizedMessage[],
  toActivity: (part: Extract<MessagePart, { type: 'tool' }>) => A,
): Array<MessageItem<A>> {
  const items: Array<MessageItem<A>> = []
  let buffer: A[] = []
  let bufferKey: string | null = null

  const flush = (): void => {
    if (buffer.length === 0 || bufferKey === null) return
    items.push({ kind: 'tools', activities: buffer, key: `tools:${bufferKey}` })
    buffer = []
    bufferKey = null
  }

  for (const message of messages) {
    if (!isToolOnlyMessage(message)) {
      flush()
      items.push({ kind: 'message', message, key: message.id })
      continue
    }
    if (bufferKey === null) bufferKey = message.id
    for (const part of message.parts) {
      if (part.type === 'tool') buffer.push(toActivity(part))
    }
  }
  flush()
  return items
}
