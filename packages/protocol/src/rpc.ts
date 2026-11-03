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
  AvailableComponent,
  ComponentProblem,
  DiffFile,
  FileNode,
  ModelPrice,
  GateOutcome,
  GitCommit,
  GitFileChange,
  InstalledComponent,
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
  TaskGraph,
  TemplateInfo,
  UsageSnapshot,
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

/**
 * "保存之后模型到底换没换" —— 每个会动模型的设置项都回这个。
 *
 * 为什么把它放进返回值：用户最常问的是"我填完了，现在能用了吗"。
 * 只返回 `{ profile }` 的话，界面只能猜；而猜错的方向是"显示已生效、实际还是旧的"。
 */
export const ModelState = z.object({
  model: z
    .object({
      mode: z.enum(['faux', 'openai-compatible']),
      providerId: z.string(),
      modelId: z.string(),
    })
    .nullable(),
  /** 换不过去的原因（比如 key 缺失）。`model` 为 null 时它一定有值 */
  error: z.string().nullable(),
  /** 这一次调用真的换了模型（false = 设置没变，或者没换成功） */
  changed: z.boolean(),
})
export type ModelState = z.infer<typeof ModelState>

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

  /**
   * 现在这一刻活着哪些 task（M4 任务图）。
   *
   * 前端在切应用 / SSE 断线重连之后拉一次，之后靠 `taskgraph.update` 增量。
   * **返回空数组是正常结果**：pi 静止时回收节点，跑完再看就是空的。
   * 想看"派过几次活"要查会话（`ConversationRecord.owner`），不是这里。
   */
  'taskgraph.get': {
    input: z.object({ appId: Id }),
    output: z.object({ graph: TaskGraph }),
  },

  /**
   * 现在这一刻的用量与额度（M4 第 3 步）。
   *
   * 前端在切应用 / SSE 重连之后拉一次，之后靠 `usage.update` 增量刷新。
   * 真值来自 `harness.usage()`（会话账本），**跨重启不丢** —— 所以这个数
   * 也是"这个应用一共花了多少"，不是"这次打开花了多少"。
   */
  'usage.get': {
    input: z.object({ appId: Id }),
    output: z.object({ snapshot: UsageSnapshot }),
  },
  /**
   * 设额度。两个字段**每次都传**（空就是 `null` = 这条不设限），
   * 不做"只传要改的那个"—— 半更新的语义在布尔/零值上会歧义（`0` 是关掉还是没改？）。
   */
  'budget.set': {
    input: z.object({
      appId: Id,
      maxCostUsd: z.number().nonnegative().nullable().default(null),
      maxTokens: z.number().int().nonnegative().nullable().default(null),
    }),
    output: z.object({ snapshot: UsageSnapshot }),
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
    output: z.object({
      changes: z.array(GitFileChange),
      files: z.array(DiffFile),
      patch: z.string(),
    }),
  },
  'git.show': {
    input: z.object({ appId: Id, sha: z.string().min(1) }),
    output: z.object({
      commit: GitCommit,
      changes: z.array(GitFileChange),
      files: z.array(DiffFile),
      patch: z.string(),
      /**
       * 这个 commit 有没有动表结构。UI 据此决定回滚时要不要提供「连数据一起回去」的选项 ——
       * 没动 schema 的提交给了这个勾选框也没东西可回，反而诱导用户以为会有变化。
       */
      schemaChanged: z.boolean(),
      /** 这个 commit 有没有存过库快照（决定勾选框能不能真的勾） */
      hasSnapshot: z.boolean(),
    }),
  },
  'git.revert': {
    input: z.object({
      appId: Id,
      sha: z.string().min(1),
      /**
       * 连数据库一起回到这个提交之前。默认 false —— 数据比代码贵，
       * "我只是想撤掉那段代码"是最常见的意图，不能让它顺手把数据也抹了。
       */
      dbRestore: z.boolean().default(false),
    }),
    output: z.object({
      commit: GitCommit,
      data: z.object({
        /** 用户勾了没有 */
        requested: z.boolean(),
        /** 实际还原了没有 */
        restored: z.boolean(),
        /**
         * 真正用的快照属于哪个 commit。可能**早于**目标：中间那些提交没改 schema
         * 就没有快照，只能退到最近一个有的 —— 所以这个值和目标不一致时必须告诉用户。
         */
        fromSha: z.string().nullable(),
        /** 实际丢掉了多少个提交期间写入的数据（`fromSha` 到目标之间隔了几个提交） */
        skippedCommits: z.number().int().nonnegative(),
      }),
    }),
  },

  'release.list': {
    input: z.object({ appId: Id, limit: z.number().int().positive().max(100).default(20) }),
    output: z.object({ releases: z.array(Release) }),
  },
  /**
   * 发布预检：**现在这一版能不能发**。只读 —— 不打 tag、不写记录、不消耗版本号。
   *
   * 为什么要有它：门禁只在 `release.publish` 里跑的话，用户点了才知道过不过，而这
   * 个功能的全部价值恰恰是"**在发之前**知道"。对话框一打开就跑它。
   *
   * 注意它是**真跑**（`tsc` + `pnpm run test`），不是读缓存 —— 所以慢是正常的，
   * 界面得显示"正在检查"和已经等了多久。也正因为真跑，`gate` 只对 `commitSha`
   * 那一版有效：检查期间又有提交时 `stale` 会置真，这份结果就不能当依据了。
   */
  'release.check': {
    input: z.object({ appId: Id }),
    output: z.object({
      /**
       * 现在点发布会不会成功。
       *
       * 注意它**不是**按钮的 disabled 依据：门禁没过但用户坚持时仍然能发（`force`），
       * 那时 `ready` 是 `false` 而按钮是可点的。它只用来给"绿 / 黄 / 红"一个判据。
       */
      ready: z.boolean(),
      /**
       * 拦在发布之前的事：正在生成（`APP_BUSY`）、没有提交（`RELEASE_NO_COMMITS`）、
       * 工作区脏（`GIT_DIRTY_WORKTREE`）。
       *
       * 有值时**不会跑门禁**（`gate` 为 null）：工作区脏却去跑一遍测试，既白等几十秒，
       * 又会让人以为"测试通过就快能发了"。真正该做的是把这一轮跑完。
       */
      blocked: z.object({ code: z.string(), message: z.string() }).nullable(),
      /** 检查针对的是哪个提交。没有提交时为 null */
      commitSha: z.string().nullable(),
      /** 门禁结果。`blocked` 有值时为 null */
      gate: GateOutcome.nullable(),
      /**
       * 检查跑完发现 HEAD 已经不是开始那一版了。
       *
       * 一份针对 A 的"通过"拿来给 B 用，比不检查更糟 —— 它给的是虚假的安心。
       * 这时界面该说的是"重新检查一次"，而不是"可以发"。
       */
      stale: z.boolean(),
      /** 这次预检花了多久（用户要理解为什么打开对话框要等一会儿） */
      elapsedMs: z.number().int().nonnegative(),
    }),
  },
  'release.publish': {
    input: z.object({
      appId: Id,
      /** 发布说明。会写进 annotated tag 的正文，也存进发布记录 */
      notes: z.string().max(2000).optional(),
      /**
       * 检查没过也发。
       *
       * **仍然会跑检查**（结果要留痕、用户要看见自己放过了什么），只是不拦。
       * 记录里标成 `forced` —— 半年后有人问"这版为什么带着类型错误上线"，
       * 答案得在记录里，而不是谁的记忆里。
       */
      force: z.boolean().optional(),
    }),
    output: z.object({
      release: Release,
      version: z.string(),
      commitSha: z.string(),
      /** 备份库绝对路径：`git clone <它>` 拿到的就是这一版 */
      backupPath: z.string(),
      branch: z.string(),
      /** 这次真正写进备份库的对象数；0 表示备份库本来就已经是最新的 */
      objects: z.number().int().nonnegative(),
      /** 这次跑过的检查。发成功之后前端也要显示"它是怎么过的" */
      gate: GateOutcome,
    }),
  },

  /**
   * 这个应用装了哪些组件、为什么有的装不上、磁盘上还有什么可装（M5 第 2 步）。
   *
   * **只读**：不加载任何东西，也不改装配声明。装不上的原因放在 `problems` 里而不是让整个
   * 调用失败 —— 插件页要能显示「AI 小助手装不上：它要求 Tenon ≥ 1.4.0」，而不是一个 500。
   */
  'component.list': {
    input: z.object({ appId: Id }),
    output: z.object({
      /** 装配声明里的每一条（按声明顺序），含被 `enabled:false` 关掉的和装不上的 */
      components: z.array(InstalledComponent),
      /** 装不上的原因。`code` 是稳定契约，见 `@tenon/component-host` 的 `COMPONENT_PROBLEM_CODES` */
      problems: z.array(ComponentProblem),
      /** 磁盘上有、但没装配的组件（插件页的"可安装"） */
      available: z.array(AvailableComponent),
      /** 装配声明文件名（`app.components.json`，相对仓库根） */
      assemblyFile: z.string(),
      /** 当前宿主版本 —— 界面要能说清"组件要求 1.4.0，你是 1.2.0" */
      tenonVersion: z.string(),
    }),
  },

  /**
   * 插件页的开关（M5 第 6 步）：**关掉不等于卸载**。
   *
   * 声明留在 `app.components.json` 里、`enabled` 变 false —— 这样"关掉试试"之后
   * 能一键开回来，而卸载（删声明 + 清 AGENTS.md）是另一条路，代价更大。
   */
  'component.setEnabled': {
    input: z.object({ appId: Id, id: Id, enabled: z.boolean() }),
    output: z.object({
      components: z.array(InstalledComponent),
      /** 关掉之后界面上没有它了，但下次提问前的重连仍然要等页面刷新 */
      reloaded: z.literal(true),
    }),
  },

  'settings.get': {
    input: Empty,
    output: z.object({ values: z.record(z.string(), z.unknown()) }),
  },
  'settings.set': {
    input: z.object({ values: z.record(z.string(), z.unknown()) }),
    output: z.object({ values: z.record(z.string(), z.unknown()), applied: ModelState }),
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
    output: z.object({ profile: ProviderProfile, applied: ModelState }),
  },
  /**
   * 测一下这个 provider 到底通不通（端点 / key / 模型 id 三者有一个错都会失败）。
   *
   * 为什么值得单独一个 RPC：填错 key 的表现与"模型有点笨"几乎一样 ——
   * 用户会以为是产品不好用。发一次最小的请求，把 HTTP 状态与错误原文交回去。
   */
  'provider.test': {
    input: z.object({ id: Id }),
    output: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      /** 失败时是提供商的原话（不要改写成"连接失败"，那句话没有诊断价值） */
      message: z.string(),
    }),
  },
  /**
   * 价格（M5.5）。**没有价格就永远算不出钱** —— pi 的 cost 来自 `model.cost`，
   * 它只在解析模型时读一次。所以改价格要重新解析（服务端会做）。
   */
  /**
   * Hub 状态（M6）。**未配置是正常状态** —— 官方 Hub 上线前就是它，
   * 界面据此显示「筹备中」而不是一个红叉。
   */
  'hub.status': {
    input: Empty,
    output: z.object({
      configured: z.boolean(),
      hubUrl: z.string().nullable(),
      /** 公钥指纹（sha256 前 16 位）：换过 key 时能看出来 */
      keyFingerprint: z.string().nullable(),
    }),
  },
  /**
   * 从 Hub 装一个组件包。地址必须落在 Hub 源之下 —— 否则这个方法就是
   * "装任意 URL 上的代码"的入口。
   *
   * 装好之后会让装了它的应用重新激活（否则用户点了更新，界面上还是旧版本）。
   */
  'hub.install': {
    input: z.object({ bundleUrl: z.string().min(1) }),
    output: z.object({
      id: z.string(),
      version: z.string(),
      /** 装到了哪（本机路径，仅在服务端有意义） */
      dir: z.string(),
      keyFingerprint: z.string(),
      /** 被重新激活的应用数 */
      reloadedApps: z.number().int().nonnegative(),
    }),
  },

  'price.list': {
    input: z.object({ profileId: Id.optional() }),
    output: z.object({ prices: z.array(ModelPrice) }),
  },
  'price.set': {
    input: z.object({
      profileId: Id,
      modelId: z.string().min(1),
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
      cacheReadPerMTok: z.number().nonnegative().default(0),
      cacheWritePerMTok: z.number().nonnegative().default(0),
    }),
    output: z.object({ price: ModelPrice, applied: ModelState }),
  },
  'price.remove': {
    input: z.object({ id: Id }),
    output: z.object({ removed: z.boolean(), applied: ModelState }),
  },

  'provider.delete': {
    input: z.object({ id: Id }),
    output: z.object({ deleted: z.literal(true), applied: ModelState }),
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
