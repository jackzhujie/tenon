# PI-CHEATSHEET.md — pi 生态 API 速查

> 来源：`npm pack` 下载 11 个包并逐份阅读 README / 类型定义 / docs（2026-10-31，全部 1.4.0，除标注）。
> 用途：M1 起的开发速查。**以本文为准，不要凭印象写 API。**

## 0. 包清单与硬约束

| 包 | 版本 | 作用域 |
|---|---|---|
| `@earendil-works/pi-durable` | 1.4.0 | Harness、会话、任务、文档、提交、压缩、子 Agent |
| `@earendil-works/pi-ai` | 1.4.0 | 统一 LLM、provider、流式、用量 |
| `@earendil-works/chord` | 1.4.0 | 跨进程对象、插件 facet、状态复制、热重载 |
| `@earendil-works/pi-codemode` | 1.4.0 | QuickJS-WASM 沙箱（只能调注入的工具）|
| `@earendil-works/pi-telemetry` | 1.4.0 | 遥测契约 + 本地 trace/metrics |
| `@earendil-works/pi-mcp` | 1.4.0 | 独立 MCP 客户端 |
| `@earendil-works/pi-coding-agent` | 1.4.0 | read/bash/edit/write 工具 + session（可直接复用）|
| `@earendil-works/pi-agent-core` | 1.4.0 | 通用 agent + transport 抽象 |
| `@earendil-works/pi-protocol` / `pi-client` | 1.1.0 | 传输无关 CBOR framed 协议 |
| `@earendil-works/gondolin` | 0.14.0 | Alpine 微 VM 沙箱（需 QEMU；**Windows 无原生后端**）|

硬约束：
- 全部包 `engines.node >= 22.19.0` → Electron 39.8.9 内置 22.22.1 ✅
- `pi-durable` 包根会加载 TypeBox，未打包时峰值 RSS ~23MB（tree-shaken ~4MB）
- `chord` 用 **TypeBox** 描述契约，不是 zod（我们对外 RPC 仍用 zod，两层分工）

## 1. pi-durable 核心

### 1.1 打开与续跑

```ts
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const ctx = BACKGROUND_CONTEXT
const models = createModels()
models.setProvider(openaiProvider())                       // 读 OPENAI_API_KEY

const storage = await openNodeSqliteStorage('./session.sqlite', { prefix: 'pi_' })  // prefix 可选
const harness = await Harness.open(storage, { models, registry: createRegistry() }, ctx)

const root = await harness.root(ctx, { agent: { model: { provider: 'openai', modelId: '...' } } })
harness.resume()                                           // ★ 每个进程启动必须调用
```

### 1.2 提交输入与等待

```ts
const submission = await root.submit(
  { type: 'input', content: '...', requestId: 'greeting-1' },   // requestId = 幂等键
  ctx,
)
const settled = await submission.wait(ctx)
// settled.status: 'done' | 'unanswered'（含 reason）

// 重启后按 id 重新获取
const again = await harness.submission(id)
```

- `requestId` 相同 → 返回同一个 Submission（**这正是妙搭 idempotentKey 的等价物**）
- 取消 `wait` 只取消等待，不取消工作

### 1.3 会话形态

| 概念 | 说明 |
|---|---|
| **Conversation** | 一份不可变 entry 的 transcript；handle 无状态，按 `id` 比较 |
| **Entry** | 不可变记录：`pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system` / `pi.reset` / 自定义 |
| **Commit** | 原子写：追加 entry、改文档、建任务可同一事务 |
| **Document** | 与 transcript 并列的 typed JSON 状态，在 commit 里改 |
| **Task** | 每步存 checkpoint 的持久状态机，进程重启从最后一步继续 |
| **Extension** | 命名包：tools + system prompt sections + hooks + wrappers + tasks |
| **Agent** | 会话运行时的配置（model/thinking/extensions/tools/instructions/cwd），存 `pi.agent` |

内置文档：`pi.agent`、`pi.provider`、`pi.live`、`pi.inbox`、`pi.usage`。

一次输入的执行链：

```text
submit(input) → pi.user
  pi.generation → pi.system(仅当提示或工具变化) → pi.assistant(tool calls)
    pi.tool × n → pi.tool-result × n        (由 generation 拥有并等待)
  pi.generation → pi.assistant(answer) → submission done
```

### 1.4 每会话 Agent 配置

```ts
await root.configure({
  model: { provider: 'openai', modelId: 'gpt-6-sol' },
  thinkingLevel: 'high',
  extensions: { remove: [Coding] },       // 数组=精确选定；{remove:[...]}=删减
  tools: [readTool, bashTool],            // 数组=精确启用；{remove:[...]}=删减
  modelTools: [readTool],                 // 只给模型看这些，工具仍可调 bash
  instructions: 'Only read; never edit files.',
  cwd: '/work/repo',
}, ctx)

await root.configure({ tools: null }, ctx)   // null = 清回宿主默认
const agent = await root.agent(ctx)          // 已解析的 model/extensions/tools/sections/cwd
```

- 存储的是**名字**不是对象 → 卸载扩展后，选中它的会话只是暂时拿不到
- `createConversation()` / `fork()` / `root()` 接受同样的 `agent`
- 子 Agent 会话初始**复制**其 owner 会话的 agent

### 1.5 子 Agent（关键：幂等 + 所有权）

```ts
const Subagent: Extension = defineExtension({
  name: 'subagent',
  tools: [defineTool({
    name: 'subagent',
    description: '...',
    parameters: Type.Object({ task: Type.String() }),
    replay: 'safe',                       // ★ 崩溃重跑会命中同一子会话+提交
    execute: async (args, api, context) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
        if (existing) return existing.id                     // ★ 幂等复用
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
        await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } })
        return created.id
      }, context)

      await api.details({ conversationId: child }, context)   // 让 UI 能挂载子会话
      const req = { type: 'input', content: args.task, requestId: `subagent:${api.taskId}` } as const
      const settled = await (await (await api.conversation(child, context))!.submit(req, context)).wait(context)
      return { output: [{ type: 'text', text: settled.status }] }
    },
  })],
})
```

所有权语义：
- 中止调用 → 中止子会话；调用失败（抛错/非 replay-safe 崩溃）同样
- 父任务要等子任务空闲才 idle
- `{ background: true }` 创建的任务是边界：它拥有的工作**不受**父 abort 影响
- 后台子 Agent 模式：用 background anchor task 拥有子会话，用 background reporter task 把答案作为 follow-up 投回父会话，`requestId` 防止重启后重发

### 1.6 任务图（需求 8 的现成数据源）

```ts
const graph = await harness.taskGraph(ctx)
graph.subscribe(v => {
  for (const node of Object.values(v.tasks)) {
    // node.owner（task id 或 undefined）、node.status、node.background、node.conversationId
  }
})
harness.watchTaskGraph(ctx)   // 同值，watch 形式
```

状态：`pending` / `running` / `waiting`（带 `on` + `policy`）/ `completing`（带 held outcome）。
重启后曾 `running` 的显示为 `pending` 直到再次运行。

### 1.7 存储选型

| 后端 | 导入 | 注意 |
|---|---|---|
| Memory | 包根 `MemoryStorage` | 不落盘 |
| IndexedDB | `pi-durable/storage/indexeddb` → `IndexedDbStorage.open(name)` | **浏览器可用**（Web 模式依据）；单实例持有，用 Web Lock |
| SQLite | `pi-durable/storage/sqlite/node` → `openNodeSqliteStorage(file)` | WAL + `synchronous=NORMAL`；崩溃可存活，断电可能丢最后一次 |
| JSONL | `.../storage/jsonl/node` | 全历史驻内存，长跑用 SQLite |
| Cloudflare DO | `.../storage/sqlite/cloudflare` | 多实例自动共享操作队列 |

一个进程独占一个 storage，**无跨进程锁**。

### 1.8 错误三条铁律

1. **storage 错误终结 Harness**：后续调用与所有 pending wait 都以 `SessionFailed` 拒绝；`harness.closed` settle；需重开
2. **无效读只失败该次调用**（`StorageRequestError`）；但 `commit()` / `mintId()` 的任何错误按第 1 条处理
3. **你的代码只失败自己的单元**：task 抛错→该 task faulted；tool 抛错→返回错误结果；hook 抛错→上报并跳过（`beforeTool` 会阻断调用）；commit 回调抛错→回滚该 commit

## 2. chord 核心

### 2.1 心智模型

- **object** = 地址上的「状态 + 代码」，按需创建，有人引用就活着
- 所有人拿到**引用**，永远不是对象；引用跨进程、可跨重载存活
- 每个对象知道自己的 **principal**（owner / guest 拿到**不同的对象、不同的方法**）
- **state** 是可观察 JSON：远程订阅者先拿快照，再拿增量
- **热重载**：在飞的工作用旧代码跑完，状态保留，不兼容变更在安全点迁移
- 契约是运行时值，用 **TypeBox** 描述；宿主之间交换 JSON 帧（内存 / IPC / WebSocket）

### 2.2 最小闭环

```ts
import { Type } from 'typebox'
import { createHost, hostNamed, method, remote } from '@earendil-works/chord'

export const Counter = remote('demo.counter', {
  version: 1,
  input: Type.Object({ name: Type.String() }),
  host: hostNamed('server'),
  variants: {
    default: {
      state: { count: Type.Number() },
      methods: { increment: method(Type.Object({ by: Type.Number() })) },
    },
  },
})

const host = createHost({ name: 'server', self: { kind: 'server' } })

host.serve(Counter, ({ name }, principal, self) => {
  const count = self.state('count', Type.Number(), 0)
  return {
    variant: 'default',
    count,
    increment: async ({ by }, ctx) => { count.change(ctx, n => n + by) },
  }
})

await host.root(async (ctx) => {
  const c = await ctx.get(Counter, { name: 'clicks' })
  c.count.subscribe(n => console.log(n))
  await c.increment({ by: 2 }, ctx)
})
```

### 2.3 插件 facet（组件生态的落点）

```text
plugins/ai-assistant/
  contract.ts      # 对象 + 状态 + 方法 + 版本
  server.ts        # defineFacet((host) => { host.serve(...) })
  web.tsx          # 浏览器 facet
  worker.ts        # 可选后台 facet
```

```ts
export default defineFacet((host) => {
  host.serve(Conversation, conversationFactory, { linger: 30_000 })
  host.serve(Chat, chatFactory)
})

await host.load([
  new URL('../plugins/ai-assistant/server.ts', import.meta.url),
])

await host.reload([new URL('...', import.meta.url)])   // 热重载
```

facet 的 `setup` 参数（host）作用域仅限：`serve`、`name`、`root(fn)`、`registry(R)`、`signal`（本次装载被替换/移除时 abort）。

### 2.4 principal 与变体（= 收费组件授权模型）

contract 的 `variants` 里每个变体有自己的 state 形状与方法集。未授权 principal 落 `guest` 变体 → **服务端根本不存在 `ask` 方法**，前端改代码也没用。

### 2.5 传输与遥测

- `memoryLinkPair()` 同进程、`ipcLink()` Node IPC、`webSocketLink()` / `acceptWebSockets()` 跨机
- `chord/node`：`createHostManager`、`forkDriver`、`childControl`、`processLock`、`nodeLoader`
- `chord/telemetry-sqlite`：`createSqliteTelemetry(db, { retentionMs, maxQueuedSpans })`，默认保留 7 天、队列 1 万
- `chord/sqlite`：`openNodeSqliteDatabase`、`applySqliteMigrations`
- `chord/output`：`OutputBuffer`、`boundOutput`、`Progress`（渐进提交）—— 适合把命令输出流给 UI

## 3. 我们怎么用（决策）

| 需求 | 用什么 |
|---|---|
| 崩溃重放 / 上下文管理 / 模型记录 | `pi-durable`（`resume` + checkpoint + `pi.usage` + transcript）|
| 多 Agent 协同 | `pi-durable` 子会话（`ownership: {kind:'task'}` + `scanConversations` 幂等）|
| 组件/插件生态 | `chord`（contract + facet + principal + hot reload）|
| 应用状态面板（需求 8）| `harness.taskGraph()` + `chord` 复制态 |
| Agent 算数据 | `pi-codemode`（QuickJS，只能调注入工具）|
| 全链路追踪 | `pi-telemetry` + `chord/telemetry-sqlite` |
| 用户自带 MCP | `pi-mcp` |
| 文件/命令工具 | 直接复用 `pi-coding-agent` 的 read/bash/edit/write |
| 高档隔离 | `gondolin`（mac/Linux 有，**Windows 无**，见 DESIGN §15.3）|
