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

/**
 * 发布前检查（M4 第 7 步）。
 *
 * 三态而不是布尔，是因为「没过」有两种完全不同的意思：
 * - `fail`：**该检查的东西检查失败了** —— 类型有错、测试红了、`tsc` 崩了/超时。
 * - `skip`：**这个应用没有这项检查** —— 没有 tsconfig、package.json 里没有 test 脚本。
 *
 * 混成一个 `false` 会让"没配测试"和"测试挂了"看起来一样，而这两件事的处置方式相反：
 * 前者照发不误，后者必须拦。所以判断能不能发只看有没有 `fail`，`skip` 不拦但要说出来。
 */
export const CheckId = z.enum(['typecheck', 'test'])
export type CheckId = z.infer<typeof CheckId>

export const CheckStatus = z.enum(['pass', 'fail', 'skip'])
export type CheckStatus = z.infer<typeof CheckStatus>

export const CheckOutcome = z.object({
  id: CheckId,
  status: CheckStatus,
  /** 一句话结论，直接显示给用户（"类型检查通过（2 个 tsconfig，4.1s）"） */
  summary: z.string(),
  /** 失败/跳过时的补充输出（已截断）；通过时通常是 null */
  detail: z.string().nullable(),
  elapsedMs: z.number().int().nonnegative(),
})
export type CheckOutcome = z.infer<typeof CheckOutcome>

export const GateOutcome = z.object({
  /** 没有任何一项 `fail`。`skip` 不算失败 */
  ok: z.boolean(),
  checks: z.array(CheckOutcome),
})
export type GateOutcome = z.infer<typeof GateOutcome>

/**
 * 这一版是怎么发出去的。
 * - `pass`：检查跑过且没有 fail（**包括全部 skip 的情况** —— 那是"没得检查"，不是"偷偷发的"）
 * - `forced`：检查没过，用户明确选择"我知道，仍然发布"
 *
 * 老记录（迁移 2 之前）是 `null`：那时候还没有门禁，不能倒推成 pass，也不能说人家是 forced。
 */
export const ReleaseGateStatus = z.enum(['pass', 'forced'])
export type ReleaseGateStatus = z.infer<typeof ReleaseGateStatus>

export const Release = z.object({
  id: z.string(),
  appId: z.string(),
  version: z.string(),
  commitSha: z.string(),
  kind: ReleaseKind,
  artifactPath: z.string().nullable(),
  imageRef: z.string().nullable(),
  notes: z.string().nullable(),
  gateStatus: ReleaseGateStatus.nullable(),
  /** 门禁摘要（"类型检查 ✓ · 测试 ⏭ 没有 test 脚本"），历史列表里直接显示 */
  gateSummary: z.string().nullable(),
  createdAt: z.number(),
})
export type Release = z.infer<typeof Release>

export const ProviderKind = z.enum(['builtin', 'openai-compatible'])
export type ProviderKind = z.infer<typeof ProviderKind>

/** 模型档位（DESIGN §4.2 的 BYOK 三档；`auto` 由路由器决定） */
export const ModelTier = z.enum(['auto', 'fast', 'comprehensive', 'thinking'])
export type ModelTier = z.infer<typeof ModelTier>

/**
 * 一个模型的**价格**（M5.5）。
 *
 * 单位是「美元 / 百万 token」，与 pi 的 `model.cost` 一致 —— 换算只做一次，
 * 而且发生在核心库那边（`resolveModel`）。这里存什么单位，算钱的地方就必须是什么单位。
 *
 * 为什么挂在 (profileId, modelId) 上而不是 provider 上：同一家的 flash 与 pro
 * 差价好几倍，按 provider 记价一换模型就全错，而"额度算错"用户不会发现，直到账单来。
 */
export const ModelPrice = z.object({
  id: z.string(),
  profileId: z.string(),
  modelId: z.string(),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  /** 大部分提供商不单独收这两项，默认 0 */
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
  updatedAt: z.number(),
})
export type ModelPrice = z.infer<typeof ModelPrice>

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
    /**
     * 这次**这一次**工具调用自己的花费（v1.2.19）。
     *
     * 目前只有 `subagent` 会带：它派出去一个子会话，跑完读那个会话的账本。
     * 为什么不做"按角色累计"：累计会被历史稀释，而用户要判断的是"下次还该不该派"。
     */
    spend: z.object({ totalTokens: z.number(), costUsd: z.number() }).optional(),
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

// ---------------------------------------------------------------- 任务图

/**
 * 一个活着的 task（M4 任务图面板）。
 *
 * 这是 pi 的 `TaskGraphNode` **归一化之后**的形状，不是它本身：
 * - `kind` 去掉了 `pi.` 前缀（前端不该知道宿主的命名空间）
 * - `scope` 是我们加的：这个 task 跑在主对话里，还是跑在被派出去的子会话里
 * - `role` 也是我们加的：工具 task 的 `args.role`，或者从"谁派生了这个会话"继承
 *   （pi 的任务树里没有角色这个概念，它只知道 kind）
 *
 * ⚠️ 这份图**只描述"现在"**。pi 在静止时回收节点，所以跑完再查是空数组，
 * 不能拿它当"派过几次活的记录"——那要看会话列表（`ConversationRecord.owner`）。
 */
export const TaskGraphNode = z.object({
  id: z.string(),
  /** `generation` / `tool` / 宿主自定的其它 kind */
  kind: z.string(),
  /** 这个 task 跑在哪个会话里 */
  conversationId: z.string(),
  /** root = 主对话；delegated = 子会话（`conversationId !== 根会话`） */
  scope: z.enum(['root', 'delegated']),
  /** pi 的原始任务树父节点（`pi.tool` 的 owner 是发起它的那次 generation） */
  ownerId: z.string().nullable(),
  /**
   * 显示用的父节点：优先 `ownerId`，否则"派生出这个会话的那个工具 task"。
   * 分开两个字段是因为**会话树和任务树不是一个形状**——子会话里的 generation
   * task 在 pi 眼里没有 owner，但用户看到的是"那个 subagent 工具跑出来的"。
   */
  parentId: z.string().nullable(),
  status: z.enum(['pending', 'running', 'waiting', 'sleeping', 'completing']),
  /** pi 的细阶段：`prepare` / `request` / `tools` / `call` / `execute`。没有则 null */
  phase: z.string().nullable(),
  /** `waiting` 时在等哪些 task */
  waitingOn: z.array(z.string()),
  /** 这个 task 拥有的会话 —— 派活时就是子会话 id */
  spawned: z.array(z.string()),
  /** 角色 id（`explore` / `librarian` …），不知道则 null */
  role: z.string().nullable(),
})
export type TaskGraphNode = z.infer<typeof TaskGraphNode>

export const TaskGraph = z.object({
  /** 主对话的会话 id：前端据此把 `delegated` 的那些高亮出来 */
  rootConversationId: z.string(),
  nodes: z.array(TaskGraphNode),
})
export type TaskGraph = z.infer<typeof TaskGraph>

// ---------------------------------------------------------------- 用量与预算

/**
 * 一份用量计数（M4 第 3 步）。
 *
 * 单位是 token 与美元，**不折算**：用户的账单是按美元出的，token 是能对上
 * 上下文窗口的那个数 —— 少报一个都会让"为什么这一轮这么贵"没法解释。
 */
export const UsageTotals = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  /** pi 的 `cost.total`。faux 恒为 0（本地假模型不报价），所以拦截不能只看钱 */
  costUsd: z.number(),
})
export type UsageTotals = z.infer<typeof UsageTotals>

/**
 * 一个应用的额度。两个维度都可不设（`null` = 这条不设限），都不设就等于不拦。
 *
 * 为什么两个维度都要：真模型上只有钱有意义，而 `faux` 报 0 美元 —— 只设钱的话
 * 本地一条测试都验不了熔断。反过来只设 token 又对不上用户看到的账单。
 */
export const Budget = z.object({
  maxCostUsd: z.number().nonnegative().nullable(),
  maxTokens: z.number().int().nonnegative().nullable(),
})
export type Budget = z.infer<typeof Budget>

/** `over` = 顶到某条线（该拦了）；`warn` = 已用八成（还没拦，先让人看见） */
export const UsageLevel = z.enum(['ok', 'warn', 'over'])
export type UsageLevel = z.infer<typeof UsageLevel>

export const BudgetDimension = z.enum(['cost', 'tokens'])
export type BudgetDimension = z.infer<typeof BudgetDimension>

/**
 * 用量快照 —— **推全量**，跟任务图一个道理：几个数字，推增量要维护
 * "哪个 delta 该加到哪个桶"的状态机，算错一次就长期显示错的余额。
 */
export const UsageSnapshot = z.object({
  appId: z.string(),
  /** 这个应用**所有会话**的累计（根会话 + 子 Agent + 压缩摘要），跨重启不丢 */
  totals: UsageTotals,
  /** `provider/modelId` → 各自的量。子 Agent 的花费记在它自己会话的桶里，已计入 `totals`，不在这一层 */
  models: z.record(z.string(), UsageTotals),
  /** 工具自身的花费（pi 的 `tools` 桶）。同样已计入 `totals` */
  tools: z.record(z.string(), UsageTotals),
  /** 当前这一轮的量（距本轮开始）。空闲时保留上一轮的，方便回答"刚才那道题花了多少" */
  turn: UsageTotals,
  budget: Budget,
  level: UsageLevel,
  /** 顶到的是哪条线（`over` 时才有值），拦截文案用它 */
  exceeded: BudgetDimension.nullable(),
  /**
   * 当前模型配了价格吗。
   *
   * 为什么必须单独一格：没配价格时 `costUsd` 恒为 0 —— 界面上那个 $0.00 不是"便宜"，
   * 是"没算"。不区分这两者的话，用户会以为自己离额度还很远。
   */
  priced: z.boolean(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshot>

/**
 * 跨应用汇总里的一行（`usage.total`，v1.2.17）。
 *
 * 单独成型而不是"把 UsageSnapshot 数组起来"：汇总不需要 models / tools 两个分桶
 * （那是"这个应用为什么贵"的解释，属于本应用面板），跨应用只要一个能和别的应用相加的数。
 */
export const UsageAppUsage = z.object({
  appId: z.string(),
  name: z.string(),
  totals: UsageTotals,
  budget: Budget,
  level: UsageLevel,
  /**
   * `false` = 这个应用还没有账本（从没跑过一轮）。
   *
   * 必须与"花了 0"分开：刚建的应用和用过的应用在 totals 上都是 0，
   * 不区分的话合计会看着像个准数。
   */
  known: z.boolean(),
})
export type UsageAppUsage = z.infer<typeof UsageAppUsage>

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

/* ────────────────────────── 组件体系（M5） ────────────────────────── */

/**
 * 组件类型（DESIGN §21.4）。`bundled` 随包、`hub` 从官方 Hub 下、`local` 是本地目录（M5 不开放）。
 *
 * 它与"从哪个根加载的"必须一致：hub 根里放一个写着 `bundled` 的清单，等于绕过签名校验——
 * 加载计划里会当成错误拦掉。
 */
export const ComponentSource = z.enum(['bundled', 'hub', 'local'])
export type ComponentSource = z.infer<typeof ComponentSource>

export const ComponentPricing = z.discriminatedUnion('type', [
  z.object({ type: z.literal('free') }),
  /**
   * Phase 3 才用得到；M5 / M6 的官方插件恒为 free。
   * 现在的语义是**安全阀**：`paid` 会在安装那一步被直接拒（`paid-not-available`），
   * 因为还没有购买流程 —— 「装了但用不了」比「装不了」糟得多。
   * 门禁在哪、为什么不是 DRM、Phase 3 的 license 长什么样，见 DESIGN §21.5。
   */
  z.object({ type: z.literal('paid'), sku: z.string() }),
])
export type ComponentPricing = z.infer<typeof ComponentPricing>

/** 一处挂载。`prefix` 只对 `app.api`（后端路由）有意义 */
export const ComponentMount = z.object({
  slot: z.string(),
  order: z.number().int(),
  prefix: z.string().nullable(),
})
export type ComponentMount = z.infer<typeof ComponentMount>

/**
 * 一条**装不上**的原因。
 *
 * 为什么是"列出来"而不是抛异常：组件装不上不该让插件页 500。用户要看到的是
 * 「AI 小助手 装不上：它要求 Tenon ≥ 1.4.0，当前 1.2.0」这种东西，
 * 而不是一个红叉加一句「Internal Server Error」。
 *
 * `code` 是稳定契约（界面按它决定要不要给"重试/卸载"按钮），`message` 可以改文案。
 */
export const ComponentProblem = z.object({
  code: z.string(),
  /** 装配声明里的组件 id；坏到连 id 都读不出来时为 null */
  componentId: z.string().nullable(),
  message: z.string(),
  /** 怎么修（"把 version 改成 ^1.0.0" / "先装 xxx"） */
  hint: z.string().nullable(),
})
export type ComponentProblem = z.infer<typeof ComponentProblem>

/** 装配声明里的一条，加上解析结果 —— 插件页直接渲染这个 */
export const InstalledComponent = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** 实际选中的版本（不是装配声明里的区间） */
  version: z.string(),
  source: ComponentSource,
  license: z.string(),
  /** 插件页的开关。`false` = 声明还在但不加载 */
  enabled: z.boolean(),
  /**
   * 是否真的会被加载：`enabled` 为真且没有任何 error 级 problem。
   *
   * 与 `enabled` 分开是因为两种"没生效"要区别对待：开关关了是用户的选择，
   * 装不上是故障。界面上前者是灰色开关，后者是红字。
   */
  loaded: z.boolean(),
  permissions: z.array(z.string()),
  pricing: ComponentPricing,
  /** 组件自己声明支持哪些插槽 */
  slots: z.array(z.string()),
  mounts: z.array(ComponentMount),
  /** facet 入口（相对插件目录）；没有的那一侧为 null */
  facets: z.object({
    server: z.string().nullable(),
    web: z.string().nullable(),
    worker: z.string().nullable(),
  }),
  /** 安装时要写进应用 AGENTS.md 的说明 */
  agentHints: z.string(),
})
export type InstalledComponent = z.infer<typeof InstalledComponent>

/** 磁盘上有、但没装进这个应用的组件（插件页的"可安装"列表） */
export const AvailableComponent = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  source: ComponentSource,
  pricing: ComponentPricing,
  /** 已经在装配声明里（哪怕被 `enabled: false` 关着也算装了） */
  installed: z.boolean(),
})
export type AvailableComponent = z.infer<typeof AvailableComponent>
