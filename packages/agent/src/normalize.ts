/**
 * pi-durable 的 entry → 归一化消息。
 *
 * 前端不该知道 `pi.user` / `pi.assistant` / `AssistantMessage` 这些东西长什么样，
 * 所以映射只发生在这一处：pi 升级时改这里，不动 UI。
 */
import type { MessagePart, NormalizedMessage } from '@tenon/protocol'

/** pi 的内容块（只声明我们真的会读的字段，其余忽略） */
interface RawBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

interface RawMessage {
  role?: string
  content?: string | RawBlock[]
  /** 工具结果那条 entry 用它指回是哪次调用 */
  toolCallId?: string
  toolName?: string
  /** 工具自己失败了（参数错、路径越界、装不上…） */
  isError?: boolean
  timestamp?: number
  usage?: { input?: number; output?: number; cost?: { total?: number } }
  model?: string
  /** 工具结果那条 entry 上挂的 details（工具自己写的结构化信息） */
  details?: unknown
}

export interface RawEntry {
  id: number | string
  kind: string
  model?: RawMessage[]
  data?: unknown
}

const KIND_USER = 'pi.user'
export const KIND_ASSISTANT = 'pi.assistant'
export const KIND_TOOL_RESULT = 'pi.tool-result'

/**
 * 一次工具调用自己的花费。目前只有 `subagent` 会带（它把子会话的账读出来写进 details）。
 *
 * 为什么挂在工具调用上而不是"按角色累计"：累计会被历史稀释，指导不了"下次还该不该派";
 * 单次数字直接可用，而且没有旧数据缺归属的问题。
 */
interface ToolSpend {
  readonly totalTokens: number
  readonly costUsd: number
}

/** 一条工具结果：状态 + 文本 + （可选）这次调用花了多少，按 toolCallId 回填到对应的调用上 */
export interface ToolOutcome {
  readonly status: 'ok' | 'error'
  readonly output: string
  readonly spend?: ToolSpend
  /** `subagent` 的子会话 id：卡片据此自证"派给了谁" */
  readonly childConversationId?: string
}

/** 从 details 里挑出 spend。形状不对就当没有 —— 这里不该因为一个字段而抛 */
function spendOf(details: unknown): ToolSpend | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const raw = (details as { spend?: unknown }).spend
  if (typeof raw !== 'object' || raw === null) return undefined
  const { totalTokens, costUsd } = raw as { totalTokens?: unknown; costUsd?: unknown }
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) return undefined
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return undefined
  return { totalTokens, costUsd }
}

/** 从 details 里挑出子会话 id。同样"形状不对就当没有"，不为一个字段抛 */
function childConversationOf(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const raw = (details as { conversationId?: unknown }).conversationId
  if (typeof raw !== 'string' || raw === '') return undefined
  return raw
}

function textOfBlocks(content: string | RawBlock[] | undefined): string {
  if (typeof content === 'string') return content
  return (content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter((text) => text !== '')
    .join('')
}

function blocksToParts(blocks: readonly RawBlock[], outcomes: Map<string, ToolOutcome>): MessagePart[] {
  const parts: MessagePart[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    // thinking 不进消息流（M2 起有「思考」折叠面板再单独下发）
    if (block.type === 'toolCall' && typeof block.id === 'string') {
      const outcome = outcomes.get(block.id)
      parts.push({
        type: 'tool',
        toolCallId: block.id,
        name: block.name ?? 'tool',
        ...(outcome?.spend === undefined ? {} : { spend: outcome.spend }),
        ...(outcome?.childConversationId === undefined
          ? {}
          : { childConversationId: outcome.childConversationId }),
        /*
         * 状态与输出**来自工具结果那条 entry**，不是"有调用就算成功"。
         * 早先这里写死 'ok'：工具失败（路径越界、装不上组件、命令非零退出）
         * 在界面上和成功一模一样 —— 那是最坏的一种绿。
         */
        status: outcome?.status ?? 'ok',
        ...(outcome === undefined ? {} : { output: outcome.output }),
        args: block.arguments,
      })
    }
  }
  return parts
}

function contentToParts(content: RawMessage['content'], outcomes: Map<string, ToolOutcome>): MessagePart[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  return blocksToParts(content ?? [], outcomes)
}

export function normalizeEntry(
  entry: RawEntry,
  outcomes: Map<string, ToolOutcome> = new Map(),
): NormalizedMessage | undefined {
  const messages = entry.model ?? []
  const first = messages[0]
  const at = first?.timestamp ?? 0

  if (entry.kind === KIND_USER) {
    const parts = messages.flatMap((message) => contentToParts(message.content, outcomes))
    return parts.length === 0
      ? undefined
      : { id: String(entry.id), role: 'user', parts, at, status: 'settled' }
  }

  if (entry.kind === KIND_ASSISTANT) {
    const parts = messages.flatMap((message) => contentToParts(message.content, outcomes))
    return parts.length === 0
      ? undefined
      : { id: String(entry.id), role: 'assistant', parts, at, status: 'settled' }
  }

  if (entry.kind === KIND_TOOL_RESULT) {
    // 工具结果不单独出气泡 —— 它被**回填**到上面那次调用的 part 上（见 normalizeEntries）
    return undefined
  }

  return undefined
}

/**
 * 从一个 tool-result entry 里取出「toolCallId → 结果」。
 *
 * 两处要用同一份判断：离线归一化（历史）与**实时**（工具跑完时把发起它的那条
 * assistant 消息重推一遍）。实时那条链路原先没有这个能力，于是界面上那张工具卡片
 * 永远是空的 —— 明明结果几秒后就到了。
 */
export function toolOutcomesOf(entry: RawEntry): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>()
  if (entry.kind !== KIND_TOOL_RESULT) return outcomes
  for (const message of entry.model ?? []) {
    const id = message.toolCallId
    if (id === undefined || id === '') continue
    const spend = spendOf(message.details)
    const childConversationId = childConversationOf(message.details)
    outcomes.set(id, {
      status: message.isError === true ? 'error' : 'ok',
      output: textOfBlocks(message.content),
      ...(spend === undefined ? {} : { spend }),
      ...(childConversationId === undefined ? {} : { childConversationId }),
    })
  }
  return outcomes
}

export function normalizeEntries(entries: readonly RawEntry[]): NormalizedMessage[] {
  /*
   * 两遍：先收工具结果，再拼消息。
   *
   * 为什么不能一遍走过去就回填：工具结果 entry 一定排在**发起调用的那条 assistant 之后**，
   * 单遍处理时前面那条消息已经产出、改不了了。两遍的代价可以忽略（entries 是内存数组），
   * 收益是工具状态与输出终于不再是猜的。
   */
  const outcomes = new Map<string, ToolOutcome>()
  for (const entry of entries) {
    for (const [id, outcome] of toolOutcomesOf(entry)) outcomes.set(id, outcome)
  }

  const messages: NormalizedMessage[] = []
  for (const entry of entries) {
    const message = normalizeEntry(entry, outcomes)
    if (message !== undefined) messages.push(message)
  }
  return messages
}

/** 从 assistant entry 里取纯文本（做 commit message / 日志摘要用） */
export function assistantText(entry: RawEntry): string {
  const chunks: string[] = []
  for (const message of entry.model ?? []) {
    if (typeof message.content === 'string') {
      chunks.push(message.content)
      continue
    }
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text)
    }
  }
  return chunks.join('').trim()
}

export interface UsageSnapshot {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export function usageOf(entry: RawEntry): UsageSnapshot | undefined {
  const message = entry.model?.[0]
  if (message?.usage === undefined) return undefined
  return {
    model: message.model ?? 'unknown',
    inputTokens: Number(message.usage.input ?? 0),
    outputTokens: Number(message.usage.output ?? 0),
    costUsd: Number(message.usage.cost?.total ?? 0),
  }
}
