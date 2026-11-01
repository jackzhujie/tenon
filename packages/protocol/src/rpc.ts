/**
 * RPC 方法表（DESIGN §7.2 的 M1 子集）。
 *
 * 一张表三种用途：服务端校验入参、前端获得 `RpcInput<'chat.submit'>` 类型、
 * 测试用它断言「契约里声明的每个方法都真的挂了实现」（`server/test/rpc-coverage.test.ts`）。
 *
 * 新增方法只改这里 + 在 server 里注册 handler，两边不同步会被覆盖率测试抓到。
 */
import { z } from 'zod'
import {
  App,
  FileNode,
  GitCommit,
  GitFileChange,
  LogEntry,
  LogLevel,
  LogSource,
  MessagePart,
  ModelTier,
  NormalizedMessage,
  PlanTask,
  PreviewStatus,
  ProviderProfile,
  Release,
  TemplateInfo,
} from './domain.js'

const Id = z.string().min(1)
const WhenBusy = z.enum(['follow-up', 'steer', 'reject'])

/**
 * 点选/框选上下文（DESIGN §10.2）。
 *
 * `loc.kind` 的三档含义：
 * - `usage`：用户**写这一行**的地方（callsite 命中），改这里就是改"我在这页这样用了它"
 * - `element`：页面里的原生标签
 * - `component-impl`：组件库实现内部 —— 改动影响全局，UI 上要提示
 */
export const SelectionLoc = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  kind: z.enum(['usage', 'element', 'component-impl']).default('element'),
})
export type SelectionLoc = z.infer<typeof SelectionLoc>

export const SelectionImpl = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})

export const SelectionContext = z.object({
  kind: z.enum(['element', 'region', 'error']),
  route: z.string().optional(),
  loc: SelectionLoc.optional(),
  /** callsite 命中时的组件实现位置，供 Agent 判断改动影响面 */
  impl: SelectionImpl.optional(),
  selector: z.string().optional(),
  rect: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
  /** 元素文本，截断到 500 字（再多只是把 token 烧给噪声） */
  text: z.string().max(500).optional(),
  /** 只记与父级**不同**的关键样式，省得把整份 computed style 塞进上下文 */
  styles: z.record(z.string(), z.string()).optional(),
  elements: z
    .array(z.object({ selector: z.string(), loc: SelectionLoc.optional() }))
    .max(50)
    .optional(),
  viewport: z.object({ width: z.number(), height: z.number(), dpr: z.number() }).optional(),
})
export type SelectionContext = z.infer<typeof SelectionContext>

export const ChatSubmitInput = z.object({
  appId: Id,
  content: z.string().min(1),
  parts: z.array(MessagePart).default([]),
  selection: SelectionContext.optional(),
  whenBusy: WhenBusy.default('follow-up'),
  /** 幂等键（前端生成 uuid）。同键重放 → 命中同一 Submission，这是 DoD 的一部分 */
  requestId: z.string().min(1),
  modelTier: ModelTier.default('auto'),
})
export type ChatSubmitInput = z.infer<typeof ChatSubmitInput>

const Empty = z.object({})

export const rpcMethods = {
  health: {
    input: Empty,
    output: z.object({
      ok: z.literal(true),
      version: z.string(),
      tenonHome: z.string(),
      /** 没配模型时为 null —— server 必须能在「还没配置」的状态下正常启动 */
      model: z
        .object({
          mode: z.enum(['faux', 'openai-compatible']),
          providerId: z.string(),
          modelId: z.string(),
        })
        .nullable(),
      openApps: z.array(z.string()),
      sseSubscribers: z.number(),
    }),
  },

  'app.list': {
    input: z.object({ includeArchived: z.boolean().default(false) }),
    output: z.object({ apps: z.array(App) }),
  },
  'app.get': {
    input: z.object({ id: Id }),
    output: z.object({
      app: App,
      releases: z.array(Release),
      lastCommit: GitCommit.nullable(),
    }),
  },
  'app.create': {
    input: z.object({
      name: z.string().min(1).max(64),
      templateId: z.string().default('react-vite'),
      styleId: z.string().nullable().default(null),
      /** 建库（pgdata）是 M2 的事；M1 只建目录 + git init */
      description: z.string().optional(),
    }),
    output: z.object({ app: App }),
  },
  'app.delete': {
    input: z.object({ id: Id, removeFiles: z.boolean().default(true) }),
    output: z.object({ deleted: z.literal(true) }),
  },

  'chat.submit': {
    input: ChatSubmitInput,
    output: z.object({
      /** 同一 `requestId` 重放会拿到同一个 id —— 幂等语义由 pi-durable 保证，不需要额外字段 */
      submissionId: z.string(),
    }),
  },
  'chat.stop': {
    input: z.object({ appId: Id }),
    output: z.object({ stopped: z.boolean() }),
  },
  'chat.history': {
    input: z.object({
      appId: Id,
      limit: z.number().int().positive().max(500).default(200),
      before: z.string().optional(),
    }),
    output: z.object({
      messages: z.array(NormalizedMessage),
      /** 还有更早的消息时为游标，M1 先返回 null */
      nextCursor: z.string().nullable(),
    }),
  },

  'template.list': {
    input: Empty,
    output: z.object({ templates: z.array(TemplateInfo) }),
  },

  /**
   * 起预览：**立刻返回**（`state: 'starting'`），不在这里等 `pnpm install`。
   * 进度靠 SSE 的 `preview.status` 推；要同步等待的调用方轮询 `preview.status`
   * 或 `waitReady()`（见 `@tenon/gateway`）。
   */
  'preview.start': {
    input: z.object({
      appId: Id,
      /** 已经在跑时是否先停再起（改了 `package.json` 之后需要） */
      restart: z.boolean().default(false),
    }),
    output: z.object({ preview: PreviewStatus }),
  },
  'preview.stop': {
    input: z.object({ appId: Id }),
    output: z.object({ preview: PreviewStatus }),
  },
  'preview.status': {
    input: z.object({ appId: Id }),
    output: z.object({ preview: PreviewStatus }),
  },

  /**
   * 运行日志（M2 错误面板）。
   *
   * 为什么要单独一个 RPC 而不是只靠 SSE：SSE 只推"连上之后"发生的事。
   * 用户切回一个早就跑着的应用时，最想看的恰恰是**刚才**那条报错 ——
   * 所以缓冲留在服务端，`logs.list` 一次拿回来，SSE 只负责增量。
   *
   * `limit` 从**最新**往回数（面板默认看最后 200 条，越界的老日志没人看）。
   */
  'logs.list': {
    input: z.object({
      appId: Id,
      limit: z.number().int().positive().max(500).default(200),
      /** 只要这几类来源（不传 = 全部） */
      sources: z.array(LogSource).optional(),
      /** 只要这个级别及以上（`error` 看问题、`debug` 排细节） */
      minLevel: LogLevel.optional(),
    }),
    output: z.object({ entries: z.array(LogEntry) }),
  },
  'logs.clear': {
    input: z.object({ appId: Id }),
    output: z.object({ cleared: z.number().int().nonnegative() }),
  },

  'plan.get': {
    input: z.object({ appId: Id }),
    output: z.object({ tasks: z.array(PlanTask) }),
  },

  'files.tree': {
    input: z.object({ appId: Id, depth: z.number().int().min(1).max(8).default(2) }),
    output: z.object({ nodes: z.array(FileNode) }),
  },
  'files.read': {
    input: z.object({ appId: Id, path: z.string().min(1) }),
    output: z.object({ path: z.string(), content: z.string(), etag: z.string() }),
  },

  'git.log': {
    input: z.object({ appId: Id, limit: z.number().int().positive().max(200).default(30) }),
    output: z.object({ commits: z.array(GitCommit) }),
  },
  'git.diff': {
    input: z.object({ appId: Id, from: z.string().min(1), to: z.string().default('HEAD') }),
    output: z.object({ changes: z.array(GitFileChange), patch: z.string() }),
  },
  'git.revert': {
    input: z.object({ appId: Id, sha: z.string().min(1) }),
    output: z.object({ commit: GitCommit }),
  },

  'settings.get': {
    input: Empty,
    output: z.object({ values: z.record(z.string(), z.unknown()) }),
  },
  'settings.set': {
    input: z.object({ values: z.record(z.string(), z.unknown()) }),
    output: z.object({ values: z.record(z.string(), z.unknown()) }),
  },

  'provider.list': {
    input: Empty,
    output: z.object({ profiles: z.array(ProviderProfile) }),
  },
  'provider.upsert': {
    input: z.object({
      id: z.string().optional(),
      label: z.string().min(1),
      kind: z.enum(['builtin', 'openai-compatible']),
      baseUrl: z.string().nullable().default(null),
      tier: ModelTier.default('auto'),
      modelId: z.string().min(1),
      paramsJson: z.string().nullable().default(null),
      /** 明文只在写入方向出现；读出方向永远没有这个字段 */
      apiKey: z.string().nullable().default(null),
    }),
    output: z.object({ profile: ProviderProfile }),
  },
  'provider.delete': {
    input: z.object({ id: Id }),
    output: z.object({ deleted: z.literal(true) }),
  },
} as const

export type RpcMethods = typeof rpcMethods
export type RpcMethod = keyof RpcMethods
export type RpcInput<M extends RpcMethod> = z.input<RpcMethods[M]['input']>
/** 服务端看到的入参（已过 zod 默认值/裁剪） */
export type RpcArgs<M extends RpcMethod> = z.output<RpcMethods[M]['input']>
export type RpcOutput<M extends RpcMethod> = z.output<RpcMethods[M]['output']>

export const rpcMethodNames = Object.keys(rpcMethods) as RpcMethod[]

export function isRpcMethod(name: string): name is RpcMethod {
  return Object.hasOwn(rpcMethods, name)
}
