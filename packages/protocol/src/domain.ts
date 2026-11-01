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

// ---------------------------------------------------------------- 预览

/** 分维度就绪（DESIGN §9.2）：UI 按这几格显示进度，不要白屏 */
export const Readiness = z.object({
  /** 依赖是否齐（首次 `pnpm install`） */
  deps: z.enum(['pending', 'ready', 'failed']),
  /**
   * 应用数据库。纯前端应用直接记 ready（"不需要"不是"没就绪"）。
   * PGlite 冷启动 2.4s，这一格存在的意义就是让那 2.4 秒有话说。
   */
  db: z.enum(['pending', 'ready', 'failed']),
  /** 后端（NestJS）。纯前端应用没有后端，直接记 ready */
  server: z.enum(['pending', 'ready', 'failed']),
  /** dev server 首屏可访问 */
  preview: z.enum(['pending', 'ready', 'failed']),
})
export type Readiness = z.infer<typeof Readiness>

export const PreviewState = z.enum(['stopped', 'starting', 'ready', 'failed'])
export type PreviewState = z.infer<typeof PreviewState>

export const PreviewStatus = z.object({
  appId: z.string(),
  state: PreviewState,
  /** iframe 该用的地址（网关地址）。未就绪时为 null */
  url: z.string().nullable(),
  gatewayPort: z.number().int().nullable(),
  /** dev server 自己的端口（排障用，不要让前端拿它当 URL） */
  upstreamPort: z.number().int().nullable(),
  /** 后端监听端口（纯前端应用为 null）。网关把 `/api/*` 转到这里 */
  apiPort: z.number().int().nullable(),
  readiness: Readiness,
  /** 失败原因（给用户看的一句话，不拼技术栈的堆栈） */
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
})
export type PreviewStatus = z.infer<typeof PreviewStatus>

// ---------------------------------------------------------------- 运行日志

/**
 * 日志来源。**不是**"哪个进程"，而是"用户该去哪里改代码"：
 *
 * - `web`  前端（浏览器里的异常、`console.error`、SDK 主动上报）
 * - `api`  后端（Nest 的 stdout/stderr）
 * - `vite` dev server 与构建（编译错、HMR 报错）
 * - `db`   应用数据库（PGlite 起不来、迁移失败）
 * - `tenon` 平台自己（预览就绪、判红的原因）
 *
 * 面板按它分组，Agent 按它决定读哪个文件 —— 所以它是契约，不是随手加的 tag。
 */
export const LogSource = z.enum(['web', 'api', 'vite', 'db', 'tenon'])
export type LogSource = z.infer<typeof LogSource>

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof LogLevel>

/**
 * 一条运行日志。
 *
 * `id` 由服务端的 `LogStore` 分配，**去重时复用同一个 id** —— 前端据此做 upsert：
 * 同一句错误在一秒内刷 50 次，界面上是一条 `×50`，而不是 50 行。
 * （React 渲染错误最常见的形态就是无限循环刷同一句，不折叠会把面板冲垮。）
 */
export const LogEntry = z.object({
  id: z.string(),
  appId: z.string(),
  at: z.number(),
  source: LogSource,
  level: LogLevel,
  /** 单行摘要（面板里永远只显示这一行） */
  message: z.string(),
  /** 堆栈 / 结构化细节，点开才看。没有则为 null */
  detail: z.string().nullable(),
  /** 这一条被合并了多少次（≥1）。1 表示就发生了一次 */
  repeat: z.number().int().positive(),
})
export type LogEntry = z.infer<typeof LogEntry>

// ---------------------------------------------------------------- 模板

export const TemplateInfo = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** 预览默认打开的相对路径（`index.html`） */
  entry: z.string().nullable(),
  variables: z.array(z.string()),
  /** 模板作者留下的说明（为什么不引某依赖之类），前端可原样展示 */
  notes: z.array(z.string()),
})
export type TemplateInfo = z.infer<typeof TemplateInfo>

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

/**
 * 一行差异。
 *
 * 结构化而不是让前端解析 patch 文本，是因为两边都要用同一份事实：
 * 服务端要拼 patch 交给模型，前端要逐行着色并显示行号。
 * 让前端再按 `+` / `-` 前缀解析一遍，行内容本身以 `+` 开头时就会错位。
 */
export const DiffLine = z.object({
  kind: z.enum(['ctx', 'add', 'del']),
  text: z.string(),
  /** 旧文件行号（1 起）；新增行为 null */
  oldLine: z.number().nullable(),
  /** 新文件行号（1 起）；删除行为 null */
  newLine: z.number().nullable(),
})
export type DiffLine = z.infer<typeof DiffLine>

export const DiffFile = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  insertions: z.number(),
  deletions: z.number(),
  lines: z.array(DiffLine),
  patch: z.string(),
  /** 二进制文件不做逐行 diff，`lines` 为空 */
  binary: z.boolean().optional(),
  /** 超过行数上限，`lines` 为空，只能看 patch 的说明 */
  truncated: z.boolean().optional(),
})
export type DiffFile = z.infer<typeof DiffFile>
