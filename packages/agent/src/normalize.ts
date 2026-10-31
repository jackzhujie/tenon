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
  timestamp?: number
  usage?: { input?: number; output?: number; cost?: { total?: number } }
  model?: string
}

export interface RawEntry {
  id: number | string
  kind: string
  model?: RawMessage[]
  data?: unknown
}

const KIND_USER = 'pi.user'
const KIND_ASSISTANT = 'pi.assistant'
const KIND_TOOL_RESULT = 'pi.tool-result'

function blocksToParts(blocks: readonly RawBlock[]): MessagePart[] {
  const parts: MessagePart[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    // thinking 不进消息流（M2 起有「思考」折叠面板再单独下发）
    if (block.type === 'toolCall' && typeof block.id === 'string') {
      parts.push({
        type: 'tool',
        toolCallId: block.id,
        name: block.name ?? 'tool',
        status: 'ok',
        args: block.arguments,
      })
    }
  }
  return parts
}

function contentToParts(content: RawMessage['content']): MessagePart[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  return blocksToParts(content ?? [])
}

export function normalizeEntry(entry: RawEntry): NormalizedMessage | undefined {
  const messages = entry.model ?? []
  const first = messages[0]
  const at = first?.timestamp ?? 0

  if (entry.kind === KIND_USER) {
    const parts = messages.flatMap((message) => contentToParts(message.content))
    return parts.length === 0
      ? undefined
      : { id: String(entry.id), role: 'user', parts, at, status: 'settled' }
  }

  if (entry.kind === KIND_ASSISTANT) {
    const parts = messages.flatMap((message) => contentToParts(message.content))
    return parts.length === 0
      ? undefined
      : { id: String(entry.id), role: 'assistant', parts, at, status: 'settled' }
  }

  if (entry.kind === KIND_TOOL_RESULT) {
    // 工具结果挂在工具调用上渲染（M2 的工具面板），历史里不再单独出一条气泡
    return undefined
  }

  return undefined
}

export function normalizeEntries(entries: readonly RawEntry[]): NormalizedMessage[] {
  const messages: NormalizedMessage[] = []
  for (const entry of entries) {
    const message = normalizeEntry(entry)
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
