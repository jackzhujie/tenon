/**
 * 领域类型（DESIGN §6.2 / §7.2）。
 *
 * 这些是**跨进程契约**：服务端与前端共用。数据库行 → 领域对象由 `@tenon/core` 负责，
 * 不在这里做映射（protocol 不依赖任何存储实现）。
 */
import { z } from 'zod'

export const AppStatus = z.enum(['idle', 'running', 'error', 'archived'])
export type AppStatus = z.infer<typeof AppStatus>

export const App = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  templateId: z.string(),
  styleId: z.string().nullable(),
  status: AppStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOpenedAt: z.number().nullable(),
})
export type App = z.infer<typeof App>

export const ReleaseKind = z.enum(['docker', 'static', 'push'])
export type ReleaseKind = z.infer<typeof ReleaseKind>

export const Release = z.object({
  id: z.string(),
  appId: z.string(),
  version: z.string(),
  commitSha: z.string(),
  kind: ReleaseKind,
  artifactPath: z.string().nullable(),
  imageRef: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.number(),
})
export type Release = z.infer<typeof Release>

export const ProviderKind = z.enum(['builtin', 'openai-compatible'])
export type ProviderKind = z.infer<typeof ProviderKind>

/** 模型档位（DESIGN §4.2 的 BYOK 三档；`auto` 由路由器决定） */
export const ModelTier = z.enum(['auto', 'fast', 'comprehensive', 'thinking'])
export type ModelTier = z.infer<typeof ModelTier>

/** 对外**永不**包含明文密钥，只有 `hasApiKey` */
export const ProviderProfile = z.object({
  id: z.string(),
  label: z.string(),
  kind: ProviderKind,
  baseUrl: z.string().nullable(),
  tier: ModelTier,
  modelId: z.string(),
  paramsJson: z.string().nullable(),
  hasApiKey: z.boolean(),
})
export type ProviderProfile = z.infer<typeof ProviderProfile>

// ---------------------------------------------------------------- 对话消息

export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('file'), path: z.string(), mediaType: z.string().optional() }),
  z.object({ type: z.literal('image'), url: z.string(), alt: z.string().optional() }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    stack: z.string().optional(),
    file: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string(),
    status: z.enum(['running', 'ok', 'error']),
    args: z.record(z.string(), z.unknown()).optional(),
    output: z.string().optional(),
  }),
])
export type MessagePart = z.infer<typeof MessagePart>

export const MessageRole = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRole>

/**
 * 归一化消息：前端只吃这一种形状。
 * `id` 是 pi 的 entry id（重启后稳定，可用来做增量渲染的 key）。
 */
export const NormalizedMessage = z.object({
  id: z.string(),
  role: MessageRole,
  parts: z.array(MessagePart),
  at: z.number(),
  /** 只有 in-flight 的消息会是 `streaming`；历史消息一律 `settled` */
  status: z.enum(['streaming', 'settled', 'aborted']),
})
export type NormalizedMessage = z.infer<typeof NormalizedMessage>

// ---------------------------------------------------------------- 计划 / 文件

export const PlanTaskStatus = z.enum(['pending', 'running', 'waiting', 'completed', 'failed'])
export type PlanTaskStatus = z.infer<typeof PlanTaskStatus>

export const PlanTask = z.object({
  id: z.string(),
  title: z.string(),
  status: PlanTaskStatus,
  /** 子会话 id（pi 的任务所有者），没有则为 null */
  ownerConversationId: z.string().nullable(),
  commitSha: z.string().nullable(),
})
export type PlanTask = z.infer<typeof PlanTask>

export const FileNode = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().optional(),
})
export type FileNode = z.infer<typeof FileNode>

// ---------------------------------------------------------------- Git

export const GitCommit = z.object({
  sha: z.string(),
  message: z.string(),
  author: z.string(),
  at: z.number(),
  parents: z.array(z.string()),
})
export type GitCommit = z.infer<typeof GitCommit>

export const GitFileChange = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  insertions: z.number().optional(),
  deletions: z.number().optional(),
})
export type GitFileChange = z.infer<typeof GitFileChange>
