# DESIGN.md — 详细方案设计 v1.2.7

> 状态：已定稿，进入实施。本文档是本项目**唯一事实来源**，取代 `ARCHITECTURE.md` v0.1（Rust/Tauri 方案已废弃）。
> 输入：`PROTOCOL.md`（妙搭逆向规格）+ 用户 11 条需求（2026-10-31）+ v1.1 定案（DB/插件/平台/命名）+ **v1.2 修正（数据库供给两档化、产品库改 `node:sqlite`、L2 插件分发三阶段、pi/Electron 平台边界澄清）** + **v1.2.1 修正（四个 spike 实测：`pool.max=1` 硬约束、`callsite` 双属性定位、LISTEN/NOTIFY 不可用 —— 见 `docs/SPIKES.md`）** + **v1.2.2 修正（M1 主干落地实测：isomorphic-git `statusMatrix` 会漏掉同长度改动、`pi.live` 无 token 增量 —— §4.5 / §12.2）** + **v1.2.3 修正（工具层接入实测：`pi-coding-agent` 工具签名 ≠ `pi-durable` 工具签名，必须过 adapter —— §4.3.1）** + **v1.2.4 修正（生成器与预览网关落地实测：模板变量残留、upgrade 两侧 socket 必须配对、`env` 覆盖对象不能当子进程环境 —— §8.7 / §9.1）** + **v1.2.5 修正（Web 渲染器 `apps/web` 落地实测：网关端口必须显式绑定否则 HMR 永远连不上、协议主入口不该进浏览器包、flex 容器缺 `flex-1` 会静默塌成 0 高 —— §9.1 / §14.6）** + **v1.2.6 修正（Electron 壳落地实测：页面改为 server 同源托管并在 index.html 注入 Token、`ELECTRON_RUN_AS_NODE` 泄漏会把 `electron .` 变成 node、esbuild 打 ESM 单文件必须注入 `createRequire` —— §2.2.1）** + **v1.2.7 修正（M2 全栈落地实测：Node ≥22.18 的原生类型擦除让 `ts-node/register` 彻底失效、PGlite 必须外部化才能进桌面包、`DATABASE_POOL_MAX` 的定位、`readiness` 从三格变四格 —— §6.4 / §9.1）**。
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
| 5b | 数据库供给 | 应用只认**一个 Postgres 连接串**；两档供给：**`pglite`**（WASM 版 PG，零安装，默认）/ **`postgres`**（Docker 自带 / external / 云托管，发布档）；`embedded` 与 `sqlite` 仅作逃生口 —— 详见 §6.4 |
| 5c | 组件与插件 | **chord 插件模型**：一 feature 一 contract + 每宿主一 facet；**L2 官方插件分发节奏 = M5 bundled 内置 → M6 Hub 官方独源 → M7 开放第三方上架**；免费/收费组件走同一套安装协议 —— 详见 §21 |
| 6 | 版本管理 | **Git**（isomorphic-git）：每轮改动自动 commit，发布时 push + tag；回滚 = revert + 可选 DB 快照还原 |
| 7 | 发布 | 生成 **Docker 产物**（多阶段构建、单容器单端口，compose 内含 PostgreSQL）+ 可选静态导出 |
| 8 | 预览 | 每应用一个 **App Gateway**（稳定端口）→ Vite dev server + Nest，HMR 走 WS 代理 |
| 9 | 精调 | 注入式 inspector：点选元素 / 框选区域 → 源码定位（file:line + 组件栈）+ 截图 → 注入对话 |
| 10 | 可观测 | chord 复制态 + `pi-telemetry` 跨度/指标 + 运行时探针（console/error/network/route）→ 面板 + 错误入库 + 一键修复 |
| 11 | 记忆 | 每个应用仓库内 `docs/AGENTS.md` + `.tenon/memory/*` ，Agent 有读写纪律 |
| 12 | 协议 | **AGPL-3.0-only**（Tenon/Server）+ **Apache-2.0**（Runtime SDK / 模板 / 生成物骨架）+ 商业双许可 |
| 13 | 首发平台 | **macOS（ARM64/x64）+ Windows（x64）**；Linux 作为次优先目标随 M5 补齐 |
| 14 | 免费策略 | **个人免费**（含全部核心能力）；企业为协作/合规付费；**L2 官方插件先随包内置、后进 Hub 官方独源**，第三方市场与收费组件延至 M7 |

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
    P["同源托管：server 发 index.html 时<br/>注入 window.__TENON__ + CSP"]
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
- 渲染器只认一个 `window.__TENON__ = { token }`（v1.2.6 起由 **server 在响应 index.html 时注入**，
  不是 preload），**Electron 与浏览器走完全相同的代码路径**
- 这样「Web 打开」不是附加功能，而是**架构的自然结果**；Agent（包括我）可以用浏览器/HTTP 直接驱动产品，读 DOM、截图、跑流程

### 2.2.1 桌面壳落地约束（v1.2.6 实测）

M1 第 9 步把 §2.2 的三条原则落成 `apps/desktop`。四条当时没写、踩了才知道：

1. **页面由 server 同源发出去，不用 `file://`、不用 preload 注入 Token。**
   `startServer({ webDir })` 让 Fastify 托管 `apps/web/dist`：首页免 Token，
   **响应 index.html 时把 `window.__TENON__={token}` 与 CSP 写进 `<head>`**，其余 `/rpc/*`、`/events`、`/api/*` 照旧要 Token。
   好处是页面与接口同源（CORS 彻底不参与）、前端路由回落只写一次、Token 不必经过任何特权通道。
2. **打包后 `process.execPath` 是 Tenon 自己，不是 node。**
   所以 supervisor 一律 `spawn(process.execPath, [server.mjs], { env: {...env, ELECTRON_RUN_AS_NODE: '1'} })`，
   既不要求用户装 node，也不用再塞一份 node 二进制（Electron 39 内置 22.22.1，`node:sqlite` 实测可用）。
3. **server 打成一个文件（esbuild），`templates` 必须落在 `dist/templates`。**
   依赖全是纯 JS（产品库是 `node:sqlite`，PGlite 只属于生成应用），12MB 单文件、零原生模块 —— 铁律 3 在打包脚本里
   用"扫 `dist/` 找 `.node`/`binding.gyp`，发现就失败"兜住。`registry.ts` 按 `import.meta.url` 找 `../templates`，
   所以 `dist/server/server.mjs` 的兄弟目录必须叫 `templates`。
4. **生命周期只有一个出口：`TENON_READY`。** 端口是 0（系统分配）、Token 每次随机；
   就绪前退出 → 报错并把 stderr 带出去；就绪后崩溃 → 退避重启并把**新地址**交回窗口；
   关窗即退出（单窗口产品留着进程 = 留一个占端口的 server）。

~~已知限制（M2 处理）：预览装依赖走 `pnpm install`（`TENON_PNPM` 可覆盖）。**没有 pnpm 的机器上，桌面版能建应用、能对话，但预览起不来。**~~
**v1.2.7 已解决**：安装包自带 pnpm —— `deps.ts` 的解析优先级是 `TENON_PNPM` → 随包的 `<Resources>/server/node_modules/pnpm/bin/pnpm.cjs` →
node 同目录 → `PATH`。打包实测：`pnpm smoke:desktop:packaged` 全绿，且安装包内仍是**零原生模块**
（pnpm 自带的 4 个平台 `reflink.*.node` 被 `build.mjs` 按扩展名过滤掉，删掉后 `pnpm install` 实测照常工作）。

### 2.3 为什么这样分
| 备选 | 问题 |
|---|---|
| 业务逻辑写在 Electron main（IPC） | Web 形态要重写一遍；main 崩溃=整个 App 崩；Agent 无法驱动 |
| server 内嵌 main 进程 | 同上崩溃隔离问题；Electron Node 版本受 Chromium 升级节奏约束 |
| 只做 Web（不套壳） | 用户要桌面级体验（文件对话框、托盘、自动更新、离线） |

### 2.4 Electron 与 SaaS 的关系（**正交，不是前置条件**）

一句话：**Electron 不是 SaaS 的前提，两者运行在不同位置上。**

因为 §2.2 已经确定「Electron 只做壳、业务在 HTTP Server」，所以：

| 部署形态 | 有无壳 | Server 跑在哪 | 谁访问 |
|---|---|---|---|
| **桌面版** | Electron | 用户机器（`ELECTRON_RUN_AS_NODE` 子进程）| 本机渲染器 |
| **自托管** | 无 | 用户自己的服务器 | 浏览器 |
| **SaaS** | 无 | 云端容器 | 浏览器 |

**同一份 server 代码，换个位置跑就是另一种形态。** 这是「Electron 不做业务」这条设计的真正红利 —— 它不只是让 Web 模式能开，而是让 SaaS 化**不需要重写**。

**那 Electron 到底给了什么？** 四项本地特权。这才是「生成的应用能做什么」的分界线：

| 生成应用能做什么 | 桌面版 | SaaS 纯 Web | SaaS + 桌面客户端 |
|---|---|---|---|
| 读用户本地 Excel / PDF / 图片 | ✅ | ❌ 需先上传 | ✅ 经客户端桥 |
| 连内网数据库 / ERP / localhost 服务 | ✅ | ❌ | ✅ |
| 调本地 CLI（ffmpeg / python / git）| ✅ | ⚠️ 仅容器内预装 | ✅ |
| 离线可用 | ✅ | ❌ | ⚠️ 部分（缓存）|
| 分享链接给同事直接用 | ❌ 需自托管 | ✅ | ✅ |
| 定时任务 / Webhook 7x24 在线 | ❌ 关机即停 | ✅ | ✅ |
| 多人同时使用 | ❌ 单用户 | ✅ | ✅ |
| **数据不出本机** | ✅ | ❌ | ⚠️ 混合 |

> **结论：SaaS 不是桌面版的超集，而是互补形态。** 所以「有了 SaaS 就不需要桌面版」与「桌面版能替代 SaaS」都不成立。妙搭没有选择（只能云端），Tenon 有 —— **"数据不出本机 + 自带 key + 能碰本地资源"正是 SaaS 抢不走的差异**。

**SaaS 化真正的成本不在 Electron，而在这六项 adapter**（全在 server 层，与壳无关）：

| 缺口 | 本地实现 | 云端实现 |
|---|---|---|
| 多租户隔离 | 不需要 | 每应用一个容器 / 微 VM（`gondolin` 在 Linux 可用 —— **这里才是它的主战场**）|
| 文件存储 | 本地 fs | 对象存储（S3 兼容）|
| 密钥 | `safeStorage` | KMS / Vault |
| 应用数据库 | PGlite | 托管 PG（每租户一个 database）|
| 认证 · 计费 · 配额 | 无 | OAuth + 计量 + 套餐 |
| 长连接 | 直连 | WS / SSE 负载均衡 + 粘性会话 |

**判断标准：本地能力有没有被抽象成接口。** 抽象了，SaaS 化是换实现；没抽象，就要动业务代码。这就是 `db-provisioner` / `NodeExecutionEnv` / `SecretStore` 这几层现在必须包好的原因 —— 它们不只是为了本地能跑，更是**给 SaaS 预留的插槽**。

> **可选的产品形态（M7 再评估）**：SaaS 版提供桌面客户端，让它退化为「本地能力代理」—— 云端应用通过安全通道请求客户端读写本地文件。这是 Figma 桌面版 / VS Code Remote 的路子，做出来即"云端协作 + 本地数据"的独一份。但安全模型复杂（权限弹窗、路径白名单、审计日志），M6 前不碰。

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
| 产品库 | **`node:sqlite`（Node 内置）** | Node 22.5+ 自带 | `tenon.db` / `harness.sqlite` / `telemetry.db`（单机注册表，零安装、**零原生模块、无需 `@electron/rebuild`**）|
| 应用库 | **PostgreSQL 18**（typeorm + pg） | 18.x | `pglite`（默认）/ `postgres`（发布）；`embedded`、`sqlite` 为逃生口 —— 见 §6.4 |
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
│       ├── src/main.ts           # 窗口、导航守卫、SMOKE 探针（只有生命周期）
│       ├── src/supervisor.ts     # spawn server + 解析 TENON_READY + 退避重启（不 import electron）
│       ├── src/paths.ts          # 打包前后资源路径的唯一算法
│       ├── build.mjs             # esbuild 打 server 单文件 + 拷模板与 web 产物 + 扫原生模块
│       └── electron-builder.yml  # files: 主进程 / extraResources: server,web,templates
├── packages/
│   ├── protocol/                 # ★ zod 契约：RPC 入参出参、SSE 事件、领域类型
│   ├── server/                   # Fastify 应用装配、路由、SSE 总线
│   ├── core/                     # 领域服务：应用注册、文件、Git、预览、导出
│   ├── agent/                    # pi 集成：harness 池、扩展、工具、6 角色、模型档位
│   ├── generator/                # 模板渲染 + 代码生成（AST 级补丁）
│   ├── component-host/           # ★ chord 宿主：facet 加载、principal 解析、插槽装配
│   ├── component-market/         # ★ 组件仓库客户端、manifest 校验、license 校验、本地缓存
│   ├── db-provisioner/           # ★ PG 两档供给（pglite 默认 / postgres 发布）+ 逃生口。统一暴露 DatabaseProvider 接口
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

### 4.3.1 工具层（`packages/agent/src/tools/coding.ts`）

> **v1.2.3 落地要点**：`pi-coding-agent` 与 `pi-durable` 对「工具」的定义**不一样**，直接用会编译不过、运行时也不通。

| | `pi-coding-agent` | `pi-durable` |
|---|---|---|
| 工厂 | `createReadToolDefinition(cwd)` | `defineTool({ ... })` |
| 执行签名 | `execute(toolCallId, params, signal, onUpdate, ctx)` | `execute(args, api, context)` |
| 返回值 | `AgentToolResult{ content, details, isError }` | `ToolExecutionResult{ output, details, isError }` |
| 流式 | `onUpdate(累计快照)` | `api.output(增量)` |
| 上下文 | `ExtensionToolContext`（UI/会话一大坨） | chord `Context`（`abortSignal` + telemetry） |

结论：**必须有一层 adapter**（这正好是铁律 3 的第二个落地点，和 `models.ts` 同一个道理）。

- **ctx 可以传 `undefined`**：bash 关掉 `exposeSessionEnvironment`，read/write/edit 根本不碰 ctx。不要为了"看起来对"去伪造一个 `ExtensionToolContext`
- **`onUpdate` 是累计快照，`api.output` 要增量** → 按前缀差量下发；快照被截断后不再是前缀就停止实时推流（最终结果仍完整）
- **`edit` 的入参是 `edits: [{ oldText, newText }]`**，不是 `old_string/new_string`。给模型看的 schema 由 `pi-coding-agent` 提供，别自己另写一份
- **`section()` 的 key 必须匹配 `/^[a-z][a-z0-9_-]*$/`** —— 写成 `tenon.workspace` 会让**每一轮 submit** 抛 `INTERNAL`（点号不合法）
- **边界**：文件工具的 `path` 必须在 `repo/` 内（越界返回错误结果、不抛异常，让模型自己改）；bash 的 `cwd` 钉死 + 环境变量按名字洗掉密钥与 `TENON_*`。系统调用级隔离留给 M7
- **`replay` 分级**：`read`/`write` = `safe`（幂等）；`edit`/`bash` = `unsafe`（`oldText` 可能已失效、`npm install` 重跑有副作用）

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

> **v1.2.2 落地要点（M1 实测）**
> 1. **`pi.live` 里没有 token 增量**。它只有运行态（`{run:{taskId,inputs}, generation:{attempt}}`），拿它做流式是死路。真正的增量在 `watchEvents` 的 `message_update.changes[].type === 'text_delta'`。
> 2. `message_end` 对**用户 entry 也会触发**。服务端只把 `role === 'assistant'` 的 `message.end` 推给前端，否则前端会把自己刚发的那条气泡重绘一次。
> 3. 增量帧的 `messageId` 在流式期间恒为 `'live'`：assistant entry id 要到 `message_end` 才存在，而一个会话同时只有一条在飞的回答。前端用一个 live 气泡接增量，收到 `message.end` 时替换成真实 id 的消息。
> 4. **客户端必须先连上 SSE 再提交**（与 Vite HMR 首帧同一个坑）。`GET /events` 会在建连时立刻写 `: connected`，前端据此判断可以发提交了。

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
│       ├── pgdata/                 # ★ 应用数据库目录（pglite 默认；供给 = embedded 时为 PG data dir）
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

### 6.4 数据库供给策略（PGlite 默认，PostgreSQL 发布）

**设计原则：应用代码只认一个 `DATABASE_URL`。** 生成的 NestJS 代码里没有任何"我跑在桌面还是 Docker"的判断，供给方式完全由平台层决定。这一条是硬约束 —— 一旦应用代码开始关心运行环境，导出就必然破。

> **v1.2 定案（2026-10-31）**：原先的四档（`embedded` 默认 / `docker` / `external` / `lite` 降级）**过度设计** —— 四档里有三档都是在解决"如何让一个原生 PostgreSQL 在用户机器上跑起来"，而这件事本身就是麻烦的来源。真正的解法是：**让默认档根本不需要"安装"**。故改为 **两档 + 两个逃生口**，方言始终是 PostgreSQL。

| 供给模式 | 何时使用 | 实现 | 并发 / 性能 | 依赖 |
|---|---|---|---|---|
| **`pglite`**（默认）| 桌面本地开发、预览、单用户应用、CI | `@electric-sql/pglite` 0.5 + `pg-gateway`，把 **WASM 版 PostgreSQL** 暴露成 TCP 端口，TypeORM 走标准 `pg` driver；数据落 `pgdata/` | 单写者串行；约为原生 PG 的 1/3~1/5 | **无**（~3.7MB gzipped，纯 WASM，零原生二进制）|
| **`postgres`**（发布）| Docker 导出、生产部署、SaaS | ① compose 内置 `postgres:18-alpine` ② 用户 `external` 连接串 ③ 云托管 PG | 原生 | Docker 或用户自备 |

**两个逃生口（适配器代码保留，不设为默认）**：

- `embedded` —— `embedded-postgres` 原生二进制。仅在用户明确要求"要原生性能且拒绝 Docker"时手动开启；Windows 路径与服务安装的麻烦因此被移出主路径。
- `sqlite` —— 极端降级档：仅当目标环境**连 WASM 都跑不起来**（极罕见）时，应用库降级为 `node:sqlite`。此时 migration 需适配（**这是唯一会引入方言分裂的档，默认永不启用**）。注意产品库（`tenon.db` 等）与此无关，它本来就是 SQLite。

四条实现要点：

1. **方言一致性是本次选型的第一约束。** PGlite 不是"SQLite 的替代品"，它就是 **PostgreSQL 编译到 WASM** —— 同一份 PG 解析器、同一套类型系统、同一套 SQL 语义。所以「本地 PGlite → 发布到真 PG」**不需要改一行应用代码、不需要重写 migration**，只换连接串。这是纯 SQLite 方案给不了的（见下方"为什么不用纯 SQLite"）。
2. **端口与生命周期归 App Gateway 管**（见 §9）。Gateway 在应用启动时按 manifest 拉起 DB（PGlite 进程内进程 / PG 用 `pg_isready` 探活）→ 注入连接串 → 起 Nest。DB 崩溃由 Gateway 重启并上报状态，前端能在 readiness 面板看到 `db: down`。
3. **迁移与快照。** TypeORM migration 是唯一 schema 事实来源。快照分两级：PGlite 用 `dumpDataDir()` 做整库归档（对应 `exports/<releaseId>/db.tar.gz`）；发布档用 `pg_dump --format=custom`（回滚时 `pg_restore`，对应妙搭 `resetArtifactVersion` 的 `dbRestore` 开关）。**跨档迁移**（PGlite → 真 PG）走 `pg_dump` 逻辑导出，因为方言一致所以可以直接导入。
4. **Docker 导出产物自带 PostgreSQL。** `docker-compose.yml` 里 `db`（postgres:18-alpine + 健康检查 + 命名卷）+ `app`（NestJS 单容器，`depends_on: service_healthy`）。用户 `docker compose up -d` 即上线，不需要外部数据库。

#### 落地形态（v1.2.7，M2 第 1 步实测）

`packages/db-provisioner` 是这一节的唯一实现，接口只有五个动作：

| 动作 | `pglite`（默认） | `postgres`（发布） |
|---|---|---|
| `start()` | 起 PGlite + 一条**全局串行队列** + `listen(0, 127.0.0.1)`（端口交给 OS，不猜） | **只探活**（`select version()`），不接管生命周期 |
| `stop()` | 关实例，**保留数据目录** | 空操作（库不归我们管） |
| `connectionString()` | `postgres://postgres:postgres@127.0.0.1:<port>/postgres` | 用户/平台给的那条 |
| `poolMax()` | **恒为 1** | 默认 10 |
| `dump()` / `restore()` | `dumpDataDir('gzip')` → `.tar.gz`；还原走 PGlite 自己的 `loadDataDir`（它内部解包） | `pg_dump --format=custom` / `pg_restore` |

四条必须记住的事：

1. **`pool.max` 只能通过 `DATABASE_POOL_MAX` 进到应用里。** 应用代码只认连接串，但连接池上限塞不进 URL。
   这不是"环境判断"（代码里没有任何分支），是**容量参数**：PGlite 档恒 1，真 PG 档默认 10。
   为了让"配了没生效"可观测，生成应用的 `/api/health` 要把**驱动实例上的真实值**回显出来
   （`dataSource.driver.master.options.max`），e2e 直接断言它等于 1。
2. **`stop()` 不删库、`start()` 幂等、还原后端口不变。** 停预览 = 关实例；再起来复用同一个 provider，
   端口因此不变，上层缓存的 `DATABASE_URL` 不会失效（`DatabaseManager` 按 appId 缓存 provider，只 stop 不丢）。
3. **数据库生命周期跟着预览走，不跟着进程走。** 30 个应用不该常驻 30 个 PGlite（每个 38MB + 100MB 内存）。
4. **`pglite → postgres` 跨档迁移走逻辑导出**（`pg_dump` 自定义格式），不是数据目录拷贝 —— 方言一致是这条能成立的前提。

> **★ 打包注意（v1.2.7）**：PGlite 不是纯 JS 包，`dist/` 里有 `pglite.wasm`（8.7MB）、`pglite.data`（6MB）
> 和几十个扩展 `.tar.gz`，运行时按 `import.meta.url` 的相对位置读。桌面构建必须把它 **external**
> 并把整个包拷到 `dist/server/node_modules/`；esbuild 打进单文件的后果是「应用起得来、对话正常，
> 一建全栈应用就 ENOENT pglite.wasm」，而构建本身一声不响地成功。

#### PGlite 的四个已知限制（必须在 `packages/db-provisioner` 里兜住）

| 限制 | 影响 | 缓解 |
|---|---|---|
| **单连接串行** | TypeORM 默认连接池 10，连 `pg-gateway`（0.3.0-beta.4）会串行化，高并发请求可能超时 | **`pool.max = 1`（硬约束，不是调优建议）**；NestJS 侧单例连接；Gateway 做全局请求队列 |
| **性能约为原生 1/3~1/5** | 数据量大或复杂聚合会明显变慢 | 只做开发/预览/单用户；超阈值时 UI 提示"升级到 PostgreSQL"并给一键迁移 |
| **扩展受限** | PostGIS 等需外部依赖的扩展不可用 | 常用扩展可通过 `@electric-sql/pglite/vector` 等子入口加载（**pgvector 可用**，AI 小助手的向量检索不受影响）|
| **0.x 版本** | API 可能变 | 与 pi 全家同样策略：`save-exact` 锁版本 + 适配器隔离，业务代码只见 `DatabaseProvider` 接口 |
| **单 backend 会话（实测新增）** | `pool.max>1` 时两条连接的开事务落在**同一个 backend** 上，一条 `ROLLBACK` 会把另一条已写入未提交的行一起抹掉 —— 是**静默数据损坏**，不是性能问题 | `pool.max` 写死为 1 并在代码里注释原因；要并行只能靠网关队列，不能靠加连接 |

> **`pool.max` 实测依据（v1.2.1，见 `docs/SPIKES.md` §1）**：pool=1 时 20 并发事务 P95 = 74.8ms 且语义正确；pool=2 时同一测试出现"A 事务两行只剩一行"。而 pool=2 对写的 P95 只从 23.5ms 降到 19.0ms（**19%**），收益远不足以承担数据风险。故 `pglite` 档 `pool.max` **恒为 1**。
>
> **另一个实测结论**：`LISTEN/NOTIFY` 在 PGlite + pg-gateway 下**收不到通知**（实测 0 条）—— `onMessage` 是一问一答，PGlite 的异步 `NotificationResponse` 没有回推通道。所以「后端改动推前端」只能走网关 SSE，不要指望 PG 通知。

> **为什么不用纯 SQLite**（用户 2026-10-31 提出，已评估并否决）：技术上完全可行（Electron 内置 Node 自带 `node:sqlite`，零依赖零体积，已实测确认）。但有两个长期代价：① **方言分裂** —— 本地 SQLite 而 SaaS 云端必须 PG，`jsonb`/数组/`timestamptz`/全文检索全不同，TypeORM 只能退化兼容，最终以"本地跑通、上云炸"的形式爆雷；② **AI 生成质量** —— SQLite 是动态类型，类型写错运行时静默通过，而 PG 会直接报错，对"生成代码"场景，严格性就是质量。PGlite 同时拿到了 SQLite 的零安装与 PG 的方言，是这两个约束的交集。

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

### 8.7 模板与生成器（M1 落地：`packages/generator`）

**模板是真实文件**（`packages/generator/templates/<id>/`），不是写在 TS 里的字符串常量：
编辑器能给 `tsconfig.json` / `.tsx` 语法高亮，改模板就是改文件，diff 一眼看得懂。
代价是发布时要带上这个目录（Electron `extraResources`），所以留了 `TENON_TEMPLATES_DIR` 覆盖。

**渲染只做 `{{ident}}` 替换**，不上 Handlebars/EJS：

- 只有一种占位符形状（标识符字符集），CSS 里的 `{{` 不会误伤
- 渲染后**必须没有残留**——残留意味着模板加了变量而调用方没给值，用户会看到字面的 `{{appName}}` 出现在界面上。这条由 `renderTemplate` 直接抛错守住
- 模板自己声明 `template.json.variables`，有测试逐文件扫描占位符并核对声明（新加变量忘了声明会被抓）

**铺模板的时机**：`AppStore.create` 里，`.gitignore` 写完之后、`initRepo` **之前**。
所以「建目录 + 铺模板 + 首次提交」是同一个 commit —— 不会出现"先一条空提交、再一条模板提交"这种让人以为改坏了的歷史。

**core 不依赖 generator**：`AppStore.create` 收一个 `scaffold` 钩子（`AppScaffoldContext → Promise<void>`），
由 `server` 注入 `scaffoldApp`。理由见 §3.2 的依赖方向：`server → core` 与 `server → generator` 是两条**平行**的边，
让 core 依赖 generator 之后，generator 想用 `TenonError` 就得反着依赖 core，立刻成环。

**M1 模板的最小化取舍**：`react-vite` 只带 react / react-dom / vite / typescript / `@vitejs/plugin-react`。
Tailwind 4 + shadcn 推后到 M2 随组件体系一起进——现在引会让首次 `pnpm install` 慢一倍，收益却要等组件库才兑现。

**`@vitejs/plugin-react` 必须选支持 vite 7 的版本**（5.x）。6.x 的 peer 是 `vite@^8`，
装上去只会得到一条 `unmet peer` 警告，然后在启动时以看不懂的方式失败。

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

> **实测确认（v1.2.1，`docs/SPIKES.md` §3）**：改文件 → HMR `update` 经网关送达 **134ms**；上游 Vite 重启换端口后 `updateRoute()` 只改指向，iframe URL 不变且 HMR 能在同一网关端口重连。
>
> 实现两条要点：① upgrade 用**原样 TCP 透传**（自己重放 `req.rawHeaders`）比 http-proxy 稳，`Sec-WebSocket-Protocol: vite-hmr` 能完整保留；② 客户端必须在握手前挂好 `message` 监听，否则丢掉 Vite 的 `connected` 首帧。

**★ v1.2.4 补一条（M1 实测）**：透传之后两条连接是**配对**的 —— 客户端断开时必须 `upstream.destroy()`，反之亦然。
漏了不会报错，只会漏水：Vite 每次整页刷新都重连一次 HMR，上游 socket 一个都不回收，
几百次之后 dev server 撞在 FD 上限上开始莫名拒绝连接。这个坑只有"真的去关一遍 stub 上游"才暴露
（`server.close()` 永远等不到回调，测试直接卡在 afterEach）。

**★ v1.2.5 补一条（最贵的一条，M1 实测）**：`startGateway` 的 `port` **必须显式传**，不能让它自己挑。

```
原因链：findFreePorts 先占下 gwPort → 写进 TENON_GATEWAY_PORT → 模板用它做 server.hmr.clientPort
        → 若不把 gwPort 传给 startGateway，网关会随机再绑一个
        → 浏览器里的 HMR 客户端被指去那个"已经写死在配置里、但没人监听"的端口
```

症状极其隐蔽：**页面照常打开**（iframe 用的是 `url`），服务端日志干净，我们自己连 `url` 的探针也能连上——
只有"iframe 里那份热更新"永远不来，表现为"改了代码要手动刷新"。所以断言要落在
**「`url` 的端口 === `gatewayPort`」**上（`packages/gateway/test/preview.test.ts` + `scripts/e2e-preview.ts`
各有一条），而不是"有个端口能打开就行"。

**★ v1.2.7 补一条（M2 双进程实测）**：一个应用现在要**三个**端口 —— `vitePort` / `apiPort` / `gatewayPort`，
仍然全部"先占再告诉"；`readiness` 从三格变四格（`deps / db / server / preview`）。

- **要不要起后端，看 `package.json.tenon.api`**（兜底看 `api/main.ts` 是否存在）。猜错的表现是
  「预览就绪、页面能开、所有 `/api` 请求 502」—— 比直接失败难查十倍。
- **`/api/*` 命中后端，其余兜底给 Vite**（最长前缀匹配）。两者在同一个源上，所以前端永远用相对路径
  `/api/xxx`：走网关、走 vite 的 proxy、将来走同域反代都是同一个地址，应用代码不需要知道自己在哪。
- **后端的 dev 循环是两段**：`tsc --watch` 编译 + `node --watch` 跑产物，`groupLaunched()` 把它们
  合成一个逻辑进程（任一半退出 = 整组失败），上层只看到"后端起没起来"。

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

1. **源码定位**（v1.2.1 实测修正，见 `docs/SPIKES.md` §4）：Babel 转换时按标签类型注入**两个**属性
   - 原生标签（`div`/`button`/`span`…）→ `data-tenon-loc="src/components/DishCard.tsx:42:7"`
   - 组合组件（`<Button>`/`<Card>`…）→ `data-tenon-callsite="src/pages/products.tsx:13:9"`，靠组件的 `{...props}` 透传到 DOM

   为什么必须是两个：只标 `loc` 时，点 shadcn 的 `<Button>` 会定位到 `components/ui/button.tsx` 的实现，而用户想改的是"我在这一页用了它"。选中的节点同时带两个属性时，**`callsite` 优先**，`loc` 作为 `secondary`（实现位置）一并带给 Agent。
2. **注入客户端**：`transformIndexHtml` 插入 `@tenon/runtime-sdk/inspector`

解析规则（`packages/runtime-sdk`）：元素有 `callsite` → `kind:'usage'`；只有 `loc` → 若命中组件库目录（默认 `src/components/ui/`）标 `kind:'component-impl'`（UI 提示"改动影响全局"），否则 `kind:'element'`；都没有则向上查找。

**代价与约束**：这套机制依赖"组件透传 props"。生成器产出的组合组件必须写 `{...props}`（进 `packages/generator` 模板与质量门禁），否则用户点它只能落到实现文件。

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
  /** kind: usage=用户写的那行；element=页面里的原生标签；component-impl=组件库实现内部 */
  loc?: { file: string; line: number; column: number; kind?: 'usage' | 'element' | 'component-impl'; component?: string; stack?: string[] }
  /** callsite 命中时的组件实现位置，一起给 Agent，便于判断改动影响面 */
  impl?: { file: string; line: number; column: number }
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
  → 计算变更（**自算 blob oid 比对工作区与 HEAD**，忽略 .tenon/、node_modules、*.sqlite）
  → 质量门禁（§8.6）
  → 生成 message：Conventional Commits，scope 取主要改动目录
      feat(dishes): 新增菜品管理 CRUD
      fix(ui): DishCard 价格字号
      chore(deps): 升级 zod
  → commit（author = Tenon Agent <agent@local>，trailer 写入会话/任务/模型）
  → 记录 plan 任务 ↔ commit 映射，推送 UI 版本时间线
```

> **v1.2.2 实测修正：不能用 `git.statusMatrix` 判断变更。** isomorphic-git 的 stat 快路径会把**同长度、同一毫秒内**的改动判成"没变"（`v1\n` → `v2\n` 时 statusMatrix 返回 `[1,1,1]`，`WORKDIR` walker 的 `oid()` 也返回旧值）。对「一轮一 commit」这是致命漏检，且完全静默。`packages/core/src/git.ts` 改为自己按 `blob <len>\0 + content` 算 sha1 与 HEAD 树比对，再 `git.add({ force: true })` 绕过 index 缓存 —— 宁可每轮多读一遍盘。该行为已有回归测试（`packages/core/test/git.test.ts`）。

**用户可回滚**：版本面板列出 commit（时间/摘要/模型/改动文件数/±行数），支持「查看 diff」「回滚到此」（`revert`，非 `reset --hard`，不丢后续历史）。

### 12.3 数据库回滚

代码能回滚，schema 也能回滚（下迁移），但**数据**不一定。策略：

- 每个执行过迁移的 commit → 生成 DB 快照 `snapshots/<sha>.*`（保留最近 20 个 + 所有 release）
  - `pglite` 档：`dumpDataDir()` → `snapshots/<sha>.tar.gz`（WASM 实例的整目录归档）
  - `postgres` 档：`pg_dump --format=custom` → `snapshots/<sha>.dump`
- 回滚时可选 `dbRestore: true` → 还原快照（**默认关闭**，UI 明确提示"会丢失此后数据"）；两档统一用 `DatabaseProvider.restore()` 抽象，调用方不感知实现
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
ENV NODE_ENV=production PORT=3000
# DATABASE_URL 由 compose 注入（postgres://app:***@db:5432/app），镜像内不写死
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
- 启动时自动跑迁移（`migrationsRun: true`）；**业务数据在 `db` 服务的命名卷里**，`/data` 卷只放上传文件与日志
- `docker-compose.yml` **默认即含 PostgreSQL**（`db` 服务 + 命名卷 + `service_healthy` 依赖）；`pglite` 档仅在本地开发与预览使用，**不进生产产物** —— 导出时自动把 `DATABASE_URL` 改写成 compose 内的 `postgres://` 连接串，应用代码零改动
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

### 14.6 渲染器实现约束（v1.2.5，`apps/web` 实测）

Web 渲染器（`apps/web`）是 server 的纯客户端：只经 `lib/rpc.ts` 说 RPC、经 `lib/stream.ts` 收 SSE，
不直连数据库、不 import 任何 `@tenon/core|agent`。三条落地时撞出来的硬约束：

1. **浏览器只 import `@tenon/protocol/browser`**。主入口的 `z.object(...)` 全在模块顶层求值，
   rollup 无法 tree-shake —— 实测把 zod 整张表打进产物：356KB → 256KB（gzip 109KB → 80KB，模块数 146 → 48）。
   该子路径只许放零运行时依赖的导出。
2. **`SSE` 必须"先连上再提交"**，且只能按 `sseEventTypes` 逐个 `addEventListener` ——
   `EventSource` 对带 `event:` 的帧不触发 `onmessage`，漏一种就是那类事件静默消失。
3. **两栏根节点必须 `flex min-h-0 flex-1 flex-col`**。少了 `flex-1` 它退回内容高度，
   里面的 `flex-1 overflow-y-auto` 连带塌成 0 —— DOM 里文字都在，界面上什么都没有。
   症状特别像"数据没回来"，实测是纯 CSS。

交互上还有两条"第一次打开就会被看见"的默认值：默认模板取 `react-vite` 而不是列表第一条（`blank` 建完是空目录，
预览必然失败）；`select` / `booted` 都要从应用列表里取回 `status`，否则状态栏会一直停在「准备中」。

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
> **v1.2 后该清单进一步收窄**：应用库默认改为 PGlite（纯 WASM）、产品库改用 Node 内置 `node:sqlite` 之后，**整个可用安装包里不含任何需要按平台编译的原生模块**；`embedded-postgres` 降为逃生口，不再位于默认路径。剩余平台差异只有三项：Electron 打包与签名、`gondolin` 后端缺失、端口探测命令。
> 推论：**只跑 Server + Web 模式（不打包桌面端）时，Windows 的适配成本接近于零**；桌面首发 Windows 的额外工作量集中在打包发货环节，而非 Agent 运行时。

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
| **PostgreSQL 全部供给模式（pglite / postgres / embedded）** | ✅ | ✅ |
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
| **M2 全栈生成** | Nest 模板、zod 共享、TypeORM/迁移、**PostgreSQL 两档供给（pglite 默认 / postgres 发布）**、CRUD 生成、runtime SDK、日志/错误面板 | ① 生成带 CRUD + PG 方言的全栈应用（默认 PGlite，零安装）；② **PGlite 与 PostgreSQL 两档跑同一份 TypeORM migration，切换只改连接串**；③ 从 PGlite `pg_dump` 迁移到 Docker PG，数据零丢失；④ Docker compose（含 db）构建并跑起来；⑤ 前端异常出现在错误面板 |
| **M3 精调与版本** | inspector、框选、截图、Diff 视图、回滚（含 `pg_dump`/`pg_restore`）、发布 push | ① 点选元素改样式并自验；② 框选区域批量改；③ 回滚到任意 commit，代码与数据一致 |
| **M4 多 Agent 与可观测增强** | 6 角色子 Agent、E2E 自验收、Reviewer、用量/预算、`taskGraph` 状态面板 | ① E2E 子 Agent 能发现并修复一个注入的 bug；② 任务图实时反映子会话；③ 超预算拦截 |
| **M5 组件体系（官方内置定型）** | chord 宿主接入、6 个标准插槽、`install_component` 工具、**bundled 插件加载器（`resources/plugins` 只读源）**、插件页 UI（列表 / 开关 / 来源标识）、L1 内置积木清单、L2 首发 3 个官方插件（AI 小助手 / Excel 导出 / 审批流）| ① 用一句话给应用装上 AI 小助手并可用；② 卸载后代码与 `AGENTS.md` 同步清理；③ 组件热重载不丢状态；④ **插件页能列出 3 个 bundled 插件并独立开关** |
| **M6 平台化与开源** | **macOS + Windows 双平台安装包**、**组件 Hub 上线（首期仅官方独源，第三方上架延后到 M7）**、覆盖层更新（hub 版 > bundled 版，不重装软件即可给内置插件打补丁）、收费授权（可延至 M6 末，不阻塞发布）、视觉/动效打磨、i18n、文档站、CI、协议与商标 | ① 两平台安装包签名可安装；② **Hub 里能装一个官方插件，且能在不重装软件的情况下更新一个已内置插件**；③ 新人 10 分钟跑通首个应用；④ 协议文件与贡献流程齐备 |
| **M7（后置）** | Linux、团队协作、托管能力（SaaS）、**第三方插件上架与审核** | 视社区反馈 |

依赖关系：M2 依赖 M1 的 harness 与事件流；M3 依赖 M2 的源码定位；M4 依赖 M3 的预览 API；M5 依赖 M2 的应用装配；M6 依赖 M5 的组件协议。

> **M2 进度（v1.2.7，2026-10-31）**：第 1 步已落地 —— `packages/db-provisioner`（两档供给 + `poolMax()` 恒 1）、
> `templates/nest-api`（NestJS 11 + TypeORM + PG 方言 + zod 共享层，迁移只写一份）、
> `preview.start` 双进程（Vite + Nest，网关按 `/api` 最长前缀分流）、桌面版自带 pnpm。
> **DoD ② 已满足**（同一份 migration 跑在 PGlite 与 postgres 两档上，切换只改 `DATABASE_URL`；
> `pnpm e2e:fullstack` 实测 `poolMax===1` 从驱动实例读回、迁移数 ≥1、CRUD 经网关、重启数据还在）。
> **仍欠：③ 跨档 `pg_dump` 迁移、④ Docker compose 产物、⑤ 日志/错误面板 + runtime SDK。**

> **平台顺序的说明（v1.2 收窄后）**：Windows 与 macOS 的技术差异只剩三项 —— ① 进程管理与端口占用（Windows 无 `lsof`，用 `netstat`/`Get-NetTCPConnection`）；② `gondolin` 微 VM 在 Windows 无原生后端（走 §15.3 方案 B）；③ Electron 打包签名与自动更新的平台差异。原先最大的两项（`embedded-postgres` 原生二进制分发、`node-gyp` 编译）已经通过「PGlite 默认 + `node:sqlite` 产品库」消除。**M1 仍建议双平台冒烟，但重点从"能不能跑起来"转为"打包链路通不通"**。

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
| **PGlite 仍在 0.x**（0.5.13，API 可能变）| 中 | `save-exact` 锁版本 + `DatabaseProvider` 接口隔离；最坏情况整体切到 `postgres` 档 —— 方言不变，**应用代码零改动** |
| **PGlite 单写者串行 / 性能约原生 1/3~1/5** | 中 | `pool.max = 1~2` + Gateway 侧请求队列；超过阈值（表行数 / P95 延迟）时 UI 提示并提供一键迁移到真 PG |
| `embedded-postgres` 逃生口仍是 beta（18.6.0-beta.x）| 低 | 已移出默认路径，仅用户显式开启时使用；`db-provisioner` 内隔离并 CI 冒烟 |
| **Windows 无 gondolin 后端** | 中 | 见 §15.3 方案 B（独立子进程 + 权限清单），并明确文档化能力差异 |
| **社区组件可访问用户应用数据** | **高** | L3 强制独立子进程 + `manifest.permissions` 逐条确认 + 无 `host.serve` 级能力；官方 L2 走签名 |
| **收费组件被绕过** | 中 | 授权在服务端 `principal` 层，非前端开关；license 用 Ed25519 签名 |
| PG 迁移耗时（PGlite → 真 PG，数据量大时）| 低 | 后台任务 + 进度条；`pg_dump` 流式管道传参，不落临时文件 |
| 组件插槽被滥用导致 UI 冲突 | 低 | 只开放 6 个标准插槽；同插槽多组件按 `order` 排序并限流 |

---

## 19. 决策记录与待确认问题

### 19.1 已拍板（2026-10-31 v1.1）

| 议题 | 决定 |
|---|---|
| 产品名 | **Tenon / 榫**（§1.5）|
| 生成应用数据库 | **PostgreSQL 方言**；两档供给：`pglite` 默认 + `postgres` 发布（§6.4，v1.2）|
| 首发平台 | **macOS + Windows**（Linux 随 M5）|
| 商业边界 | 认可 §16.2 那张表 |
| 商业模式 | **个人免费**；L2 官方插件 M5 bundled → M6 Hub 独源 → M7 第三方上架（§21）|
| 桌面框架 | Electron 39.x（已定）|
| 发布方式 | Docker 产物优先（已定）|
| LLM | BYOK 多提供商（已定）|

### 19.2 仍待你确认（不阻塞 M1，但影响 M2 之后）

1. **代码可见性节奏**：M1-M2 只给只读 + Diff，M3 再开放可编辑？还是从一开始就能直接改文件？（我的建议：M1 只读 + Diff，因为此时代码质量还在建立信任）
2. **个人免费的具体边界**：是否对"个人商用"也免费（如个体户用 Tenon 做外包交付）？这会影响后续定价与授权文案。
3. **Linux 支持的时间点**：M5 一起发，还是等 mac/win 稳定后单独发？

> **v1.2 已闭环两项**：原「收费组件结算方式」与「插件市场审核策略」因"L2 先由官方独家维护"而自动消解 —— bundled / Hub 独源阶段既不存在第三方审核，也不需要 license 体系。二者分别延至 M6 末与 M7（见 §21.4）。

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
| **L2 官方组件** | 我们官方（Phase 1 bundled 内置 → Phase 2 Hub 独源） | 签名校验 | 一键装 / 随包内置，自动更新 | AI 小助手、Excel 导出、审批流、地图 |
| **L3 社区组件** | 第三方开发者 | 沙箱 + 权限清单 | 显式确认权限后安装 | 行业专属（餐饮菜单、教培排课）|

L3 必须有真实隔离：**不能给社区插件 `host.serve` 级别的能力**，因为那等于给任意代码访问应用数据库。方案：
- L3 插件跑在**独立子进程**（`chord/node` 的 `createHostManager`），只通过 contract 暴露的 RPC 通信
- 文件系统访问走 gondolin 微 VM 或受限 `NodeExecutionEnv`（Windows 见 §15.3）
- `manifest.json` 的 `permissions` 声明（db:read / db:write / net:fetch / fs:app）在安装时逐条弹窗

#### 关于 L2 的分发节奏（v1.2 定案，2026-10-31）

**决策：暂不做开放市场，L2 全部由官方维护。** 分发分三阶段演进，但三个阶段**共用同一套 manifest 与同一个加载器**，只差一个 `source` 字段 —— 因此 Phase 1 → Phase 3 不需要重写任何东西。

| 阶段 | 分发形态 | 目录 | 更新方式 |
|---|---|---|---|
| **Phase 1（M5）** | **bundled 内置**：3 个官方插件随安装包发布 | `<app>/resources/plugins/<id>/`（只读） | 跟随软件版本 |
| **Phase 2（M6）** | **Hub 上线，仅官方独源**：官方插件可单独下载 / 更新 | `~/.tenon/plugins/<id>/<version>/`（可写） | 独立于软件版本 |
| **Phase 3（M7+）** | 开放第三方上架（审核 + 签名 + 分成） | 同上 | 同上 |

**加载器只有一条路径**，按优先级解析（**覆盖层机制**）：

```
解析顺序： hub 版（已装且 semver 满足 minTenonVersion） > bundled 版 > 不存在
```

这条机制带来一个实用能力：**内置插件也能热更新**。官方修了 AI 小助手的 bug，不必等整个 Tenon 发版 —— 推到 Hub 后用户点更新即可；卸载 hub 版则自动回落到 bundled 版，不会出现"应用缺组件"的悬空状态。M6 验收里"不重装软件就能更新内置插件"即指此。

**manifest 字段现在就定死**（Phase 1 也照填，只是 `source` 恒为 `bundled`、`signature` 为 null）：

```jsonc
{
  "id": "tenon.official.ai-assistant",
  "version": "1.0.0",
  "source": "bundled",                 // bundled | hub | local
  "minTenonVersion": "1.0.0",
  "signature": null,                    // hub 来源必须有（Ed25519）
  "permissions": ["fs:app", "net:fetch:api.openai.com"],
  "agentHints": "……",                  // 必填，安装时写入应用 AGENTS.md
  "pricing": { "type": "free" }         // free | paid（Phase 3 才用）
}
```

**为什么 M5 就要把 Plugin 页面做出来**（即使当时只有内置插件）：列表 / 开关 / 来源标识 / "官方 Hub 筹备中"占位。否则 M6 会同时面对"加载器改造 + UI 重构 + 更新机制"三件事，风险叠加在发布前。

**这个决定顺带关掉两个待办**（§19.2 第 2、4 问）：市场审核策略 → 首期只有官方独源，不存在第三方审核问题，延至 M7；收费组件结算 → 官方内置阶段不需要 license 体系，延至 M6 末（不阻塞发布）。

### 21.5 免费 / 收费组件的商业模式

> 以下描述的是 **Phase 3（开放第三方上架）** 的形态。Phase 1（bundled 内置）与 Phase 2（Hub 官方独源）阶段，官方插件全部免费或随软件授权，**不需要 license 体系**，见 §21.4 末的节奏表。

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
| 应用库四档供给（`embedded` 默认 / docker / external / lite） | ⚠️ 调整为**两档**（v1.2）→ `pglite` 默认 + `postgres` 发布 | 四档里有三档都在解决同一件事——"如何让一个原生 PostgreSQL 在用户机器上跑起来"，而这件事本身就是全部麻烦的来源。PGlite 是 PG 编译到 WASM，零安装且方言不变，把四档压成两档；`embedded` / `sqlite` 降为逃生口 |
| 产品库用 `better-sqlite3` | ⚠️ 改为 **`node:sqlite`**（v1.2）| Electron 内置 Node 22 自带 `node:sqlite`，消除原生模块与 `@electron/rebuild`，使安装包内**无任何需按平台编译的依赖** |
| `chord` 列为"可选，M5 再引入" | ❌ 废弃（v1.1）→ **基座，M5 主线** | 实际读源码后确认它就是插件生态的标准答案，晚引入等于先自研一遍再推翻 |
| BYOK 多提供商 | ✅ 保留并强化 | pi-ai 直接覆盖 |
| Git 版本管理 | ✅ 升级为一等公民 | 用户明确要求 |
| Apache-2.0 | ⚠️ 调整 | 改为 AGPL + Apache 双轨（商业护城河） |

## 附录 B：验证清单（写代码前先验证的四件事）

> **2026-10-31 全部完成 ✅** 详细数据见 `docs/SPIKES.md`，可复跑（`pnpm spike:db|agent|gateway|loc`）。

1. **pi-durable 最小闭环** ✅ 10/10：`Harness.open` + `submit` + `viewState` 流式 + `requestId` 幂等 + 自定义文档 + `taskGraph`；**流式中途 SIGKILL 后 `resume()` 把同一提交从 `placed` 跑到 `done`**（DoD 第 4 条兑现）
2. **App Gateway 代理 HMR** ✅ 8/8：HMR update 134ms；上游换端口网关 URL 不变
3. **源码定位插件** ✅ 7/7：改为 `data-tenon-loc`（原生）+ `data-tenon-callsite`（组合组件）双属性，9/9 定位可回溯
4. **★ PG 两档供给互通** ⚠️ **有条件通过**：PGlite 侧全部跑通（迁移/事务/jsonb/窗口函数/递归 CTE 等 8 项方言特性），但**发现 `pool.max>1` 会导致并发事务互相回滚** → `pool.max` 定为 **1**。`pglite → 真 PG` 的数据迁移（`pg_dump` 逻辑导出）尚未实测，列入 M2。


> 已完成的前置验证（2026-10-31）：
> - **pi 全家零原生模块**（解包实测：无 `.node`/`.gyp`/`.dylib`/`.so`/`.dll`/`.wasm`，无平台 `optionalDependencies`）→ Windows 无需 node-gyp / WSL
> - **Electron 内置 Node 自带 `node:sqlite`**（实测记录：Electron 37.10.3 / Node 22.21.1 提供 `node:sqlite` + SQLite 3.50.4）→ pi-durable 在 `ELECTRON_RUN_AS_NODE` 下可用；产品库可用内置模块，无需 `better-sqlite3`
> - Electron 39.8.9 内置 Node 22.22.1 满足 pi 全家 `engines >=22.19`
> - `@electric-sql/pglite` 0.5.13 + `pg-gateway` 0.3.0-beta.4 提供 TCP 协议，**TypeORM 压测已完成**（2026-10-31）：20 并发 P95 14→24ms、零超时；但 `pool.max>1` 会致并发事务互串 → `pool.max=1`。详见 `docs/SPIKES.md`
> - `embedded-postgres` 18.6 的 darwin-arm64 / windows-x64 / linux-arm64 平台包均存在（现仅作逃生口）

