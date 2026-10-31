# DESIGN.md — 详细方案设计 v1.1

> 状态：已定稿，进入实施。本文档是本项目**唯一事实来源**，取代 `ARCHITECTURE.md` v0.1（Rust/Tauri 方案已废弃）。
> 输入：`PROTOCOL.md`（妙搭逆向规格）+ 用户 11 条需求（2026-10-31）+ v1.1 定案（DB/插件/平台/命名）。
> 原则：clean-room —— 只借鉴行为规格与交互范式，不复制字节的代码、文案、资源、提示词。

## 0. 结论摘要（先看这张表）

| # | 议题 | 结论 |
|---|---|---|
| 0 | 产品名 | **Tenon（榫）** —— 详见 §1.5 命名说明 |
| 1 | 桌面框架 | **Electron 39.x**（内置 Node 22.22.1），放弃 Rust |
| 2 | 业务进程形态 | 所有业务逻辑在**本地 HTTP 服务**里，Electron 只是壳 → 同一套代码可 Web 打开、可被 Agent 直接调试 |
| 3 | Agent 运行时 | `pi-durable` 1.4（Harness/任务图/子会话/压缩/重放）+ `pi-ai` 1.4（BYOK）+ `chord` 1.4（**插件宿主基座**）+ `pi-codemode`（代码沙箱）|
| 4 | Agent 应用栈 | React 19 + shadcn/ui + Tailwind 4 + Vite 7 + TS ESM；Node 22 |
| 5 | 生成应用栈 | 前端同上（+ React Router 7 + TanStack Query + zod）；后端 **NestJS 11 + TypeORM + PostgreSQL** |
| 5b | 数据库供给 | 应用只认**一个 Postgres 连接串**；供给由平台决定：`embedded`（真 PG 二进制，默认）/ `docker` / `external` / 降级 `sqlite` —— 详见 §6.4 |
| 5c | 组件与插件 | **chord 插件模型**：一 feature 一 contract + 每宿主一 facet；免费/收费组件走同一套安装协议 —— 详见 §21 |
| 6 | 版本管理 | **Git**（isomorphic-git）：每轮改动自动 commit，发布时 push + tag；回滚 = revert + 可选 DB 快照还原 |
| 7 | 发布 | 生成 **Docker 产物**（多阶段构建、单容器单端口，compose 内含 PostgreSQL）+ 可选静态导出 |
| 8 | 预览 | 每应用一个 **App Gateway**（稳定端口）→ Vite dev server + Nest，HMR 走 WS 代理 |
| 9 | 精调 | 注入式 inspector：点选元素 / 框选区域 → 源码定位（file:line + 组件栈）+ 截图 → 注入对话 |
| 10 | 可观测 | chord 复制态 + `pi-telemetry` 跨度/指标 + 运行时探针（console/error/network/route）→ 面板 + 错误入库 + 一键修复 |
| 11 | 记忆 | 每个应用仓库内 `docs/AGENTS.md` + `.tenon/memory/*` ，Agent 有读写纪律 |
| 12 | 协议 | **AGPL-3.0-only**（Tenon/Server）+ **Apache-2.0**（Runtime SDK / 模板 / 生成物骨架）+ 商业双许可 |
| 13 | 首发平台 | **macOS（ARM64/x64）+ Windows（x64）**；Linux 作为次优先目标随 M5 补齐 |
| 14 | 免费策略 | **个人免费**（含全部核心能力）；企业为协作/合规付费；**组件市场**区分免费与收费组件 |

---

## 1. 产品定位与范围

### 1.1 一句话

**本地优先、开源、可自托管的对话式 AI 全栈应用搭建平台**：用自然语言把一个可运行、可版本化、可 Docker 部署的全栈应用从 0 做到上线，并且这个应用能被 Agent 持续迭代。

### 1.2 与妙搭的对照

| 能力 | 飞书妙搭 | 本项目 |
|---|---|---|
| 形态 | 云端 Web | **Electron 桌面 + 可 Web 打开（同构）** |
| 生成本体 | 独立容器（VEFaaS） | 本地应用目录 + 独立 dev 进程 |
| 前端栈 | React + Vite + Tailwind + shadcn | **完全一致**（全部开源件） |
| 后端 | 飞书云 PostgreSQL | **NestJS + PostgreSQL**（同一方言，dev 与 prod 一致） |
| Agent | 自研多 Agent（6 角色） | **pi-durable 多会话/子 Agent，复刻 6 角色划分** |
| 版本 | 沙箱内 Git + checkpoint | **Git 一等公民**：commit ↔ 对话轮次 ↔ 回滚 |
| 发布 | 飞书服务器 + 范围发布 | **Docker 镜像 / compose / 静态导出 / Git push** |
| 登录 | 飞书 SSO | 本地无账号；Web 模式可选单用户 Token |
| 计费 | 平台额度 | **BYOK**，本地统计 token/成本，可设预算熔断 |

### 1.3 非目标（本期明确不做）

- 多租户 SaaS 托管、企业 SSO、跨组织协作（pi-durable 具备多人能力，但产品层后置）
- 移动端原生 App 生成
- 可视化拖拽搭页面（我们走「对话 + 精调」，不做低代码画布）
- 兼容妙搭协议 / 导入妙搭应用（避免商标与法律风险）

### 1.4 目标用户

| 用户 | 诉求 | 我们的取舍 |
|---|---|---|
| 独立开发者 / 小团队 | 一句话出可用内部系统，能改、能部署 | **首要目标**：代码可读、结构标准、随时接管 |
| 业务人员 | 不写代码做工具 | 次要：默认路径不暴露代码，靠对话与精调 |
| Agent 自身 | 能开浏览器调试、能读代码、能跑测试 | **一等公民**：Web 模式 + 全 RPC 可编程 |

### 1.5 命名：Tenon（榫）

**中文名「榫」，英文名 `Tenon`，全称"榫卯工坊"仅作副标题。** 代码代号 `tenon`，包作用域 `@tenon/*`。

选择理由（不是随手起的名字，是本项目架构的隐喻）：

| 榫卯的特征 | 本项目的对应 |
|---|---|
| 不用钉子，靠构件**咬合**承重 | 应用不靠"大而全的框架"，靠标准化的 **contract** 咬合（chord 模型）|
| **榫头**（凸）插入**卯眼**（凹），尺寸必须精确匹配 | 插件是榫头、应用是卯眼；**contract schema 就是尺寸公差** |
| 同一套工艺能造桌椅门窗，形制千变 | 同一套 runtime 能生成点餐系统、CRM、看板；差异在组件组合 |
| 可拆卸重装，不损伤木料 | 插件可热插拔、可热重载，状态不丢（chord hot reload）|
| 匠人手工放样，机器只做标准件 | **Agent 是匠人**（设计与搭接），**代码生成器是机床**（出标准件）|

避讳检查：与「妙搭 / Miaoda / 飞书 / Lark / aPaaS」无任何语音、字形、语义关联；当前无同品类开源项目使用；商标可在中英文分别申请。

> 备注：`tenon.io` 为国外小众无障碍检查 API，属不同类别（非开发者工具），风险可接受。若后期商标受阻，备选为 `Mortise`（卯）/ `Kiln`（窑）/ `Weft`（纬）。域名与 npm scope 在 M1 启动前一次性确认。

---

## 2. 总体架构

### 2.1 分层

```mermaid
flowchart TB
  subgraph Shell["Electron 39 壳（薄）"]
    M["main：窗口/菜单/托盘/自动更新<br/>spawn 子进程 · 只做原生能力"]
    P["preload：注入 baseUrl + token<br/>暴露原生桥"]
  end

  subgraph Web["Tenon Web App（React 19 + shadcn）"]
    UI["会话流 · 预览台 · 计划 · 文件 · 日志 · 版本 · 设置"]
  end

  subgraph Server["Tenon Server（Node 22 + Fastify 5，本地 127.0.0.1）"]
    RPC["RPC + SSE 事件总线"]
    HARNESS["Agent Runtime<br/>pi-durable Harness 池"]
    GEN["代码生成器 / 模板引擎"]
    GIT["Git 服务（isomorphic-git）"]
    PREV["预览编排（App Gateway）"]
    OBS["可观测管道"]
    EXP["导出（Docker / 静态）"]
    DB[("tenon.db<br/>应用注册 / 设置 / 版本")]
  end

  subgraph App["生成的应用（每应用独立目录 + 独立进程）"]
    G1["App Gateway :41xxx"]
    V["Vite dev server（前端 + HMR）"]
    N["NestJS（API）"]
    D["PostgreSQL（embedded / docker）"]
  end

  subgraph Pi["pi 生态"]
    PIA["pi-ai：多提供商 LLM"]
    PID["pi-durable：checkpoint / resume / 子 Agent / 压缩"]
  end

  UI <-->|"HTTP + SSE"| RPC
  M -->|"spawn ELECTRON_RUN_AS_NODE=1"| Server
  P --> UI
  RPC --> HARNESS
  HARNESS --> PID
  HARNESS --> PIA
  HARNESS --> GEN
  HARNESS --> GIT
  RPC --> DB
  PREV --> G1
  G1 --> V
  G1 --> N
  V -.->|"探针事件"| OBS
  N -.->|"stdout/JSON 日志"| OBS
  OBS --> HARNESS
```

### 2.2 三种运行形态（同一套代码）

| 形态 | 启动 | 进程模型 | 端口 | 用途 |
|---|---|---|---|---|
| **桌面** | `pnpm dev` / 安装包 | main spawn 子进程跑 server | 随机 127.0.0.1 端口 + Bearer Token | 最终用户 |
| **Web** | `pnpm dev:web` | `node` 直接跑 server + Vite 渲染器 | 5173（渲染器）/ 5174（server） | **Agent 调试、E2E、远程预览** |
| **Headless** | `node dist/server/index.js` | 纯 server | 同上 | CI / 集成测试 / 二次开发 |

**关键设计：Electron 不做业务。**

- server 以**独立子进程**运行：`spawn(process.execPath, [serverEntry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`
  - 不额外打包 Node 运行时（复用 Electron 内置的 22.22.1）
  - server 崩溃不影响窗口，自动重启 + 现场恢复（pi-durable `resume()`）
- 渲染器只认一个 `window.__STUDIO__ = { baseUrl, token, platform, version }`，**Electron 与浏览器走完全相同的代码路径**
- 这样「Web 打开」不是附加功能，而是**架构的自然结果**；Agent（包括我）可以用浏览器/HTTP 直接驱动产品，读 DOM、截图、跑流程

### 2.3 为什么这样分

| 备选 | 问题 |
|---|---|
| 业务逻辑写在 Electron main（IPC） | Web 形态要重写一遍；main 崩溃=整个 App 崩；Agent 无法驱动 |
| server 内嵌 main 进程 | 同上崩溃隔离问题；Electron Node 版本受 Chromium 升级节奏约束 |
| 只做 Web（不套壳） | 用户要桌面级体验（文件对话框、托盘、自动更新、离线） |

---

## 3. 技术栈与仓库结构

### 3.1 版本基线

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Node.js | **≥ 22.19**（pi-durable 硬要求） | Electron 39.8.9 内置 22.22.1，满足 |
| 包管理 | pnpm workspaces | 10.x | `packageManager` 字段锁定 |
| 语言 | TypeScript | 5.9+ | 全仓 ESM（`"type": "module"`） |
| 桌面 | Electron + electron-vite + electron-builder | 39.x | electron-vite 提供三端 HMR |
| Tenon 服务 | Fastify | 5.x | `@fastify/websocket`、`@fastify/static`、`@fastify/cors`(仅 web 模式) |
| Tenon 前端 | React 19 + Vite 7 + Tailwind 4 + shadcn/ui | — | Radix、lucide、sonner、motion |
| 状态 | TanStack Query + Zustand + TanStack Virtual | — | 服务端状态与 UI 状态分离；长列表虚拟化 |
| 代码展示 | Monaco Editor | — | 只读 + Diff（M2 起） |
| Agent | `@earendil-works/pi-durable` / `pi-ai` | **精确锁定 1.4.x** | `save-exact`；用 adapter 包一层隔离升级 |
| 插件宿主 | `@earendil-works/chord` | **精确锁定 1.4.x** | plugin facet、状态复制、principal 授权 |
| 契约 | zod（我们）+ TypeBox（chord） | 4.x / 1.3.x | zod 用于 RPC；TypeBox 用于 chord contract（其运行时要求）|
| Git | isomorphic-git | 1.x | 纯 JS 无原生依赖；检测到系统 git 时可切换 |
| 产品库 | better-sqlite3 | 12.x | `tenon.db` / `harness.sqlite` / `telemetry.db`（单机注册表，零安装）|
| 应用库 | **PostgreSQL 18**（typeorm + pg） | 18.x | `embedded-postgres`（默认）/ docker / external / pglite 降级 —— 见 §6.4 |
| 日志 | pino | 9.x | 结构化、可被探针管道消费 |
| 测试 | Vitest + Playwright | — | 单测 + Agent E2E |

### 3.2 仓库结构

```
tenon/
├── apps/
│   ├── web/                      # Tenon 渲染器（纯 Web 应用，React）
│   │   ├── src/
│   │   │   ├── app/              # 路由与外壳
│   │   │   ├── features/         # chat / preview / plan / files / logs / versions / settings
│   │   │   ├── components/       # shadcn 基础件 + 业务组件
│   │   │   ├── hooks/
│   │   │   ├── lib/              # rpc client, sse client, transport
│   │   │   └── styles/
│   │   └── vite.config.ts
│   └── desktop/                  # Electron 壳（不含业务）
│       ├── src/main/             # 窗口、server supervisor、菜单、更新
│       ├── src/preload/
│       └── electron-builder.yml
├── packages/
│   ├── protocol/                 # ★ zod 契约：RPC 入参出参、SSE 事件、领域类型
│   ├── server/                   # Fastify 应用装配、路由、SSE 总线
│   ├── core/                     # 领域服务：应用注册、文件、Git、预览、导出
│   ├── agent/                    # pi 集成：harness 池、扩展、工具、6 角色、模型档位
│   ├── generator/                # 模板渲染 + 代码生成（AST 级补丁）
│   ├── component-host/           # ★ chord 宿主：facet 加载、principal 解析、插槽装配
│   ├── component-market/         # ★ 组件仓库客户端、manifest 校验、license 校验、本地缓存
│   ├── db-provisioner/           # ★ PG 四档供给（embedded/docker/external/lite）
│   ├── runtime-sdk/              # 注入生成应用的探针 / inspector / 数据客户端
│   └── ui/                       # 共享设计系统（shadcn 之上）
├── components/                   # ★ 官方组件源码（L2）
│   ├── ai-assistant/             # contract + server + web + manifest
│   ├── excel-export/
│   └── approval-flow/
├── templates/
│   └── fullstack-react-nest/     # 生成应用模板（可多套，按风格/场景）
├── docs/
└── pnpm-workspace.yaml
```

**依赖方向（禁止反向）**：`protocol` ← 全部；`server → core → agent/generator`；`web → protocol`（不直接依赖 core）。

### 3.3 关键脚本

```jsonc
{
  "dev":        "pnpm -r --parallel dev",              // Electron + server + web
  "dev:web":    "pnpm --filter server dev & pnpm --filter web dev",  // 浏览器形态（Agent 用）
  "build":      "pnpm -r build && electron-builder",
  "test":       "vitest run",
  "e2e":        "playwright test",
  "lint":       "biome check ."                        // 统一格式化/静态检查
}
```

---

## 4. Core Runtime：pi 生态集成

> 本节结论基于**实际下载并阅读十一个包的类型定义与文档**（2026-10-31，版本号见下表），非推测。

### 4.1 角色分工（全量 11 个包）

| 包 | 版本 | 承担的职责 | 我们的用法 |
|---|---|---|---|
| `pi-ai` | 1.4.0 | 统一多提供商 LLM、流式事件、token/成本统计、模型发现 | 把用户 BYOK 配置映射成 `Models`；按三档位路由模型 |
| `pi-durable` | 1.4.0 | 持久化 Harness：会话/任务/文档/提交、checkpoint、resume、压缩、子 Agent、任务图、用量 | **整套 Agent 运行时**，我们只写扩展与工具 |
| `chord` | 1.4.0 | 跨进程对象宿主机：contract（TypeBox）、state 复制、principal 权限、**热重载**、插件 facet | **插件与组件生态的基座**；也承载应用运行时的可观测状态 |
| `pi-codemode` | 1.4.0 | QuickJS-WASM 沙箱，唯一能力是调用注入的工具 | 给 Agent 一个「算数据/批处理」的代码执行环境（不碰 FS） |
| `pi-telemetry` | 1.4.0 | 与厂商无关的遥测契约 + 本地 trace/metrics API | 全链路追踪（对话 → 工具 → 生成 → 预览）|
| `pi-mcp` | 1.4.0 | 独立 MCP 客户端 | 让用户挂自己的 MCP 服务（数据库、内部系统）|
| `pi-coding-agent` | 1.4.0 | 现成的 read/bash/edit/write/glob/grep 工具与 session 管理 | **直接复用其工具实现**，不重复造 |
| `pi-agent-core` | 1.4.0 | 通用 agent + transport 抽象 + 状态机 | 需要脱离 Harness 的轻量 agent（如后台索引器）|
| `pi-protocol` / `pi-client` | 1.1.0 | 传输无关的 CBOR framed 协议 + 客户端 | 远程/多端场景（Web 协作、远程预览）|
| `gondolin` | 0.14.0 | Alpine Linux 微 VM（QEMU/krun）+ TS 实现的网络栈与虚拟 FS | **可选高档隔离**，见 §15.3 的平台差异说明 |
| `pi-tui` / `pi-server` | — | 终端 UI / 实验性服务端 | 仅参考实现，不直接依赖 |

四条**已验证**的关键约束：

1. `pi-durable` storage 支持 SQLite / JSONL / **IndexedDB** / Memory / Cloudflare DO —— IndexedDB 意味着**浏览器里就能跑完整 Harness**，这是 Web 模式的技术依据，不是设想。
2. `harness.taskGraph()` / `watchTaskGraph()` 直接把所有活任务（含子会话）作为**一个 Chord 可复制状态**吐出 —— 需求 8「捕获应用状态并展示」的现成数据源。
3. 子 Agent 用 `tx.createConversation({ ownership: { kind:'task', taskId } })` + `scanConversations({ ownerTaskId })` 幂等复用，工具标 `replay:'safe'` 后崩溃重跑会命中同一个子会话与提交 —— 这解决了"崩溃重放"在子 Agent 场景的重复创建问题。
4. `chord` 的 **principal（owner/guest 得到不同对象、不同方法）** 天然就是收费组件的授权模型：未购买 = guest，方法集裁剪，而非"前端藏按钮"。


### 4.2 模型接入（BYOK）

```ts
// packages/agent/src/models.ts
import { createModels } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'

export function buildModels(profiles: ProviderProfile[]): Models {
  const models = createModels()
  for (const p of profiles) {
    if (p.kind === 'builtin') models.setProvider(providerFor(p.id)())     // openai/anthropic/deepseek/zai/moonshot/...
    else models.setProvider(createProvider({ id: p.id, ...openAICompletionsApi({ baseURL: p.baseURL }) }))  // 任意 OpenAI 兼容（Ollama/vLLM/LM Studio）
  }
  return models
}
```

**三档模型路由**（对齐妙搭 `fast / comprehensive / thinking`）：

| 档位 | 用途 | 默认建议（用户可改） |
|---|---|---|
| `fast` | 检索、文件定位、简单问答、标题生成 | DeepSeek Flash / GLM Flash / Haiku 级 |
| `comprehensive` | 主开发 Agent、代码生成、E2E | Sonnet 级 / GPT-5 级 / DeepSeek Pro / Qwen-Max |
| `thinking` | 架构设计、归因审查、疑难 Bug | 推理模型（o 系 / Claude thinking / GLM 高思考档） |

每档可指定「提供商 + modelId + 参数」，**未配置的档位回退到 `comprehensive`**，全空则引导进入设置向导。

**成本与预算**：`harness.usage()` 给出按模型/工具聚合的用量，落 `tenon.usage` 文档；设置里可配「每应用每日 token/金额上限」，超限时在 `submit` 前拦截并提示。

### 4.3 持久化 Harness（每应用一个）

```ts
// packages/agent/src/pool.ts（示意）
const storage = await openNodeSqliteStorage(join(appDir, '.tenon/harness.sqlite'))
const harness = await Harness.open(storage, {
  models: buildModels(profiles),
  registry,                                  // 工具 + 扩展
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? appDir }),
  settings: {
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 },
    retry: { maxRetries: 3 },
    stream: { timeoutMs: 120_000 },
    toolExecution: 'parallel',
    contextRetentionMs: 600_000,
  },
}, ctx)

const root = await harness.root(ctx, { agent: { model: tier('comprehensive') } })
await harness.resume()          // ★ 每个进程启动必须调用：续跑未完成任务
```

- **会话池**：LRU 保持 N 个应用 harness 打开（默认 3），其余按 `contextRetentionMs` 回收；`close` 前确保 `commit` 落盘
- **崩溃恢复**：子进程重启 → `Harness.open` + `resume()` → 未完成 generation/tool 继续；模型半截回答保留并标记 aborted
- **工具重放策略**：只读类工具标 `replay: 'safe'`（读文件、搜索、查询）；写文件/跑命令/发布**绝不**标记，崩溃后交回模型决策

### 4.4 妙搭概念 → pi-durable 原语（映射表）

| 妙搭（逆向所得） | 本项目实现 | 说明 |
|---|---|---|
| `AsyncChat` + `idempotentKey` | `conversation.submit({ type:'input', content, requestId })` | requestId 即幂等键，重启重投命中同一 Submission |
| 暂存队列（上限 10、`immediateExecute` 插队） | `whenBusy: 'follow-up' \| 'steer' \| 'reject'` | `steer` = 插话引导（插队），`follow-up` = 排队；上限 10 由 UI 层约束 |
| `StopChat` | `harness.abortTask(id)` / 会话 abort（封装在 adapter） | 停止后保留已产出内容与工具结果 |
| `GetStreamingStatus` | `watchEvents` 的 snapshot | 断线重连时先回放快照再续流 |
| Spec（`init_spec.json`/`spec.md`） | `defineDoc('tenon.spec')` | 结构化状态，原子提交 |
| 开发计划任务清单（`pro_sub_task`） | `defineDoc('tenon.plan')` + 子 Agent 的 Task 图 | 计划是文档，执行是任务 |
| Checkpoint / `resetArtifactVersion` | `harness` fork + Git commit + DB 快照 | 见 §12 |
| 6 个内置 Agent | 主会话 + 5 个子会话（`tx.createConversation`） | 见 §5 |
| `cotGroup` 思维链分组 | `thinking_start/delta/end` 事件 | 前端折叠渲染 |
| 沙箱 `bizStatus` 分维度 ready | App Gateway 的 `readiness` 对象 | `deps/preview/server/ready` 四态 |
| 统一信封 `{data,status_code}` | RPC 统一 `{ ok, data } / { ok:false, error }` | 见 §7.4 |

### 4.5 事件流（渲染器的生命线）

```ts
const stream = await watchEvents(harness, root.id, ctx)
initialize(stream.snapshot)                       // entries / run / in-flight generation / tools / usage
stream.start(events => bus.publish(appId, events)) // → SSE 推给前端
```

前端把事件归约为 UI 状态（见 §15.4）。**不要**用轮询；**不要**让前端直接读 harness 存储。

---

## 5. Agent 体系

### 5.1 角色（复刻妙搭 6 角色，落地为 1 主 + 5 子）

| 角色 | 会话类型 | 档位 | 工具集（要点） | 触发 |
|---|---|---|---|---|
| **Builder**（主） | 根会话 | comprehensive | 全部写入类工具 + `subagent` | 用户每次发言 |
| **Explore** | 前台子会话 | fast | 只读：`list/read/glob/grep/sql_query` | 定位代码、查库结构、看日志 |
| **CodeAct** | 前台子会话 | comprehensive | `codemode`（脚本沙箱）、`bash`（受限） | 批量转换、数据导入、一次性探查 |
| **Librarian** | 前台子会话 | fast | 只读 + `docs_search` | 查框架文档/项目约束，减少返工 |
| **E2E** | 后台子会话 | comprehensive | `preview.open/screenshot/click/type/assert` | 生成后自验收 |
| **Reviewer** | 前台子会话 | thinking | 只读 + `git_diff` + `typecheck/lint` | 提交前审查，出风险清单 |

实现要点（pi-durable 已验证的模式）：

```ts
defineTool({
  name: 'subagent',
  parameters: Type.Object({ role: Type.Union([...]), task: Type.String() }),
  replay: 'safe',                       // 崩溃重跑能找到同一子会话与子提交
  execute: async (args, api, ctx) => {
    const child = await api.commit(async tx => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]
      if (existing) return existing.id                       // 幂等复用
      const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
      await configure(tx, created.id, { model: tierFor(args.role), tools: toolsFor(args.role), instructions: PROMPT[args.role] })
      return created.id
    }, ctx)
    await api.details({ conversationId: child }, ctx)          // 让 UI 能挂到子会话
    const settled = await (await (await api.conversation(child, ctx))!.submit(
      { type: 'input', content: args.task, requestId: `subagent:${api.taskId}` }, ctx)).wait(ctx)
    return { output: [{ type: 'text', text: settled.status }] }
  },
})
```

### 5.2 工具清单

| 组 | 工具 | 副作用 | 审批 |
|---|---|---|---|
| 文件 | `fs_list` `fs_read` `fs_write` `fs_edit` `fs_delete` `fs_move` | 写 | 删除/移动需确认 |
| 检索 | `grep` `glob` `code_search`（AST 符号） | 无 | — |
| Git | `git_status` `git_diff` `git_commit` `git_log` `git_revert` `git_branch` | 写 | revert 需确认 |
| 规格 | `spec_read` `spec_write` `plan_update` | 文档 | — |
| 构建 | `typecheck` `lint` `test` `build` | 子进程 | — |
| 运行 | `dev_start` `dev_restart` `dev_stop` `dev_logs` | 子进程 | — |
| 预览 | `preview_screenshot` `preview_open` `preview_click` `preview_type` `preview_assert` | 浏览器 | — |
| 数据 | `db_schema` `db_query`（只读） `db_migrate` `db_seed` | 写 | migrate 需确认 |
| 可观测 | `runtime_errors` `runtime_logs` `perf_snapshot` | 无 | — |
| 记忆 | `memory_read` `memory_write` `agents_md_update` | 文档 | — |
| 交付 | `docker_export` `publish_push` | 外部 | **必须审批** |
| 编排 | `subagent` `ask_user` | — | — |
| 脚本 | `codemode`（JS 沙箱） | 沙箱内 | — |

**安全钩子**（pi-durable `hook(ToolTask, beforeTool)`）：

```ts
hook(ToolTask, {
  beforeTool: call => {
    if (DANGEROUS.has(call.name) && !call.approved) return { block: '需要用户确认' }
    if (call.name === 'fs_write' && outsideApp(call.args.path)) return { block: '路径越界' }
  },
})
```

### 5.3 上下文与提示分层

pi-durable 的 `section()` 组合系统提示，**按变更频率分层**，最大化缓存命中：

| 层 | 内容 | 变化 |
|---|---|---|
| L0 静态 | 产品职责、工具契约、代码规范、禁止事项 | 极少 |
| L1 项目 | `docs/AGENTS.md`（架构、约定、坑）、`tenon.spec`、`tenon.plan` | 每轮可能变 |
| L2 会话 | 用户偏好（风格预设、语言、组件库）、最近选择元素 | 每次会话 |
| L3 动态 | 环境信息（cwd、端口、依赖版本）、当前错误摘要 | 每次任务 |

压缩策略：`compaction.enabled=true`，上下文达 `contextWindow - reserveTokens` 时后台压缩，保留最近 20k token 原文；压缩前把**决策与约定**写入 `AGENTS.md`，避免压缩丢失长期信息。

### 5.4 记忆与持续开发（需求 10）

每个应用仓库自带（随 Git 版本化）：

```
docs/
├── AGENTS.md          # ★ 项目的"长期记忆"：架构、域模型、约定、坑、运行方式
├── decisions/         # ADR：0001-选择-postgresql.md、0002-组件装配 …
└── spec/
    ├── spec.md        # 功能规格（人读）
    └── plan.md        # 开发计划与进度（人读镜像）
.tenon/
├── spec.json          # 结构化规格（defineDoc 快照导出）
├── plan.json          # 任务清单镜像
├── memory/
│   ├── learnings.md   # 追加式经验（每次踩坑/决策）
│   └── glossary.md    # 业务术语表
└── harness.sqlite     # pi-durable 状态（.gitignore）
```

**纪律（写进 L0 提示，并有工具强制）**：

- 改动架构/目录/依赖 → 必须更新 `AGENTS.md` 对应小节（`agents_md_update` 工具会校验小节完整性）
- 做了非显然的技术选择 → 追加一条 ADR
- 用户纠正过一次的错误 → 写进 `learnings.md`（下次自动注入最近 20 条）
- 发布前检查：`AGENTS.md` 与代码是否一致（`Reviewer` 子 Agent 负责）

---

## 6. 数据模型与存储

### 6.1 文件布局

```
~/.tenon/                           # 可用 TENON_HOME 覆盖
├── tenon.db                        # 产品库：应用注册、设置、发布记录（SQLite，与业务 DB 无关）
├── apps/
│   └── <appId>/
│       ├── repo/                   # ★ Git 工作区（生成应用全部代码与文档）
│       ├── .tenon/
│       │   ├── harness.sqlite      # pi-durable 状态（会话/任务/文档）
│       │   ├── runtime/*.jsonl     # 运行时事件（按天轮转，保留 7 天）
│       │   ├── telemetry.db        # pi-telemetry 跨度与指标（chord/telemetry-sqlite）
│       │   └── cache/              # 依赖缓存、截图、构建产物
│       ├── pgdata/                 # ★ embedded Postgres 数据目录（供给方式 = embedded 时）
│       └── exports/<releaseId>/    # Docker 上下文 / 静态包
└── models.json.enc                 # 加密的提供商配置（Electron 走 safeStorage）
```

> 为什么产品库用 SQLite、应用库用 PostgreSQL：**两者不是一件事**。产品库是单机注册表（低并发、强一致、要零安装），SQLite 最合适；应用库是**用户业务数据**，要支持并发写、复杂查询、迁移与生产一致性，必须是 PostgreSQL。妙搭同样如此（产品侧与生成应用侧分离）。
> 为什么「每应用一个 harness.sqlite」：隔离故障与体积，删除应用=删目录；跨应用共享的只有 `tenon.db`。


### 6.2 tenon.db

```sql
CREATE TABLE apps (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  template_id TEXT NOT NULL, style_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',        -- idle|running|error|archived
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_opened_at INTEGER
);
CREATE TABLE releases (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version TEXT NOT NULL, commit_sha TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- docker|static|push
  artifact_path TEXT, image_ref TEXT, notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,  -- builtin|openai-compatible
  base_url TEXT, api_key_enc BLOB, tier TEXT, model_id TEXT, params_json TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE error_groups (                     -- 错误聚合（指纹去重）
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL, message TEXT, count INTEGER DEFAULT 1,
  first_seen INTEGER, last_seen INTEGER, resolved_at INTEGER, payload_json TEXT
);
```

### 6.3 pi-durable 文档（应用级结构化状态）

| Document | scope | 内容 | history |
|---|---|---|---|
| `tenon.app` | conversation(root) | 名称、描述、风格预设、路由清单、技术选型 | latest |
| `tenon.spec` | root | 功能规格（模块/实体/接口/验收标准） | rewindable |
| `tenon.plan` | root | 任务列表：id/title/status/owner(子会话)/commit | rewindable |
| `tenon.selection` | root | 最近一次点选/框选的上下文（供 UI 与 Agent 共用） | latest |
| `tenon.usage` | root | token/成本累计、预算 | latest |
| `tenon.preview` | root | 端口、readiness、最近错误摘要 | latest |

`rewindable` 的意义：任意历史时刻的规格与计划都可读回（对应妙搭的 spec 版本）。

### 6.4 数据库供给策略（PostgreSQL 是默认，不是可选项）

**设计原则：应用代码只认一个 `DATABASE_URL`。** 生成的 NestJS 代码里没有任何"我跑在桌面还是 Docker"的判断，供给方式完全由平台层决定。这一条是硬约束 —— 一旦应用代码开始关心运行环境，导出就必然破。

| 供给模式 | 何时使用 | 实现 | 性能 | 依赖 |
|---|---|---|---|---|
| **`embedded`**（默认）| 桌面本地开发 | `embedded-postgres` 18.6，下载官方 PG 二进制，在应用专属端口（13000+hash）拉起，数据落 `pgdata/` | **= 真 PG** | 无（首次自动下载 ~30MB）|
| `docker` | 用户已装 Docker，或需要与生产完全一致 | `docker run postgres:18-alpine`，命名卷持久化 | = 真 PG | Docker |
| `external` | 企业接入已有 PG / RDS | 直接使用用户提供的连接串，只做连通性与版本校验 | 取决于服务端 | 用户自备 |
| `lite`（降级）| 一句话生成的小应用、演示、CI | `@electric-sql/pglite` 0.5 + `pg-gateway`，把 WASM PG 暴露成 TCP 端口 | 中等（单连接，并发受限）| 无（3.7MB gzipped）|

四条实现要点：

1. **对应用永远是真 PG 协议。** 即使 `lite` 模式也通过 `pg-gateway` 暴露 TCP，TypeORM 走标准 `pg` driver。所以「lite 演示 → 升级到 embedded/docker」**不需要改一行代码、不需要改 migration**，只换端口。
2. **端口与生命周期归 App Gateway 管**（见 §9）。Gateway 在应用启动时按 manifest 拉起 DB → 等 `pg_isready` → 注入连接串 → 起 Nest。DB 崩溃由 Gateway 重启并上报状态，前端能在 readiness 面板看到 `db: down`。
3. **迁移与快照。** TypeORM migration 是唯一 schema 事实来源；每次发布前 `pg_dump --format=custom` 存快照到 `exports/<releaseId>/db.dump`，回滚时可 `pg_restore`（对应妙搭 `resetArtifactVersion` 的 `dbRestore` 开关）。`lite` 模式用 `pg_dump` 的 SQL 纯文本替代（PGlite 不支持 custom 格式）。
4. **Docker 导出产物自带 PostgreSQL。** `docker-compose.yml` 里 `db`（postgres:18-alpine + 健康检查 + 命名卷）+ `app`（NestJS 单容器，`depends_on: service_healthy`）。用户 `docker compose up -d` 即上线，不需要外部数据库。

> **为什么之前写 SQLite 是错的**：需求里明确要"高性能应用 + 通用组件 + 未来 AI 小助手"，这些都指向真 PG（并发写、`pgvector`、行级锁、`LISTEN/NOTIFY`）。SQLite 在多写并发与扩展生态上是硬短板，且切库要重写 migration —— 早期省一天，后期赔一周。已改，旧方案见附录 A。

---

## 7. API 契约

### 7.1 单一契约包

`packages/protocol` 用 zod 定义，服务端做校验、前端拿类型、**生成应用的 shared schema 复用同一套写法**（保持心智一致）。

```ts
export const ChatSubmitInput = z.object({
  appId: z.string(),
  content: z.string().min(1),
  parts: z.array(MessagePart).default([]),      // 文件引用、图片、错误上下文
  selection: SelectionContext.optional(),        // 点选/框选注入
  whenBusy: z.enum(['follow-up', 'steer', 'reject']).default('follow-up'),
  requestId: z.string(),                         // 幂等键（前端生成 uuid）
  modelTier: z.enum(['auto', 'fast', 'comprehensive', 'thinking']).default('auto'),
})
```

### 7.2 RPC 列表（M1 范围）

| 方法 | 入参要点 | 返回 |
|---|---|---|
| `app.list` / `app.get` | — / `id` | 应用摘要 / 详情 |
| `app.create` | `name, prompt?, templateId, styleId` | `{ appId }`（后台开始生成） |
| `app.delete` | `id` | — |
| `chat.submit` | 见上 | `{ submissionId }` |
| `chat.stop` | `appId` | — |
| `chat.history` | `appId, cursor` | 归一化消息列表 |
| `plan.get` / `plan.update` | `appId` | 任务清单 |
| `files.tree` / `files.read` / `files.write` | `path` | 文件内容（带 etag） |
| `git.log` / `git.diff` / `git.commit` / `git.revert` | — | commit 列表 / diff / 结果 |
| `preview.start` / `preview.stop` / `preview.status` | `appId` | `readiness` |
| `runtime.errors` / `runtime.logs` | `since` | 事件页 |
| `export.docker` | `appId` | `{ artifactPath, size }` |
| `publish.push` | `appId, remote?` | `{ commit, tag }` |
| `settings.get` / `settings.set` | — | 设置 |

### 7.3 事件流（SSE）

`GET /events?appId=<id>&since=<seq>`，`text/event-stream`：

```
event: message.delta
data: {"seq":1024,"messageId":"m1","partIndex":0,"text":"我会先创建数据表"}

event: tool.start
data: {"seq":1025,"toolCallId":"t1","name":"fs_write","args":{"path":"src/server/..."}}

event: tool.output
data: {"seq":1030,"toolCallId":"t1","stream":"stdout","text":"..."}

event: task.update
data: {"seq":1040,"taskId":"task_3","status":"completed","title":"生成 dishes 模块"}

event: usage
data: {"seq":1050,"model":"deepseek/deepseek-v4-pro","inputTokens":18342,"outputTokens":2210,"costUsd":0.0361}

event: preview.ready
data: {"seq":1060,"appId":"...","url":"http://127.0.0.1:41001","readiness":{"deps":"ready","server":"ready","preview":"ready"}}
```

- **断线重连**：客户端带 `since` 续传；`since` 过旧则下发 `stream.reset` + `chat.history` 全量
- **背压**：`message.delta` 在服务端按 40ms 合并，避免逐 token 刷屏
- **WebSocket 仅用于预览 HMR**（Vite 自己的通道），Tenon 自身不用 WS，减少一层复杂度

### 7.4 统一响应与错误

```jsonc
// 成功
{ "ok": true, "data": { /* ... */ } }
// 失败
{ "ok": false, "error": { "code": "PREVIEW_PORT_EXHAUSTED", "message": "…", "details": {…} } }
```

错误码分组：`APP_*`（注册表）、`GIT_*`、`PREVIEW_*`、`AGENT_*`（模型/配额/审批）、`EXPORT_*`、`VALIDATION_*`。

---

## 8. 生成应用规范

### 8.1 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19、Vite 7、TypeScript、Tailwind 4、shadcn/ui（Radix）、React Router 7、TanStack Query、zod、sonner、lucide-react、dayjs |
| 后端 | **NestJS 11**、TypeORM 0.3、**PostgreSQL 18（pg driver）**、nestjs-zod、class-transformer |
| 共享 | `src/shared/schemas/*`（zod），前后端同一份 |
| 质量 | ESLint + Prettier、Vitest、`tsc --noEmit`、可选 Playwright |
| 部署 | Docker（多阶段、单容器、单端口） |

### 8.2 目录（标准开发方式，需求 4）

```
repo/
├── package.json                 # 单包，多入口；脚本 dev:client / dev:server / build
├── tsconfig.json                # base
├── tsconfig.client.json
├── tsconfig.server.json
├── vite.config.ts
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── docs/
│   ├── AGENTS.md
│   ├── decisions/
│   └── spec/
├── src/
│   ├── client/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── routes.tsx
│   │   ├── pages/                # 路由页面（一页一目录）
│   │   ├── components/
│   │   │   ├── ui/               # shadcn 原语（button/card/dialog…）
│   │   │   └── <feature>/        # 业务组件（DishCard、OrderTable…）
│   │   ├── hooks/                # useDishes、useOrderForm…
│   │   ├── api/                  # resources/dishes.ts（Query + Mutation）
│   │   ├── lib/                  # queryClient、http、utils 装配
│   │   ├── utils/                # 纯函数：format、date、validators
│   │   ├── types/                # 从 shared 再导出 + 视图类型
│   │   └── styles/
│   ├── server/
│   │   ├── main.ts
│   │   ├── app.module.ts
│   │   ├── common/               # 过滤器、拦截器、管道、分页 DTO、基础实体
│   │   ├── config/               # 配置校验（zod）
│   │   ├── database/
│   │   │   ├── data-source.ts
│   │   │   ├── migrations/
│   │   │   └── seeds/
│   │   └── modules/
│   │       └── dishes/           # ★ 标准 Nest 模块
│   │           ├── dishes.module.ts
│   │           ├── dishes.controller.ts
│   │           ├── dishes.service.ts
│   │           ├── dto/          # create/update/query DTO（nestjs-zod）
│   │           └── entities/dish.entity.ts
│   └── shared/
│       └── schemas/              # zod：Dish、Order…（前后端共用）
└── .tenon/                      # 生成器元数据（部分 gitignore）
```

### 8.3 后端约定（保证生成代码"像人写的"）

- **REST 风格**：`GET/POST/PATCH/DELETE /api/v1/<resources>`，列表统一分页
  `?page=1&pageSize=20&sort=-createdAt&q=&filter[status]=open`
- **响应信封**：`{ data, meta? }`；错误 `{ error: { code, message, details } }`（全局异常过滤器）
- **DTO 即 zod**：`nestjs-zod` 生成校验管道 + OpenAPI；**前端复用同 schema 做表单校验**
- **服务层不做 HTTP 关心事**；Controller 只做入参出参与权限
- **迁移**：TypeORM migration，生成器每加实体/改字段都产出迁移文件（禁止 `synchronize: true` 上生产）
- **种子数据**：`database/seeds/`，Agent 生成示例数据便于预览有内容
- **OpenAPI**：`/api/docs` 自动暴露（Nest Swagger），同时作为前端 api 客户端的类型来源之一

### 8.4 前端约定

- 数据访问**只在** `api/` 层，组件不直接 fetch
- Query key 约定 `['dishes','list',params]`，Mutation 成功后精准 invalidate
- 表单：`react-hook-form` + `zodResolver`（与后端同 schema）
- 错误边界：页面级 `ErrorBoundary` + toast（sonner）；空态/加载态/错误态三件套必须实现
- 组件粒度：`pages`（组合）→ `components/<feature>`（业务）→ `components/ui`（原语）
- 样式只用 Tailwind class + `cn()`，禁止内联 style（除动态尺寸）

### 8.5 风格预设（对齐妙搭）

`templates/styles/*.json`：设计令牌（圆角、间距尺度、字体、语义色、阴影、动效强度）+ 组件默认变体。
首期 6 套：`organic-minimal`（有机极简）、`blueprint`（蓝图）、`aurora`（极光）、`warm-paper`（暖纸）、`emerald`（简约翡翠）、`ant-light`（Ant 风）。
Agent 只改令牌与布局偏好，不重写组件实现 —— 保证换风格不破坏结构。

### 8.6 质量门禁（每次提交前）

```
tsc --noEmit  →  eslint  →  vitest run（若有）  →  build（client+server）
```

任一失败：Agent 自动修复（最多 2 轮），仍失败则把错误摘要给用户并保留现场，**不提交**。

---

## 9. 预览与热更新（需求 6）

### 9.1 App Gateway

每个运行中的应用起三样东西：

```
App Gateway  http://127.0.0.1:<gwPort>     ← iframe / 浏览器访问的唯一入口
  ├─ /            → Vite dev server (:vitePort)
  ├─ /api/*       → NestJS (:apiPort)
  ├─ /__tenon/*  → 探针事件接收（dev only）
  └─ upgrade /    → HMR WebSocket 代理（Sec-WebSocket-Protocol: vite-hmr）
```

理由：**端口稳定**（iframe 不因重启换 URL）、**单源**（无 CORS）、**HMR 可用**（自己代理 upgrade）、**便于内网穿透/远程预览**。

Vite 侧配置：

```ts
server: {
  hmr: { host: '127.0.0.1', clientPort: gwPort, protocol: 'ws' },
  proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
}
```

### 9.2 生命周期与就绪状态

```ts
readiness = { deps: 'pending|ready|error', server: '...', preview: '...', overall: 'starting|ready|degraded' }
```

1. `deps`：`node_modules` 是否齐全（首次 `pnpm install`，走本地缓存/镜像）
2. `server`：Nest 启动成功（探测 `GET /api/health`）+ 迁移是否跑完
3. `preview`：Vite 首屏可访问（探测 `GET /`）

UI 在未 ready 时显示分阶段进度（照搬妙搭「分维度 ready」的思路），**不要**白屏。

### 9.3 热更新的两条路径

| 场景 | 机制 | 延迟 |
|---|---|---|
| 前端代码改动 | Vite HMR（组件级热替换，保留状态） | < 300ms |
| 后端代码改动 | `nest start --watch` 重启（断线 1-2s）→ 网关保持端口，前端 Query 自动重试 | 1-3s |
| Schema/迁移改动 | 后端重启 + 自动迁移 + 前端 invalidate 全部查询 | 2-5s |
| 依赖变更 | `pnpm install` → 双端重启（显示进度） | 视网络 |

> 体验细节：重启期间 iframe 显示「后端重启中」骨架，而不是错误页；完成后自动刷新数据，保持路由不跳。

### 9.4 静态预览（无 dev server）

「只预览前端」模式：`vite build` + `@fastify/static` 托管 `dist/client`，API 走 Mock（基于 shared schema 生成的假数据）。用途：快速看视觉、给非技术用户演示、CI 截图对比。

---

## 10. 精调：元素选择与框选（需求 11）

### 10.1 注入的 inspector

Vite 插件 `tenon-inspector-plugin`（仅 dev 生效）做两件事：

1. **源码定位**：Babel 转换时给每个 JSX host 元素加 `data-tenon-loc="src/components/DishCard.tsx:42:7"`，并记录组件栈
2. **注入客户端**：`transformIndexHtml` 插入 `@tenon/runtime-sdk/inspector`

交互（对齐主流设计工具习惯）：

| 操作 | 行为 |
|---|---|
| `Alt/Option + Hover` | 高亮元素 + 悬浮标签（组件名 · file:line · 尺寸） |
| `Alt + Click` | 选中元素 → 打开精调面板 |
| `Alt + Drag` | **框选区域** → 收集矩形内元素（按面积/层级排序） |
| `ESC` | 退出检查模式 |
| 右侧面板 | 组件树、Props 摘要、样式差异、源码片段、"在编辑器中打开" |

### 10.2 选择上下文协议

```ts
interface SelectionContext {
  kind: 'element' | 'region' | 'error'
  loc?: { file: string; line: number; column: number; component?: string; stack?: string[] }
  selector?: string
  route: string
  rect: { x: number; y: number; width: number; height: number }
  text?: string                          // 截断 500 字
  styles?: Record<string, string>        // 仅记录与父级不同的关键样式
  props?: Record<string, unknown>        // 安全序列化，过滤函数/循环引用
  elements?: Array<{ selector: string; loc?: Loc; text?: string }>   // region
  screenshot: string                     // dataURL，压缩到 ≤ 300KB
  viewport: { width: number; height: number; dpr: number }
}
```

传输：`postMessage` 到父窗口，**校验 `event.origin` 与一次性 token**；父窗口确认后写入 `tenon.selection` 文档。

### 10.3 进入对话

Composer 顶部出现可删除的上下文 chip：

```
[🧩 DishCard · src/components/DishCard.tsx:42 ✕]  [🖼 截图 ✕]
```

用户输入"价格字号太小，改大一号"→ Agent 拿到 `selection` 后：

1. 读 `loc` 对应源码 ±30 行（`fs_read`）
2. 定位样式类 → 改 Tailwind class
3. HMR 立即生效 → Agent 自己 `preview_screenshot` 验证 → 回报"已调整，前后对比"
4. 自动 `git commit`：`fix(ui): DishCard 价格字号 text-sm → text-lg`

**框选**用于"这一块都改"：Agent 拿到 N 个元素 → 归纳共同组件 → 做一次结构性修改，而不是逐个打补丁。

### 10.4 报错精调

点击运行时错误卡片的「修复」→ 构造 `kind:'error'` 的 SelectionContext（堆栈 + 源码片段 + 最近 5 条操作事件 + 截图）→ 直接进对话，Agent 走"复现 → 定位 → 修复 → 自验"闭环。

---

## 11. 可观测性：日志、异常、状态（需求 8）

### 11.1 事件来源

| 源 | 采集 | 实现 |
|---|---|---|
| 前端 console | `log/info/warn/error/debug` | SDK 重写 `console.*`，保留原行为 |
| 前端异常 | `window.onerror`、`unhandledrejection`、React ErrorBoundary | SDK + 生成模板内置边界 |
| 网络 | fetch/XHR 的 method/url/status/耗时（**不含 body**） | SDK 拦截（默认脱敏） |
| 路由 | 进入/离开页面、停留时长 | Router 订阅 |
| 性能 | FCP/LCP/CLS、长任务 > 100ms | PerformanceObserver |
| 后端 | stdout/stderr 行、Nest Logger JSON、请求日志 | 子进程管道 + 中间件 |
| 数据库 | 慢查询（> 200ms）、迁移结果 | TypeORM logger |
| 预览状态 | readiness 变化、端口冲突、重启次数 | Gateway |

### 11.2 管道

```
SDK（浏览器） --batch 500ms--> POST /__tenon/events --> Gateway --> 事件总线
Nest stdout ---line--> LogTailer --parse--> 事件总线
                                                   │
                    ┌──────────────────────────────┼───────────────────────┐
                    ▼                              ▼                       ▼
          .tenon/runtime/*.jsonl           UI 面板（实时）           errorGroups 聚合
          （按天轮转，保留 7 天）          （环形缓冲 2000 条）      （指纹去重 + 计数）
```

### 11.3 UI 面板

| 面板 | 内容 |
|---|---|
| **日志** | 级别过滤、来源过滤（client/server/db）、关键字搜索、跟随滚动、点击定位源码 |
| **错误** | 按指纹聚合、出现次数、首次/最近时间、堆栈、"一键修复"、"忽略" |
| **状态** | 当前路由、视口、登录态、各表行数、迁移版本、依赖版本、readiness |
| **用量** | 本应用 token/成本按天、按 Agent 分档统计（`recharts`） |

### 11.4 一键修复的上下文包

```jsonc
{
  "error": { "message": "...", "stack": "...", "componentStack": "..." },
  "loc": { "file": "src/client/pages/Orders.tsx", "line": 88 },
  "source": "…前后各 30 行…",
  "recentEvents": [/* 最近 10 条操作/网络事件 */],
  "screenshot": "data:image/png;base64,…",
  "git": { "head": "a1b2c3d", "dirty": true },
  "schemaVersion": "…"
}
```

这个包同时是 `SelectionContext(kind:'error')`，链路完全复用 §10。

---

## 12. 版本管理：Git 一等公民（需求 1）

### 12.1 模型

| 概念 | 实现 |
|---|---|
| 工作区 | 每应用一个 git 仓库 `~/.tenon/apps/<id>/repo` |
| 提交粒度 | **一次 Agent 回合 = 一次 commit**（有实际改动才提交） |
| commit 元数据 | trailer 记录来源：`Tenon-Conversation`、`Tenon-Submission`、`Tenon-Task`、`Tenon-Model` |
| 分支 | `main` 为开发线；`release/<version>` 由发布创建（只读） |
| 发布 | `git tag v<yyyy.MM.dd>-<n>` + `git push origin main --tags` |
| 回滚 | 代码：`git revert <sha>`（生成可追溯的反向提交）；数据：可选 DB 快照还原 |
| 备份 | 未配置远端时，push 到本地裸库 `~/.tenon/backups/<id>.git` |

### 12.2 自动提交流程

```
submission.done
  → 计算变更（git status --porcelain，忽略 .tenon/、node_modules、*.sqlite）
  → 质量门禁（§8.6）
  → 生成 message：Conventional Commits，scope 取主要改动目录
      feat(dishes): 新增菜品管理 CRUD
      fix(ui): DishCard 价格字号
      chore(deps): 升级 zod
  → commit（author = Tenon Agent <agent@local>，trailer 写入会话/任务/模型）
  → 记录 plan 任务 ↔ commit 映射，推送 UI 版本时间线
```

**用户可回滚**：版本面板列出 commit（时间/摘要/模型/改动文件数/±行数），支持「查看 diff」「回滚到此」（`revert`，非 `reset --hard`，不丢后续历史）。

### 12.3 数据库回滚

代码能回滚，schema 也能回滚（下迁移），但**数据**不一定。策略：

- 每个执行过迁移的 commit → 用 `pg_dump --format=custom` 生成 DB 快照 `snapshots/<sha>.dump`（保留最近 20 个 + 所有 release）
- 回滚时可选 `dbRestore: true` → 还原快照（**默认关闭**，UI 明确提示"会丢失此后数据"）
- 发布时必存快照 → 对应 release 可"回滚到上线版本（含数据）"

### 12.4 与 pi-durable 的对齐

妙搭的 `resetArtifactVersion` 有三条回滚线（checkpoint / artifact version / commit + dbRestore），我们合并为一条主线 + 一个开关：

| 妙搭 | 我们 |
|---|---|
| `{artifactType:'checkpoint', checkPointID}` | `git revert <sha>` + 可选 `conversation.fork(entryId)` 回到当时的对话分支 |
| `{artifactID, version}` | 同上（artifact 即仓库文件树） |
| `{commitID, revertTargetEndTime}` | 同上 |
| `dbRestore` | `dbRestore: true` |

**额外能力**：`conversation.fork(entryId)` 支持"从某轮对话重开一条分支试另一个方案"，两条分支各自的 commit 可对比 —— 这是纯 Git 做不到的产品级能力，也是 pi-durable 白送的。

---

## 13. 发布与部署（需求 5）

### 13.1 产物

| 类型 | 内容 | 用途 |
|---|---|---|
| **Docker 镜像/上下文** | `Dockerfile` + `docker-compose.yml` + `.dockerignore` + 构建上下文一键打包 | 自托管上线（主推） |
| 静态包 | `dist/client` + `dist/server` + `start.sh` | 无 Docker 环境 |
| Git push | 代码推到用户远端（GitHub/GitLab/Gitea） | 团队接管、CI/CD |

### 13.2 Dockerfile（模板，单容器单端口）

```dockerfile
# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build          # tsc(server) + vite build(client)

# ---- runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_URL=file:/data/app.db
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src/server/database/migrations ./dist/migrations
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server/main.js"]
```

- Nest 用 `ServeStaticModule` 托管 `dist/client`，**只有一个端口**（反代友好）
- 启动时自动跑迁移（`migrationsRun: true`），DB 落在 `/data` 卷
- `docker-compose.yml` **默认即含 PostgreSQL**（`db` 服务 + 命名卷 + `service_healthy` 依赖）；`lite` 档仅在本地预览使用，不进生产产物
- 镜像大小目标 < 250MB（alpine + prod 依赖裁剪）

### 13.3 发布流程（UI）

```
发布 → 选择目标（本地镜像 / 导出 tar / 推到 Registry / 仅 push 代码）
     → 质量门禁 + 全量构建（在临时目录，不污染工作区）
     → 生成 release 记录（version、commit、镜像 digest、DB 快照）
     → 可选：自动生成发布说明（LLM 总结本轮 diff）
```

**不在用户机器上直接 `docker build`**（可能没装 Docker）：默认**导出构建上下文 + 一条可复制命令**；检测到 Docker 可用时才提供"本地构建"按钮。

### 13.4 运行时配置

`.env`：`PORT`、`DATABASE_URL`、`AUTH_MODE=none|token`、`AUTH_TOKEN`、`TZ`、`LOG_LEVEL`。
生成应用默认**无需登录**（内网工具场景），可选开启单 Token 保护。

---

## 14. 交互与视觉设计（需求 7）

### 14.1 信息架构

```
┌───────────────────────────────────────────────────────────────────────┐
│ 顶栏：应用名 · 环境(dev/prod) · readiness 灯 · 预览开关 · 发布 · 设置   │
├──────────────┬────────────────────────────────┬───────────────────────┤
│ 会话流        │  预览台                        │ 侧栏（可切）           │
│ (380-520px)  │  (弹性)                        │ 计划/文件/日志/错误/   │
│              │  ┌──────────────────────────┐  │ 版本/状态/用量         │
│ 消息气泡      │  │ toolbar: 路由·设备·刷新   │  │                       │
│ 工具卡片      │  │ iframe                   │  │                       │
│ 计划进度条    │  │                          │  │                       │
│              │  └──────────────────────────┘  │                       │
├──────────────┴────────────────────────────────┴───────────────────────┤
│ Composer：上下文 chips · 附件 · 模型档位 · 队列提示 · 发送/停止          │
└───────────────────────────────────────────────────────────────────────┘
```

可折叠：会话流 ↔ 预览台可拖动分隔（记住宽度）；窄屏（< 1100px）切换为 Tab。

### 14.2 会话流组件清单

| 组件 | 状态 | 细节 |
|---|---|---|
| `UserMessage` | 静态 | 右对齐淡色气泡；附件缩略图；选择上下文 chip |
| `AssistantMessage` | streaming / done / error / aborted | 左对齐无气泡（文档流）；Markdown 增量渲染；代码块带复制/文件名 |
| `ThinkingBlock` | 折叠 / 展开 | "思考中…"骨架 → 完成后折叠为一行"已思考 12s"；流式时逐字渐显 |
| `ToolCallCard` | pending / running / done / failed / blocked | 图标 + 名称 + 参数摘要；运行中显示进度条与实时输出（可展开）；失败显示错误与"重试" |
| `PlanCard` | 生成中 / 执行中 / 完成 | 任务清单 + 环形进度；点击任务定位到对应 commit/文件 |
| `DiffCard` | 折叠 | `+12 −3` 徽标，点开 Monaco Diff 内联预览 |
| `SubagentCard` | running / done | 角色徽标（Explore/E2E/…），点开旁挂子会话（pi-durable `details.conversationId`） |
| `QueueIndicator` | 1..10 | "3 条排队中"，可拖动排序/删除；`steer` 按钮=插队 |
| `ErrorRecoveryBanner` | 崩溃/断线恢复 | "已从中断处恢复（任务 3/7）"，提供"重放详情" |

### 14.3 动效与质感（明确规范，避免"AI 味"）

| 项 | 规范 |
|---|---|
| 时长 | 微交互 120ms、常规 180ms、展开 240ms、页面级 320ms |
| 缓动 | 进入 `cubic-bezier(0.16,1,0.3,1)`；退出 `cubic-bezier(0.4,0,1,1)` |
| 流式文本 | 逐 token 追加 + 光标呼吸；**不做**逐字打字机（长文卡顿） |
| 布局变化 | `motion` 的 `layout` 动画；消息高度预留，禁止跳动 |
| 骨架 | shimmer 1.4s 循环，与内容块尺寸一致 |
| 反馈 | 所有按钮 `active:scale-[0.98]`；成功/失败用 sonner，不用 alert |
| 克制 | 不用渐变边框、不用发光、不用无意义弹跳；阴影只有 3 档 |
| 无障碍 | 尊重 `prefers-reduced-motion`；流式区域 `aria-live="polite"`；全键盘可达 |

### 14.4 快捷键

| 键 | 行为 |
|---|---|
| `⌘↵` | 发送（空闲）/ 排队（运行中） |
| `⇧⌘↵` | 插队执行（`steer`） |
| `⌘.` | 停止生成 |
| `⌘K` | 命令面板（切应用、开面板、跳文件、跑命令） |
| `⌘⇧P` | 预览开关 |
| `⌥⌘I` | 元素检查模式 |
| `⌘1..6` | 切换侧栏面板 |

### 14.5 首启动引导

1. 选提供商 + 填 Key（可跳过，之后在设置里配）→ 连通性测试（发一句"ping"，显示延迟与模型名）
2. 选默认档位映射（fast / comprehensive / thinking）
3. 建第一个应用：给 3 个示例需求模板（内部工具 / 数据看板 / 表单审批）

---

## 15. 安全与隐私

| 面 | 措施 |
|---|---|
| 本地服务暴露 | 只绑 `127.0.0.1`；随机端口；Bearer Token（启动生成，仅注入渲染器）；Web 模式强制 `127.0.0.1` 且打印带 token 的 URL |
| 文件访问 | 所有 fs 操作走 `resolveInApp()`，禁止 `..` 越界；生成应用只能写自己仓库 |
| 命令执行 | `NodeExecutionEnv` 限制 cwd；高危命令（`rm -rf`、`git push --force`、`docker`、`curl` 外网）走审批；`hook(beforeTool)` 兜底 |
| 密钥 | Electron `safeStorage`（OS 密钥链）加密存 `models.json.enc`；**永不写入仓库**；子进程通过 env 注入，不落盘 |
| 生成应用密钥 | `.env` 进 `.gitignore`；发布产物用环境变量注入 |
| 提示注入 | 外部内容（网页/文件/用户数据）在提示中标注为不可信；工具结果不回显为指令 |
| 遥测 | **默认关闭**，首次启动明确询问；仅匿名使用统计，可随时关闭 |
| 数据 | 全部本地；无云端依赖；卸载=删目录 |

### 15.3 沙箱隔离的**平台差异**（重要，别到最后才发现）

> **先澄清一层容易被混淆的事：pi 生态本身没有任何平台问题。**
> `@earendil-works/pi-durable` / `pi-ai` / `chord` / `pi-codemode` 1.4.0 都是**纯 TypeScript npm 包**（2026-10-31 实测校验）：
> - 包内**零原生模块** —— 无 `.node` / `.gyp` / `.dylib` / `.so` / `.dll` / `.wasm`
> - **无平台相关 `optionalDependencies`**，`os` / `cpu` 字段为空
> - 唯一硬约束是 `engines: node >= 22.19`（内部依赖 `node:sqlite`、`node:worker_threads` 等 Node **内置**模块）
>
> 所以在 Windows x64 上，`npm i` 之后即为可用状态：**不需要 node-gyp、不需要编译工具链、不需要 WSL**。
>
> 因此，本文档后续提到的所有「Windows 差异」—— Electron 打包与签名、`embedded-postgres` 原生二进制路径与安装、`gondolin` 缺失微 VM 后端、端口探测命令（`lsof` → `netstat`）——**全部发生在 Tenon 自己引入的本地基建层，与 pi 无关**。
> 推论：**只跑 Server + Web 模式（不打包桌面端、不启用本地 PG）时，Windows 的适配成本接近于零**；桌面首发 Windows 的额外工作量集中在打包发货环节，而非 Agent 运行时。

`gondolin` 微 VM 是可选的高档隔离，但它的可用性**按平台不同**：

| 平台 | gondolin 后端 | 状态 | 我们的策略 |
|---|---|---|---|
| macOS 14+（ARM64）| QEMU（`brew install qemu`）或 krun | ✅ 官方验证最强 | 检测到 QEMU 则启用，否则降级 |
| macOS（x64）| QEMU | ⚠️ 可用但未重点验证 | 降级 |
| **Windows x64** | **无原生后端** | ❌ | **不使用 gondolin**，走方案 B（见下） |
| Linux x64 | QEMU / krun | ✅ | 可用 |
| Linux ARM64 | krun | ✅ | 可用 |

**方案 B（Windows 与无 QEMU 场景）—— 分级隔离，够用即可：**

1. **L1/L2 内置与官方组件**：不隔离（它们是我们的代码，等价于运行时的一部分）
2. **L3 社区组件**：独立 Node 子进程 + `NodeExecutionEnv` 受限 cwd + 网络白名单（`net:fetch` 声明的域名）—— **不是 VM 沙箱，但阻断了 FS 越界与任意网络访问**
3. **Agent 执行的命令**：`beforeTool` 审批门 + 命令白名单，高危操作必须用户确认
4. **生成应用的构建/运行**：就是本机普通进程 —— 因为**这是用户自己要求生成的代码**，信任模型不同于"执行互联网上下载的任意代码"

**为什么这个降级是可接受的**：妙搭用容器的根本原因是 **多租户 SaaS**（不同客户的应用互相不可信）。Tenon 是**本地单租户**，用户的 Agent 生成的应用与用户自己在终端里 `npm run dev` 的信任级别相同。真正的风险边界在 **L3 社区组件**，那一层我们已经用独立进程 + 权限清单兜住了。

> 如果将来做云端托管（M7+），那里必须用 gondolin 或容器 —— 因为那时才变成多租户。

---

## 16. 开源协议与商业化

### 16.1 推荐方案：AGPL-3.0 + 双许可（open core）

| 部分 | 协议 | 理由 |
|---|---|---|
| `apps/*`、`packages/server|core|agent|generator` | **AGPL-3.0-only** | OSI 认可的真开源；任何人可自用、可改、可分发；但**作为托管服务对外提供必须开源其修改**——正好挡住"拿我们代码做竞品 SaaS" |
| `packages/runtime-sdk`、`templates/*`、生成物骨架 | **Apache-2.0** | 用户生成的应用**绝不传染**；企业敢用；含专利授权 |
| `docs/` | CC BY 4.0 | 文档可自由引用 |
| 商业版 | 商业许可 | 闭源集成 / 去除 AGPL 义务 / 企业功能 |

**为什么不是 Apache-2.0 全家桶**：那样 AWS 式厂商可原样托管而无回馈，你的商业版失去护城河。
**为什么不是 FSL/BUSL**：它们不是 OSI 开源，会削弱"开源产品"的传播力与社区信任（可作备选，见 16.3）。

### 16.2 免费 / 商业边界（建议）

| 能力 | 社区版（AGPL） | 商业版 |
|---|---|---|
| 单机搭建、全栈生成、Git、Docker 导出 | ✅ | ✅ |
| 6 Agent 全量、精调、可观测 | ✅ | ✅ |
| **PostgreSQL 全档供给（含 embedded）** | ✅ | ✅ |
| **安装免费组件（L1/L2/L3）** | ✅ | ✅ |
| 团队协作（多人同应用、评论、审批） | ❌ | ✅ |
| 企业 SSO / RBAC / 审计日志 | ❌ | ✅ |
| 私有组件市场 / 组织级组件库 | ❌ | ✅ |
| 云端同步、远程预览、托管部署 | ❌ | ✅ |
| 优先级支持 / SLA | ❌ | ✅ |

原则：**个人与小团队永远够用**；企业为"组织与合规"付费，而非为"能不能用"付费。

三条补充说明（v1.1 新增）：

1. **收费组件不绑定版本**。社区版用户也能买、也能装收费组件 —— 组件收入与版本授权解耦，否则会出现"想买组件必须先买企业版"的荒谬组合，反而抑制生态。
2. **个人免费的口径**是"个人身份使用"（含个人承接的外包交付），**不包括**"作为公司内部平台给多人用" —— 后者需要商业授权。这条要在 LICENSE FAQ 里写清楚，避免歧义。
3. **不做功能阉割式免费**。所有核心能力（生成、Agent、Git、部署）在社区版完整可用；差异只在"组织能力"与"规模"。

### 16.3 备选（若你不接受 AGPL）

| 方案 | 优点 | 缺点 |
|---|---|---|
| FSL-1.1-Apache-2.0 | 2 年后自动转 Apache；对商用友好；Sentry 同款 | 非 OSI 开源，宣传时只能说 source-available |
| Apache-2.0 + 纯商业插件 | 传播最快 | 无护城河，易被托管 |
| BUSL-1.1 | 保护最强 | 社区抵触大，4 年才转 |

### 16.4 配套治理

- **DCO**（`Signed-off-by`）而非 CLA —— 降低贡献门槛
- **商标**：产品名与 Logo 单独声明商标权；禁止用作品牌做衍生分发（fork 需改名）
- **免责**：README 明示"非官方，与字节跳动/飞书无关；未使用其代码/资源"
- **贡献指南**：`CONTRIBUTING.md` 说明 clean-room 红线（不得提交逆向所得代码/文案）
- **安全披露**：`SECURITY.md` + 私密渠道

---

## 17. 里程碑

| 阶段 | 目标 | 验收（DoD） |
|---|---|---|
| **M1 骨架与对话** | monorepo、server、harness 池、SSE、应用注册、Git 自动提交、静态 React 应用预览、Web 模式 | ① `pnpm dev:web` 打开可对话；② 生成一个纯前端 Todo 应用并在 iframe 热更新；③ 每轮产生 commit；④ 杀进程重启后对话续跑 |
| **M2 全栈生成** | Nest 模板、zod 共享、TypeORM/迁移、**PostgreSQL 四档供给**、CRUD 生成、runtime SDK、日志/错误面板 | ① 生成带 CRUD + 真 PG 的全栈应用；② `lite` 与 `embedded` 两种模式跑同一份 migration；③ Docker compose（含 db）构建并跑起来；④ 前端异常出现在错误面板 |
| **M3 精调与版本** | inspector、框选、截图、Diff 视图、回滚（含 `pg_dump`/`pg_restore`）、发布 push | ① 点选元素改样式并自验；② 框选区域批量改；③ 回滚到任意 commit，代码与数据一致 |
| **M4 多 Agent 与可观测增强** | 6 角色子 Agent、E2E 自验收、Reviewer、用量/预算、`taskGraph` 状态面板 | ① E2E 子 Agent 能发现并修复一个注入的 bug；② 任务图实时反映子会话；③ 超预算拦截 |
| **M5 组件体系（内部定型）** | chord 宿主接入、6 个标准插槽、`install_component` 工具、L1 内置积木清单、L2 首发 3 个官方组件（AI 小助手 / Excel 导出 / 审批流）| ① 用一句话给应用装上 AI 小助手并可用；② 卸载后代码与 `AGENTS.md` 同步清理；③ 组件热重载不丢状态 |
| **M6 平台化与开源** | **macOS + Windows 双平台安装包**、组件市场（免费/收费 + license 校验）、视觉/动效打磨、i18n、文档站、CI、协议与商标 | ① 两平台安装包签名可安装；② 装一个收费组件（离线 license）且未授权用户拿不到方法；③ 新人 10 分钟跑通首个应用；④ 协议文件与贡献流程齐备 |
| **M7（后置）** | Linux、团队协作、托管能力 | 视社区反馈 |

依赖关系：M2 依赖 M1 的 harness 与事件流；M3 依赖 M2 的源码定位；M4 依赖 M3 的预览 API；M5 依赖 M2 的应用装配；M6 依赖 M5 的组件协议。

> **平台顺序的说明**：Windows 与 macOS 的技术差异集中在三处 —— ① `embedded-postgres` 二进制与路径（已确认有 windows-x64 包）；② 进程管理与端口占用（Windows 无 `lsof`，用 `netstat`/`Get-NetTCPConnection`）；③ godolin 微 VM **在 Windows 无原生后端**（需 WSL2）。所以 M1 就要同时在这两个平台冒烟，不能留到 M6 才发现问题。

---

## 18. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| pi-durable 实验性，API 可能变 | 高 | `save-exact` 锁定版本 + `packages/agent/adapter` 包一层，升级只改 adapter；订阅 upstream release |
| Electron 内置 Node 版本落后 | 中 | 锁 Electron ≥ 39；server 子进程独立，必要时可外挂 Node |
| 生成代码质量不稳定 | 高 | 模板 + AST 补丁（而非自由生成）+ 质量门禁 + Reviewer 子 Agent |
| 依赖安装慢/失败（国内网络） | 中 | 本地 pnpm store + 可配镜像；依赖预装在模板缓存 |
| 端口冲突 | 低 | 41000-41999 分配 + 占用检测 + 冲突自动换端口并更新网关 |
| Docker 环境不可用 | 中 | 默认导出上下文 + 命令，不强制本机构建 |
| LLM 成本失控 | 中 | 预算熔断 + 档位路由（简单任务用 fast）+ 用量面板 |
| AGPL 影响商业采用 | 中 | Runtime SDK/模板 Apache-2.0；双许可；FAQ 解释 |
| 多端路径差异（Windows）| 低 | 统一 `pathe`/`node:path`；CI 覆盖 Windows |
| **`embedded-postgres` 仍是 beta 版本号**（18.6.0-beta.x）| 中 | 二进制本身是官方 PG 构建，风险在 wrapper API；用 `packages/db-provisioner` 隔离，并提供 `docker`/`external` 兜底；CI 锁版本 + 冒烟 |
| **Windows 无 gondolin 后端** | 中 | 见 §15.3 方案 B（独立子进程 + 权限清单），并明确文档化能力差异 |
| **社区组件可访问用户应用数据** | **高** | L3 强制独立子进程 + `manifest.permissions` 逐条确认 + 无 `host.serve` 级能力；官方 L2 走签名 |
| **收费组件被绕过** | 中 | 授权在服务端 `principal` 层，非前端开关；license 用 Ed25519 签名 |
| PG 首次下载慢（embedded 模式，~30MB）| 低 | 安装包内置常用平台二进制（增量下载兜底）；首次引导显示进度 |
| 组件插槽被滥用导致 UI 冲突 | 低 | 只开放 6 个标准插槽；同插槽多组件按 `order` 排序并限流 |

---

## 19. 决策记录与待确认问题

### 19.1 已拍板（2026-10-31 v1.1）

| 议题 | 决定 |
|---|---|
| 产品名 | **Tenon / 榫**（§1.5）|
| 生成应用数据库 | **PostgreSQL 默认**，四档供给（§6.4）|
| 首发平台 | **macOS + Windows**（Linux 随 M5）|
| 商业边界 | 认可 §16.2 那张表 |
| 商业模式 | **个人免费**；组件市场分免费/收费（§21.5）|
| 桌面框架 | Electron 39.x（已定）|
| 发布方式 | Docker 产物优先（已定）|
| LLM | BYOK 多提供商（已定）|

### 19.2 仍待你确认（不阻塞 M1，但影响 M2 之后）

1. **代码可见性节奏**：M1-M2 只给只读 + Diff，M3 再开放可编辑？还是从一开始就能直接改文件？（我的建议：M1 只读 + Diff，因为此时代码质量还在建立信任）
2. **收费组件的结算方式**：① 自带 license 文件离线校验（无服务端，符合开源调性，但易被绕过）；② 官方市场 + 在线许可（可控，但引入服务端依赖）；③ 两者都支持（推荐）。你倾向哪种？
3. **个人免费的具体边界**：是否对"个人商用"也免费（如个体户用 Tenon 做外包交付）？这会影响后续定价与授权文案。
4. **插件市场的审核策略**：开放上架（快，但有安全风险，插件能访问用户代码）还是先官方精选 + 白名单（慢，但可控）？
5. **Linux 支持的时间点**：M5 一起发，还是等 mac/win 稳定后单独发？

---

## 20. 我建议补充的能力（超出你列的 11 条）

按价值排序，都可后置但建议尽早进路线图：

1. **一键体检**：`typecheck + lint + test + 关键路径冒烟`，出健康分与修复建议（比"能跑"更接近"能交付"）
2. **变更审阅**：每轮改动给你一个"接受/回滚"的 diff 卡片，避免 Agent 越改越偏
3. **方案分支对比**：`conversation.fork` + 两条 commit 线，UI 上并排看两个实现
4. **数据种子与演示数据**：新应用自动准备示例数据，预览不空
5. **OpenAPI 自动文档**：生成应用自带 `/api/docs`，同时供前端类型生成
6. **自动化触发器**：定时/Webhook（妙搭有，我们 M5 后可做，本地 cron + 端点）
7. **多环境**：dev / staging / prod 三套端口与数据库，一键切换与回滚
8. **成本可视化**：按应用/按 Agent/按天，让"用 AI 开发"的成本可预期
9. **离线模式**：Ollama / vLLM（pi-ai 已支持 OpenAI 兼容），无网也能改代码
10. **pgvector 记忆检索**：应用级记忆从"文件全文"升级为"向量召回"（既然已经是真 PG，pgvector 是白送的）

---

## 21. 插件与组件生态（需求 5 深化）

这是"应用里加 AI 小助手、组件分免费/收费"的落地设计。**结论先说：不要自研插件框架，直接用 chord。**

### 21.1 为什么是 chord，而不是自己定一套

| 自研插件框架要解决的问题 | chord 是否已解决 |
|---|---|
| 插件跨进程（server / worker / 浏览器 tab）| ✅ 对象在地址上，引用跨进程可用 |
| 状态同步到 UI | ✅ 状态是可观察 JSON，远程订阅者拿快照 + 增量 |
| 热重载（改插件代码不重启应用）| ✅ 在飞的工作用旧代码跑完，状态保留，不兼容变更在安全点迁移 |
| 运行时权限（谁能调用什么）| ✅ `principal`（owner/guest）拿到**不同的对象与不同方法** |
| 契约版本兼容 | ✅ contract 带 `version`，声明式校验（TypeBox）|
| 宿主与插件的调用开销 | ✅ 同进程走 memoryLink，跨进程走 IPC/WebSocket，同一套代码 |

自研的代价是"再造一个 chord"（chord 本身 2.3MB 源码 + 完整 spec），收益为零。**我们只在它之上定义"应用级组件规范"与"市场协议"。**

### 21.2 组织方式：一个组件 = 一个插件 = 一份 contract

```text
plugins/ai-assistant/          # 一个组件
├── contract.ts                # ★ 唯一对外契约：对象、状态、方法、版本
├── server.ts                  # 宿主 facet：后端实现（调 LLM、读写 DB）
├── web.tsx                    # 宿主 facet：前端 UI（悬浮球、侧栏、气泡）
├── worker.ts                  # 可选：后台任务 facet（索引、定时）
├── manifest.json              # 元数据：名称、图标、定价、权限声明、依赖
└── README.md                  # 给 Agent 读的用法说明（进 AGENTS.md 索引）
```

```ts
// plugins/ai-assistant/contract.ts —— 这就是"卯眼"的尺寸公差
import { Type } from 'typebox'
import { hostNamed, method, remote } from '@earendil-works/chord'

export const AiAssistant = remote('tenon.assistant', {
  version: 1,
  input: Type.Object({ appId: Type.String() }),
  host: hostNamed('server'),
  variants: {
    // ★ 两种 principal 看到两种对象：未授权只能看，授权后可调用
    guest: {
      state: { status: Type.String(), quotaUsed: Type.Number() },
      methods: { peek: method(Type.Object({})) },
    },
    licensed: {
      state: { status: Type.String(), quotaUsed: Type.Number(), history: Type.Array(Type.Object({ role: Type.String(), text: Type.String() })) },
      methods: {
        ask: method(Type.Object({ text: Type.String() })),
        summarize: method(Type.Object({ scope: Type.String() })),
      },
    },
  },
})
```

**关键点：收费不是"前端藏按钮"，是服务端根本不下发方法。** 未购买的用户即使改了前端代码，`ask` 也不存在。这是 chord `principal` 白送的安全性，比任何前端开关都可靠。

### 21.3 组件如何被"插进应用"

Agent 不手写接线代码，而是执行一个**标准动作**（内部工具 `install_component`）：

1. 读 `manifest.json` → 检查依赖、权限、宿主兼容性
2. 写一份**装配声明**到应用仓库 `app.components.json`：

```json
{
  "components": [
    { "id": "tenon.assistant", "version": "^1.2.0", "license": "free",
      "mount": [{ "host": "web", "slot": "app.shell.overlay", "order": 100 },
                { "host": "server", "slot": "app.api", "prefix": "/_c/assistant" }] },
    { "id": "tenon.excel-export", "version": "^0.9.0", "license": "paid:tenon.excel-export",
      "mount": [{ "host": "server", "slot": "app.api", "prefix": "/_c/excel" }] }
  ]
}
```

3. 由**壳生成器**在应用启动时按声明加载 facet（`host.load([...])`），生成 `src/components.generated.ts`
4. 若有插槽 UI，在 App Shell 的固定插槽渲染（`app.shell.overlay` / `app.sidebar.bottom` / `app.page.header`）

**插槽（slot）是稀缺资源，必须标准化。** 我建议 V1 只定义 6 个插槽，不要开放任意位置：

| 插槽 | 位置 | 典型组件 |
|---|---|---|
| `app.shell.overlay` | 全屏浮层（悬浮球、全局 AI） | AI 小助手 |
| `app.shell.sidebar.bottom` | 侧边栏底部 | 帮助、反馈 |
| `app.page.header` | 页面标题右侧 | 导出、打印、分享 |
| `app.page.toolbar` | 表格/列表工具栏 | 批量操作、字段设置 |
| `app.detail.panel` | 详情页侧栏 | 关联数据、评论 |
| `app.api` | 后端路由前缀 | 所有后端能力 |

### 21.4 三层组件体系（区分来源与信任级别）

| 层 | 来源 | 信任 | 安装方式 | 例子 |
|---|---|---|---|---|
| **L1 内置积木** | 我们官方，随 Tenon 发布 | 完全信任 | 无需安装，Agent 直接调用 | 表格、表单、图表、登录、文件上传、权限 |
| **L2 官方组件** | 我们官方市场 | 签名校验 | 一键装，自动更新 | AI 小助手、Excel 导出、审批流、地图 |
| **L3 社区组件** | 第三方开发者 | 沙箱 + 权限清单 | 显式确认权限后安装 | 行业专属（餐饮菜单、教培排课）|

L3 必须有真实隔离：**不能给社区插件 `host.serve` 级别的能力**，因为那等于给任意代码访问应用数据库。方案：
- L3 插件跑在**独立子进程**（`chord/node` 的 `createHostManager`），只通过 contract 暴露的 RPC 通信
- 文件系统访问走 gondolin 微 VM 或受限 `NodeExecutionEnv`（Windows 见 §15.3）
- `manifest.json` 的 `permissions` 声明（db:read / db:write / net:fetch / fs:app）在安装时逐条弹窗

### 21.5 免费 / 收费组件的商业模式

| 维度 | 免费组件 | 收费组件 |
|---|---|---|
| 分发 | 官方市场，公开可下载 | 官方市场，需购买后下载 |
| 授权 | 无需 license | `license.json`（签名，绑定用户/组织 ID），离线可校验 |
| 运行时 | `guest` + `licensed` 都给 | 只有有效 license 才拿到 `licensed` 这个 variant |
| 更新 | 自动 | 自动（license 有效期内）|
| 计价 | 免费 | 一次性买断 / 年订阅 / 按用量（AI 类）|

**推荐的双轨结算**（对应 §19.2 第 2 问，我倾向 ③）：
- **离线优先**：license 文件用 Ed25519 签名，公钥内置在 Tenon 里，`offline` 校验。企业内网也能用
- **在线增强**：登录官方账号可自动同步已购组件、跨设备、订阅续费；未联网时降级为"只读已装组件"
- **分成**：社区开发者 7:3（开发者 7），官方组件不分成

**为什么个人免费能成立**：个人免费带来生态规模，组件销售与企业版带来收入。这与 VS Code / JetBrains 的路径一致 —— 免费 IDE 不赚钱，插件市场和企业授权赚钱。

### 21.6 与 Agent 的协同（组件要"可被理解"）

组件不是装完就完事，**Agent 必须知道它存在、能干什么、怎么用**，否则改两次代码就把组件绕过或改坏了。三个机制：

1. `manifest.json` 必须含 `agentHints`（自然语言说明 + 用法示例），安装时自动写入应用的 `docs/AGENTS.md` 的「已装组件」小节
2. 卸载/更新组件时，`AGENTS.md` 同步更新（由 `install_component` / `remove_component` 工具负责）
3. 系统提示里注入**当前已装组件清单**（只注入 id + 一句话能力，不注入全文，避免撑爆上下文）

---

## 附录 A：废弃决议（保留可追溯性）

| 原决议（ARCHITECTURE v0.1） | 现状 | 原因 |
|---|---|---|
| Tauri 2 + Rust 核心 | ❌ 废弃 → Electron + Node | 用户要求用 pi 生态（TS）；且 Rust 侧无法复用 pi |
| 8 个 Rust crates | ❌ 废弃 → TS packages | 同上 |
| 自托管单二进制（rust-embed + Axum） | ❌ 废弃 → Docker 单容器 | 用户要求 Docker 部署；标准栈更易维护 |
| 生成应用默认 SQLite | ❌ 废弃（v1.1）→ **PostgreSQL** | 需求升级为"高性能应用 + 通用组件 + AI 小助手"，SQLite 在多写并发/扩展生态（pgvector、LISTEN/NOTIFY）上是硬短板；且切库要重写迁移 |
| `chord` 列为"可选，M5 再引入" | ❌ 废弃（v1.1）→ **基座，M5 主线** | 实际读源码后确认它就是插件生态的标准答案，晚引入等于先自研一遍再推翻 |
| BYOK 多提供商 | ✅ 保留并强化 | pi-ai 直接覆盖 |
| Git 版本管理 | ✅ 升级为一等公民 | 用户明确要求 |
| Apache-2.0 | ⚠️ 调整 | 改为 AGPL + Apache 双轨（商业护城河） |

## 附录 B：验证清单（写代码前先验证的四件事）

1. **pi-durable 最小闭环**：`Harness.open` + `submit` + `watchEvents` 在真实应用目录跑通流式输出与 `resume()`
2. **App Gateway 代理 HMR**：Vite HMR WebSocket 经自建网关可用（预览体验的命门）
3. **源码定位插件**：JSX 上 `data-tenon-loc` 能准确对应 file:line（尤其经 Tailwind/shadcn 组合组件后）
4. **★ PG 四档供给互通**（v1.1 新增）：同一份 TypeORM migration 能在 `lite` / `embedded` / `docker` 三种供给下跑通，且切换不改代码 —— 这是"开发态与生产一致"的唯一验证点

前三条任一不成立，方案需局部调整；第 4 条不成立，则"高性能应用"这个定位站不住。建议 M1 第一周全部做掉。

> 已完成的前置验证（2026-10-31）：`embedded-postgres` 18.6 的 darwin-arm64 / windows-x64 / linux-arm64 平台包均存在；`@electric-sql/pglite` 0.5.13 + `pg-gateway` 0.3 可提供 TCP 协议；Electron 39.8.9 内置 Node 22.22.1 满足 pi 全家 `>=22.19` 要求。

