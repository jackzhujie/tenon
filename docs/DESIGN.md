# DESIGN.md — 详细方案设计 v1.2.26

> 状态：已定稿，进入实施。本文档是本项目**唯一事实来源**，取代 `ARCHITECTURE.md` v0.1（Rust/Tauri 方案已废弃）。
> 输入：`PROTOCOL.md`（妙搭逆向规格）+ 用户 11 条需求（2026-10-31）+ v1.1 定案（DB/插件/平台/命名）+ **v1.2 修正（数据库供给两档化、产品库改 `node:sqlite`、L2 插件分发三阶段、pi/Electron 平台边界澄清）** + **v1.2.1 修正（四个 spike 实测：`pool.max=1` 硬约束、`callsite` 双属性定位、LISTEN/NOTIFY 不可用 —— 见 `docs/SPIKES.md`）** + **v1.2.2 修正（M1 主干落地实测：isomorphic-git `statusMatrix` 会漏掉同长度改动、`pi.live` 无 token 增量 —— §4.5 / §12.2）** + **v1.2.3 修正（工具层接入实测：`pi-coding-agent` 工具签名 ≠ `pi-durable` 工具签名，必须过 adapter —— §4.3.1）** + **v1.2.4 修正（生成器与预览网关落地实测：模板变量残留、upgrade 两侧 socket 必须配对、`env` 覆盖对象不能当子进程环境 —— §8.7 / §9.1）** + **v1.2.5 修正（Web 渲染器 `apps/web` 落地实测：网关端口必须显式绑定否则 HMR 永远连不上、协议主入口不该进浏览器包、flex 容器缺 `flex-1` 会静默塌成 0 高 —— §9.1 / §14.6）** + **v1.2.6 修正（Electron 壳落地实测：页面改为 server 同源托管并在 index.html 注入 Token、`ELECTRON_RUN_AS_NODE` 泄漏会把 `electron .` 变成 node、esbuild 打 ESM 单文件必须注入 `createRequire` —— §2.2.1）** + **v1.2.7 修正（M2 全栈落地实测：Node ≥22.18 的原生类型擦除让 `ts-node/register` 彻底失效、PGlite 必须外部化才能进桌面包、`DATABASE_POOL_MAX` 的定位、`readiness` 从三格变四格 —— §6.4 / §9.1）** + **v1.2.8 修正（M2 第 2 步日志链路实测：`/__tenon/log` 必须在网关层拦截不转发上游、子进程输出要先 `stripAnsi` 再去重、`LogStore` 合并后照样推 SSE（前端按 id upsert）—— §9.1）** + **v1.2.9 修正（M2 第 3 步：跨档迁移从 `pg_dump` 管道改为纯 JS 逻辑拷贝（用户机器上没有那些二进制）、运行时 SDK 采用源码分发、全局 `@Catch()` 必须补响应、堆栈续行要并进上一条日志 —— §6.4 / §9.1）** + **v1.2.10 修正（日志链路明确不用 CDP 采集：CDP 只覆盖浏览器侧、要独占 target（用户按 F12 就被抢走）、attach 之前的首屏崩溃与 HMR 重刷窗口内的事件都会丢，Node 侧要开 `--inspect` 等于给本机开一个可执行代码的端口 —— 改为应用自报 + 子进程管道，CDP 只留作未来性能面板的可选增强。同时按用户决定跳过 Docker 产物 —— §11.1.1 / §17）** + **v1.2.11 修正（M3 第 3 步点选链路实测：inspector 只能是 dev 动态 import、token 走 hash 不走 query、`postMessage` 的 targetOrigin 只能 `*` 所以校验必须全在父窗口侧且 `loc.file` 当不可信输入过滤 —— §10.1 / §10.2）** + **v1.2.12 修正（M3 第 6 步 Diff 与回滚：`git.diff` 给结构化逐行差异而不是让前端解析文本、看单条提交要用 `git.show` 而非 `git.diff`、§12.3 的 `pg_dump` 路线在「零安装」下不成立 —— §12.2 / §12.3）**。 + **v1.2.14 修正（M3 第 8 步发布 push：isomorphic-git 的 `push` 只走 HTTP 传输，本地备份改用「对象 + ref 直接搬运」到标准裸库；`writeObject` 传 string 会写坏 tag 对象，内容必须转 Buffer；备份库必须在仓库外面，否则会被自己提交进去 —— §12.1 / §13.3）**。 + **v1.2.15 修正（M4 第 1 步子 Agent 落地实测：`api.conversation()` 拿到的是 `ConversationHandle`，**没有 `configure()`** —— 子会话的模型/工具/指令只能在 `harness.createConversation({ agent })` 那一刻定，所以 `subagent` 工具要拿 Harness（闭包注入）；`ConversationRecord` 上的所有权字段叫 `owner` 不是 `ownership`；`faux` 的响应工厂只服务一次请求（`shift()`），必须把自己塞回队尾，且父/子会话要**分道**，否则子会话会把父轮的台词吃掉 —— §5.1 / §5.2）**。 + **v1.2.16 修正（M4 第 2 步任务图：pi 的 `owner` 是**任务树**不是会话树 —— 子会话里的 generation task 在它眼里没有 owner，显示上要按 `conversations` 回挂到"派它的那个工具 task"；角色（explore/librarian）图里根本没有，只能从工具 task 的 `checkpoint.arguments` 取，且只在 `phase: 'execute'` 之后才有 —— 判据是"工具 task 且已拥有会话"；静止时节点被回收，所以面板"图空即不渲染"且**不攒历史** —— §5.5 / §7.3）**。 + **v1.2.17 补充（M4 第 3 步用量与预算：`harness.usage()` 是**会话账本**，跨重启不丢、且天然把子 Agent 与压缩摘要算进去 —— 前端累加必然少一半，所以逐条 `usage` 事件换成了全量的 `usage.update`；熔断不是"预测下一笔"，pi 没有 pre-request 钩子，只能"花超了就停" —— §5.6）**。 + **v1.2.18 补充（M4 第 4 步 e2e 子 Agent 的预览工具：**不新起浏览器，让页面反连回来领命令** —— 网关往 HTML 注一行脚本 + HTTP 长轮询（`upgrade` 要原样透传给 Vite，自己再握手必坏）；`sessionId` 存 `sessionStorage` 才能跨整页重载；刷新只重投幂等命令；注入时 `content-length` 与 `transfer-encoding` 必须**一起**处理；扩展必须既 `registry.install` 又进会话的 `extensions`，否则工具"不存在"且不报错 —— §5.7）**。 + **v1.2.19 补充（M4 第 5 步 Reviewer：评审的对象是**工作区**不是提交（一轮收尾才 commit，看提交等于永远看上一版）；工作区差异不能走 `git.statusMatrix`；`typecheck` 的判据是「跑完了 + 没诊断」，缺 `node_modules` / 缺 tsconfig / 超时都必须说"没跑成"而**不能**说"通过"；`scrubEnv` 会删掉 `ELECTRON_RUN_AS_NODE`，桌面版里跑 `tsc` 得把它显式补回来 —— §5.8）**。 + **v1.2.20 补充（M4 第 6 步 CodeAct：能力边界是**三层**不是一层提示词 —— 会话的 `tools`、工具的 `callers`、`modelTools` 子集；不设 `modelTools` 模型就绕过脚本直读；脚本里 `tools.write` 调不动是因为它根本没被注进沙箱；`CodemodeSandbox` 按 `import.meta.url` 找 wasm 与 worker，**打包成功不等于能跑** —— §5.9）**。 + **v1.2.21 补充（M4 第 7 步发布门禁：判据是**三态**不是布尔 —— `skip`（这个应用没有那项检查）不拦、`fail`（该检查的没检查成功）必拦，混成一个 `false` 会让「没配测试」和「测试挂了」同罪；「没跑成」算 `fail` 不算 `skip`，否则删掉 `node_modules` 就能绕过门禁；用户 `force` 时**仍然跑检查**，只影响拦不拦 —— §5.10）**。 + **v1.2.22 补充（发布预检：`release.check` 只读地回答「能不能发」，与 `publish` 共用 `inspectRelease`；前提不满足时**不跑门禁**；`stale` 用前后两次 HEAD 判定 —— 过期的「通过」比不检查更糟；**不缓存**，点发布会再跑一遍 —— §5.11）**。 + **v1.2.23 补充（M5 前置 spike：chord 的对象默认 `lifetime: "referenced"` —— 最后一个引用释放就连 state 一起销毁且**不报错**，组件必须显式 `linger`；链路静默丢帧时调用会**挂住**而不是抛错，web facet 的每个调用都要自带超时；`in` 判断变体无效（Ref 是代理），验权限只能真调一次认 `not_in_variant`；chord 可与 server 同打包（726KB），不必像 pi-codemode 那样外部化 —— §21.2 / §21.3 / §21.5）**。 + **v1.2.24 补充（M5 第 2 步组件加载器：`mount` 不再写 `host`，**插槽决定宿主**（`app.api` 必在 server，其余必在 web）—— 让声明自己写只会多出一种错法；解析是**覆盖层**（`hub > bundled`，先看根再看版本），按"全局最高版本"选会让内置版盖掉热修；每条装配条目**独立判定**、失败只落一条 problem（21 个稳定 code），`component.list` 恒 200 —— 插件页要能说清"它为什么装不上"；`minTenonVersion` 对 `0.0.0`（开发构建）恒通过，代价是开发态测不出写错 —— §21.3）**。
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
   依赖恰好全是纯 JS（产品库是 `node:sqlite`，PGlite 只属于生成应用），所以能打成 12MB 单文件。
   ~~零原生模块~~ → **v1.2.13 起降为偏好**（见下方变更块）：打包脚本扫 `dist/` 找
   `.node`/`binding.gyp`/动态库，只**列清单 + 体积 + 平台标签**，不再让构建失败。
   `registry.ts` 按 `import.meta.url` 找 `../templates`，
   所以 `dist/server/server.mjs` 的兄弟目录必须叫 `templates`。
4. **生命周期只有一个出口：`TENON_READY`。** 端口是 0（系统分配）、Token 每次随机；
   就绪前退出 → 报错并把 stderr 带出去；就绪后崩溃 → 退避重启并把**新地址**交回窗口；
   关窗即退出（单窗口产品留着进程 = 留一个占端口的 server）。

~~已知限制（M2 处理）：预览装依赖走 `pnpm install`（`TENON_PNPM` 可覆盖）。**没有 pnpm 的机器上，桌面版能建应用、能对话，但预览起不来。**~~
**v1.2.7 已解决**：安装包自带 pnpm —— `deps.ts` 的解析优先级是 `TENON_PNPM` → 随包的 `<Resources>/server/node_modules/pnpm/bin/pnpm.cjs` →
node 同目录 → `PATH`。打包实测：`pnpm smoke:desktop:packaged` 全绿。

> **v1.2.13 变更：撤销「安装包零原生模块」这条硬约束。**
>
> **它原本就不是铁律。** 三条铁律是「Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 +
> adapter 包装」—— 前面几版文档和 `build.mjs` 注释把它误标成"铁律 3 在打包脚本里守住"，
> 属于自封的额外约束。现在按用户决定解除。
>
> **为什么解除是安全的：** 那条约束真正要解决的是「用户机器上 `npm i` 需要 node-gyp / 编译工具链」。
> 而安装包是**预编译分发**的 —— 原生模块在打包机上就编译好了，用户机器只负责解压运行。
> 换成二次开发（克隆仓库自己 `pnpm i`）场景时，这条才重新有意义，而那不是终端用户的路径。
>
> **换来的自由度：** 需要时可以直接引入带原生扩展的依赖（图像处理、列存分析、SQLite 驱动、
> 加密库…），不必先花一轮找纯 JS 替代品，也不用为了绕开限制去写"看起来能跑但精度/性能打折"的降级实现。
> 具体收益：
> - pnpm 自带的 4 个平台 `reflink.*.node` 不再被过滤（`install` 在 APFS/Btrfs/ReFS 上少拷一遍文件）
> - 未来若某个能力只有原生实现（如 `sharp`、`duckdb`），直接上，不再绕
>
> **放宽限制 ≠ 放弃审计。** 打包仍会扫出所有 `.node` / `binding.gyp` / `.dylib` / `.so` / `.dll`，
> 按体积排序打印，并标注「本平台 / 其他平台·不加载」。想恢复严格模式就设 `TENON_STRICT_NATIVE=1`
> （CI 可以用）。理由很简单：知道包里装了什么，和禁止包里装什么是两件事。
>
> **仍然守住的边界（这条没变，也不能变）：生成应用的依赖仍然不引入需要按平台编译的包。**
> 那是用户在**自己机器**上 `pnpm install`，我们没有替他预编译、也不该要求他装 Visual Studio / Xcode
> Command Line Tools。所以模板 `package.json` 的选型标准不变，变的是 Tenon 自己这一侧。

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
| 产品库 | **`node:sqlite`（Node 内置）** | Node 22.5+ 自带 | `tenon.db` / `harness.sqlite` / `telemetry.db`（单机注册表，零安装、无需 `@electron/rebuild`）|
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

**成本与预算**：`harness.usage()` 给出按模型/工具聚合的用量（session 账本，每个会话的 `pi.usage` 求和），直接读、不另写文档；额度按应用存在设置里（`budget.app.<appId>` = `{maxCostUsd, maxTokens}`），超限时在 `submit` 前拦截、跑到一半还会 abort —— 细节见 §5.6。

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
| **CodeAct** | 前台子会话 | comprehensive | `codemode`（脚本沙箱；**脚本内**可调 `read/ls/glob/grep`） | 批量读、过滤、汇总、一次性探查 |
| **Librarian** | 前台子会话 | fast | 只读 + `docs_search` | 查框架文档/项目约束，减少返工 |
| **E2E** | 后台子会话 | comprehensive | `preview.open/screenshot/click/type/assert` | 生成后自验收 |
| **Reviewer** | 前台子会话 | thinking | 只读 + `git_diff` + `typecheck/lint` | 提交前审查，出风险清单 |

实现要点（pi-durable 已验证的模式，**v1.2.15 按实测重写**）：

落地状态（**v1.2.20**）：五个子角色全部接好（`readiness: 'ready'`）。`codeact` 在 v1.2.20 接上
（§5.9）；`reviewer` 的 `typecheck` 已接、`lint` 未接（模板没有 eslint 配置，§5.8）。
`planned` 这条分支留着（下一个角色会用到），但表里目前没有这样的角色 —— 派活时那句"还没接、缺什么"
改由单测钉住，所以机制不会因为没入口而烂掉。

```ts
// 实测修正过的三处，别照抄速查表里的伪代码
const existing = await api.commit(async tx =>
  (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0] ?? null, ctx)

// ★ ① 子会话只能用 harness.createConversation({ agent }) 建：
//   `api.conversation(id)` 拿到的是 ConversationHandle，只有 submit/abort/waitForIdle —— 没有 configure()
let child = existing === null ? undefined : await harness.conversation(existing.id, ctx)
if (child === undefined) {
  child = await harness.createConversation({
    ownership: { kind: 'task', taskId: api.taskId },
    agent: { tools: toolsForRole(role), instructions: ROLE_PROMPT[role], cwd, model },
  }, ctx)
}
await api.details({ role, conversationId: String(child.id), reused: child !== undefined }, ctx)

// ★ ② requestId 固定成 `subagent:<role>`：重跑时拿回同一次提交，不会把同一件事做两遍
const settled = await (await child.submit(
  { type: 'input', content: subagentPrompt(role, task), requestId: `subagent:${role}` }, ctx)).wait(ctx)
```

- **工具要拿 Harness**：扩展必须在 `Harness.open` 之前建好（registry 得先有工具），所以 `subagent`
  用闭包拿一个懒读取器（`getHarness: () => harnessRef`），由 `HarnessPool` 注入。
- **一次工具调用 = 一个 task**：`api.taskId` 是**这次调用**的 task，不是根会话。
  所以同一轮派两次活是**两个子会话**（对的），幂等复用只发生在崩溃重跑时。
- **`ownerTaskId` 不是 `ownership.kind`**：`ConversationRecord` 上的字段叫 `owner`（`{conversationId, taskId}`），
  查"这个应用有哪些子会话"时按它过滤。


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

**已落地的工具名（v1.2.15，跟上面的规划名对齐后的实际值）**：
`read` `write` `edit` `bash`（来自 `pi-coding-agent`，过 adapter）+ `ls` `glob` `grep`（**我们自己的实现**）
+ `subagent`。其余组（Git / 构建 / 预览 / 数据 / 可观测 / 记忆 / 交付 / 脚本）按里程碑顺序接。
脚本组的实际取值见 §5.9：CodeAct 拿到的是 `codemode`（模型面）+ `read/ls/glob/grep`（脚本面），
**没有 `bash`** —— 规划表里的 `bash（受限）` 在落地时被去掉了，理由是可审性。

> **为什么 `grep` / `glob` 不用 `pi-coding-agent` 的同名工具**：它的 `grep` / `find` 走 `ensureTool()`，
> **首次调用会从 GitHub 下载 `rg` / `fd` 二进制**到 `~/.pi/bin` 再 spawn。对 CLI 合理，对我们是三处都错：
> ① 本地优先的产品在用户没网时第一次搜索就卡十秒然后失败；② 桌面版不该在用户机器上偷偷落地可执行文件
> （打包体积与签名审计都要为它让步）；③ 它自己解析 `cwd` 之外的路径，我们的越界守卫就漏了。
> 自己实现是纯 `node:fs` + 进程内正则，有上限（条目/匹配/单文件 512KB/扫 4000 文件），
> 生成的应用只有几十个文本文件，量级上用不着 ripgrep。

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

### 5.5 任务图：看得见子 Agent 在跑（v1.2.16 落地）

`subagent` 把活派出去之后，界面上只剩一张工具卡片 —— 看不见子会话是活着、在等模型，还是卡住了。
任务图补上这一层：`harness.watchTaskGraph()` → 归一化（`@tenon/core` 的 `normalizeTaskGraph`）
→ `taskgraph.update` 事件 → 预览下方的任务条。

**pi 给的图 vs 我们显示的图**（四处必须转译）：

| pi 的字段 | 它的含义 | 为什么要转 |
|---|---|---|
| `kind: 'pi.generation' / 'pi.tool'` | 任务类型 | 去掉 `pi.` 前缀 —— 前端不该认识宿主的命名空间 |
| `owner` | **任务树**的父节点 | 子会话里的 generation `owner` 是空的（它是会话自己的任务）。显示上要按 `conversations` 回挂到"派它的那个工具 task"，否则子会话会浮在最顶层 |
| `conversations` | 这个 task 拥有的会话 | 派活时就是子会话 id —— **"谁派了谁"的唯一直接证据**，比工具卡片可靠 |
| （没有角色） | — | 角色在工具 task 的 `checkpoint.arguments.role` 里。`subagent` 在 `phase: 'execute'` 内部才调 `createConversation`，所以**判据是"工具 task 且已经拥有会话"**：那个窗口里 `arguments` 一定齐了 |

查角色一轮对话大约 1 次，结果按 task id 缓存（含"查过但没有"）—— 每帧重查等于把数据库当草稿纸。

**静止即空，不能当历史。** pi 在任务落定后回收节点，跑完再查就是 `{tasks:{}}`（实测：一次派活 17 帧，
最后两帧节点数归零）。所以面板：

- **图空 → 整个组件不渲染**。它出现本身就是"现在有任务在跑"的信号
- **不攒历史快照**。攒出来的是"看起来像最近活动"的假象，与真实发生的事没有稳定关系
- 要回顾"派过几次活" → 看会话（`ConversationRecord.owner` 指向发起它的工具 task），不是这张图

**为什么不轮询**：一帧一次的状态变化，秒级轮询要么漏掉中间态、要么白烧请求。
`watchTaskGraph` 本身就是 exact-frame 的，且静止时不推。

**面板的样子**（`apps/web/src/features/tasks/TaskGraphPanel.tsx`）：

```
⌄ 任务  3  [1 个子会话]
● 主对话  等 1 个子任务
  ● 派活 Explore  执行中            派 #13
    ● Explore  等模型                #13
```

- 层级用 14px 缩进、不画树线：节点最多几个，线条只是噪声
- `phase` 一律翻成人话（`request` → 等模型、`execute` → 执行中），不让用户读宿主枚举
- 收起时那一行优先显示**派出去的那个**，而不是"最近变的那个"——那才是用户此刻关心的

### 5.6 用量与预算：花了多少、不许再花（v1.2.17 落地）

子 Agent 一开，一个问题可能同时跑三个会话。**钱是按 token 算的，而用户看不见任何数字** ——
这一层补上：看得见花了多少、能设一条线、顶到线就停。

**真值只有一处：`harness.usage()`。** 它是 session 账本（每个会话的 `pi.usage` 求和），
三个性质决定了别的做法都不成立：

| 性质 | 意味着什么 |
|---|---|
| 跨重启不丢（存在 `harness.sqlite` 里） | 额度也是跨重启的，否则"重启一下就重置"等于没设 |
| 含**所有**会话 | 子 Agent 的花费在它自己的会话里，父会话的事件流里根本没有 |
| 含**压缩摘要** | 摘要那次调用不产生 transcript entry，只进账本 |

所以 `usage` 事件从"逐条响应的量"改成了 **`usage.update` 推全量快照**：
前端累加不但会漏掉上面两项，还会在断线重连（`since` 重放）时把同一笔算两遍。
旧的 delta 事件当时也没人渲染 —— 一个"只写不读"的累加器比没有更危险。

**两个维度都要拦。** `cost.total` 在真模型上是钱，在 `faux` 上恒为 0（本地假模型不报价）；
`totalTokens` 两边都有。只按钱拦 → 本地一条熔断都验不了；只按 token 拦 → 对不上用户的账单。
所以 `Budget = { maxCostUsd, maxTokens }`，任一条顶到就拦，两条都不设就不拦。

**两个拦截点，缺一个都留不住钱：**

| 时机 | 手段 | 用户看到 |
|---|---|---|
| 开跑前（额度已经用完） | `chat.submit` 抛 `BUDGET_EXCEEDED`（**402**，不是 409 —— 这不是"等等再试"） | 错误条一句话：已用多少、上限多少、该调哪 |
| 跑到一半（一轮冲爆额度） | 每次模型响应后重算，顶到就 `abort` | `budget.exceeded` 事件 → 横幅 + 那一轮停下 |

**横幅看的是 `snapshot.exceeded`，不只认事件。** `budget.exceeded` 只在"跑到一半真被掐"时来；
用户手动把上限调到低于已用量那一刻没有任何人被打断，但那时确实已经发不出去了 —— 所以面板取
`stopped ?? snapshot.exceeded`，事件带来的维度优先（它指明是谁先撞的线）。

**没有 pre-request 钩子**：`hook()` 只挂在 task 的 `handlers` 上（`GenerationTask` 只有 `onYield`），
没有"发请求之前"这个点。所以熔断的语义是**「花超了就停」**，不是「预测下一笔会超就不发」——
代价是可能停在工具调用中间，与用户按停止键完全一样。

**额度按应用存**（`budget.app.<appId>`，settings 里一条 JSON）。
花超的永远是**某一个**应用的一轮（模型绕圈、反复读大文件），全局额度既解释不了"贵在哪"，
也没法只停掉那一个。**缺口（如实记）**：N 个应用各有一份额度，没有总闸；
真要"这个月最多 20 美元"得再叠一层按月的账 —— 现在没做。

**`turn` 是差值不是计数器。** 本轮开始时记下累计，之后 `now - base`（逐项 `max(0, …)`）。
这样"这一轮"里也包含子 Agent 与压缩摘要的花费 —— 而它们恰恰是最容易被漏掉的部分。

**读失败退回"不设限"，而不是"锁死"。** 拿不到账本就拦住所有请求的后果是"整个应用打不开"，
比多花几分钱严重得多。反过来 `0` 是**真的**关掉（`>=` 比较，用满即没有余额），
这条在测试里单独钉了一格 —— 用 `>` 会让"上限设 0"变成"不设限"。

**面板放顶栏，不放预览下方。** 它跟任务条不是一类东西：任务条空闲时不渲染（"没人跑"才是常态），
而"这个应用一共花了多少"随时都可能想看。点开是账 + 额度表单（在这里设上限，比另开设置页少三步）。

### 5.7 让 Agent 自己去点页面（v1.2.18 落地）

M4 DoD ① 的原话是「**E2E 子 Agent 能发现并修复一个注入的 bug**」。这条 DoD 没法靠读源码过：
读 `App.tsx` 看到 `value + 2` 只能说"这段和某个预期不一样"，说不出"用户点一下会看到 3 而不是 2"。
**证据必须来自 DOM。**

**决策：不新起浏览器，让页面反连回来领命令。** 三条理由，缺一条这个方案都不成立：

| 理由 | 说明 |
|---|---|
| 装 Chromium 违背本地优先的默认偏好 | 一百多兆下载 + 平台相关版本，为了验一个按钮不值得 |
| Web 模式下用户本来就开着一个浏览器 | 再起一个无头实例验的**不是**用户眼前那个页面（端口、注入、HMR 全不一样） |
| 桌面版里只有一个 Chromium | 它是 Electron 自己的，我们既不能也不该再 spawn 一个 |

所以通道方向是**反过来**的：网关往它转发的 HTML 里插一行 `<script>`，脚本加载后反过来向网关
`hello` → 领命令 → 回话。平台侧因此完全没有"浏览器怎么起"这个问题。

```
浏览器页面（被注入的脚本）
  POST /__tenon/page/hello   → 建会话，拿到 sessionId（顺带重投幂等命令）
  GET  /__tenon/page/poll    → 长轮询，挂着等命令（"read"/"assert"/"click"/"type"/"navigate"）
  POST /__tenon/page/reply   → 执行结果
网关（PageBridge）  ←→  agent 工具（preview_read / preview_assert / …）
```

**只有 HTTP 长轮询，没有 WebSocket。** 网关的 `upgrade` 是**原样透传**给 Vite 的（HMR 握手带自定义
header，代理改一个字就坏，§9.1）。在同一个 handler 里既要透传又要自己握手，是这个模块里最容易
写出"偶尔连不上"的写法 —— 用一个普通 GET 就没有这个交叉点。代价是每条命令多一次空转，
而命令是"人让 Agent 看一眼"级别的频率，不是每帧。

**`sessionId` 存 `sessionStorage`，不存内存变量。** 这条链路最常见的动作就是「改完代码 → 整页重载 →
再断言一次」。sessionStorage 跨 reload 存活（同标签页、同源），所以重载后仍是同一个会话，
挂账的命令还在队列里等着。存 JS 变量的话，"改完再验"会随机失败 —— 而且是那种"重跑一次就好了"
的失败，最难查。

**刷新时只重投幂等命令。** `read` / `assert` 做两遍没有副作用；`click` / `type` 做两遍可能点出两个
东西、输入两遍。`hello` 按命令名分档重投，不是"全部重来"。

**长轮询必须感知浏览器断开。** 整页导航会掐断挂着的请求，但网关侧那个 `await poll()` 还活着 ——
新页面的 `hello` 来之前，命令会被投给那条死连接，调用方只能等到超时（真机上 100% 复现）。
所以 `poll(sessionId, signal)` 接 `AbortSignal`，`res.on('close')` 里 abort，让命令**回到队列**。

**页内抛异常也必须回话。** `querySelector` 返回 `null` 再读 `.textContent` 会抛；只在成功路径回话，
调用方拿到的是"12 秒没回话"而不是"没找到第 1 个「#buy」（一共 0 个）"。`handle` 带 rejection 分支。

**五个工具，只有一个是"断言"：**

| 工具 | 参数 | 说明 |
|---|---|---|
| `preview_read` | `selector?` / `maxChars?` | 读页面文字（不给 selector 就是整页），元素带 tag 与选择器路径 |
| `preview_assert` | `text` / `selector`+`text` / `selector`+`count` / `selector`+`value` | 四种断言形态，失败时**带实测值** |
| `preview_click` | `selector` / `nth?` | 点第 n 个匹配（默认第 1 个） |
| `preview_type` | `selector` / `text` / `nth?` | 填值 + 触发 `input`/`change`（受控组件才认） |
| `preview_open` | `path?` | **整页重载**并等新会话，拿干净起点 |

**断言失败返回 `isError: false`。** 这不是"工具坏了"，是"页面和预期不一致"——模型该做的是回去改代码。
标成错误会让它换一个选择器重试、或者干脆换个断言绕过，两种行为都在浪费钱。
反过来**参数不合法**（写了 `value` 却没 `selector`）在**发命令之前**就拦住，那是真的工具错误。
工具输出里明确写「这是"页面与预期不一致"，不是工具坏了」，以及"该去改代码"。

**为什么 `preview_open` 单独存在。** React Fast Refresh **保留 state**：改完代码计数器还是旧值
（HMR 只换模块不重建根）。想验"从 0 开始点一次是不是 1"，必须先整页重载。这不是给用户的功能，
是给 Agent 的"把现场清干净"。

**依赖方向：`PageDriver` 是窄接口，不是 `@tenon/gateway` 的类型。**
`server → gateway` 与 `server → agent` 都成立，但 agent 不能反向依赖 gateway。
所以 `packages/agent/src/tools/preview.ts` 自己声明 `PageDriver { info, run, navigate }`，
网关的 `PageBridge` 天然满足它，接线在 server 里做（`getPageDriver: (appId) => preview.pages(appId)`）。
好处是单测能塞一个假 driver，把 Agent 循环整条验穿而不起真浏览器。

**HTML 注入的三个条件**，少一个就会把别的响应改坏：

1. 只改 `content-type` 含 `text/html` 的
2. 只改**未压缩**的（`content-encoding` 为空）—— 压缩过就得先解压再压，为一个脚本不值得
3. 插在 `</body>` **之前**：放 `<head>` 里执行时 `document.title` 还是空串

以及一个必须成对处理的头：`content-length` 要重算，**`transfer-encoding` 必须一并删掉** ——
两个同时存在时客户端永远等不到响应结束（表现为预览一直 `failed`，日志里什么都没有）。
用「显式带 `content-length` 的桩」测不出这个，得经真 upstream。

**工具要靠扩展才能被会话解析到。** `registry.install(extension)` 只是让工具"注册进注册表"，
会话找工具走的是它自己的 `extensions` 列表。漏了的表现极隐蔽：子会话里工具**不存在**，
模型若无其事地继续讲（"我看了一下页面…"），`execute` 一次都不进。所以 `harness-pool.ts` 里
`extensions: [coding, subagent, preview]` 这一行是硬要求，且 `preview` 扩展**只有 tools、没有 sections**
（它不往提示词里塞东西，靠角色自己的 `instructions` 说清工作顺序）。

**角色侧：`e2e` 从"定义好了但没接"转 `ready`。** 它是唯一拿得到这五个工具的角色，主角色
（`rootTools`）**没有** `preview_*` —— 要验页面必须派活。这也是对 §5.1「白名单是唯一事实来源」的
一次实证：改角色表不需要动工具层，改工具层也不需要动角色表。

**诚实边界（如实记）：**

- `faux` 下"发现 bug"是**剧本**安排的，不是模型推理出来的。但判据是真的：断言失败的实测值来自
  真 DOM，修完后同一条断言通过。换真模型只是把剧本换成一句话。
- 没有"跑一条用户旅程"的能力：只有单条命令 + 断言，不录制/回放一串操作。
- 只有点击与输入，没有 hover / 拖拽 / 滚动。
- 断言只看文字、数量、值，没有截图对比。
- 多标签页只有**最后一个**连上来的页面会被驱动（后到的 `hello` 覆盖前面的会话）。

### 5.8 提交前审查：让证据说话（v1.2.19 落地）

Reviewer 要回答「这一轮改的东西能不能提交」。这个问题的证据只有两份：**改了哪些行**、
**类型还是不是对的**。所以它只要两个工具，`git_diff` 与 `typecheck`，其余（`read`/`grep`）
用来在 diff 指到的地方深入。

**评审的对象是工作区，不是提交。** 这一条不写清楚就会做错方向：`commitAll` 在一轮**收尾**时
才跑，而 Reviewer 被派活时这一轮还在进行中 —— 给它一个"看已提交版本"的工具，它永远在审上一版。
所以 `git_diff` 默认 `HEAD ↔ 工作区`，`commit:"HEAD"` 才看上一版提交（工作区干净时它会自己指路）。

**工作区差异不能走 `statusMatrix` / `WORKDIR` walker。** 同一个坑（§12.2）：stat 快路径会把
「同长度、同一毫秒」的改动判成没变。对 commit 是致命（改动被静默跳过），对评审是"少看一个文件" ——
但**"评审说没问题、其实那个文件没看到"恰恰是最坏的一种绿**。所以同样按内容自算 blob oid。

**`typecheck` 的判据是「跑完了 + 没诊断」，不是「没诊断」。** 三种"没跑成"必须各有一句话，
且都不出现 `✓`：

| 情况 | 输出 | 为什么这么写 |
|---|---|---|
| 没有 `tsconfig.json` | `⏭ 无从跑起…这不等于通过` | 空项目/纯 JS 项目是合法的，但不能让"没检查"读成"通过" |
| 缺 `node_modules`（找不到 `typescript`） | `✗ 没跑成：依赖还没装好…这不等于通过` | 新建应用装依赖之前就是这个状态，很常见 |
| 超时 / 被信号杀掉 | `✗ 没跑成（退出码 超时/被杀）` | `tsc` 也可能卡住；卡住不等于通过 |

跑哪个 tsconfig 也是显式列举的：根 `tsconfig.json` 必跑，`tsconfig.server.json` / `tsconfig.app.json`
存在就跑 —— `nest-api` 模板的客户端与服务端是两份配置，只跑根的那份会漏掉整个后端。

**类型错误是信息，不是工具错误**（`isError: false`）。理由与 §5.7 的断言一致：标成错误会让模型
换个姿势重试工具，而它该做的是把这一条写进风险清单。

**桌面版里跑 `tsc` 要给回 `ELECTRON_RUN_AS_NODE`。** `scrubEnv` 刻意删掉这个变量
（防止生成应用的子进程"把 electron 当 node 跑"），但 `typecheck` 是**我们自己的**子进程：
在 `.app` 里 `process.execPath` 是 `Tenon.app` 的可执行文件，不补这个变量就会**真弹出一个窗口**，
而 `tsc` 一行也不会跑。只在 `process.versions.electron` 存在时才补。

**风险清单是一个格式约定，不是一段自由文本。** 提示词里写死「最多五条、最严重在前、每条一行
`[blocker|risk|nit] path:line — 什么问题 — 怎么修`」，并且要求最后一行交代"查了什么、什么没查成"。
理由：这份清单要回到主角色手里、最终给用户看，格式散掉就没人读得下去；而"什么没查成"这一句
是防止假绿的最后一环。

**lint 没接**（如实记）：模板没有 eslint 配置，硬塞一个会变成"每次评审都有二十条缩进警告"，
把真正的风险淹掉。等模板带上 lint 配置再补。

**为什么没有为它单独写一条 e2e 脚本。** 前四步的 e2e 都在验"浏览器里那件事"，而这一步不碰浏览器：
它的两个工具用的是真 git 与真 `tsc`，所以证据放在单测里 —— 临时仓库 + 本仓库装的 typescript
真编一遍（含"从应用自己的 `node_modules` 里找 tsc"这条真实路径），以及一条经服务端的 Agent 循环
集成测试（派活 → 子会话工具集 → diff 看到未提交改动 → typecheck 说"没跑成" → 清单回到父轮）。

---

### 5.9 脚本沙箱：一次调用换十个（v1.2.20 落地）

**模型不会写循环。** 「在这四十个文件里找出哪几个同时调用了 `submitOrder` 和 `commit`」用工具做，
是四十次往返、四十份正文进上下文、最后还得靠模型自己数；用脚本做，是一次调用、一行结论。
CodeAct 存在的理由只有这一条 —— 它不是"更强的 bash"，是**更少的转录**。

**用 `pi-durable` 自带的 codemode，不用 `pi-coding-agent` 那份。** 两份实现干的事一样，
但 `pi-durable/codemode` 的嵌套调用走 `api.executeTool()`，也就是走**我们已经在用的**那条工具管线：
参数校验、重放策略、输出上限全部照旧生效。上游那份绑在它自己的 agent loop 上，我们用不了。
另外 durable 那份带确定性日志（`pi.codemode.run` / `pi.codemode.journal`），重启能续跑 —— 这正是铁律 3
"实验性 API 要包一层"的又一处落点。

**能力边界是三层，不是一层提示词。** 想加一个工具时，先问清楚加在哪一层：

| 层 | 谁决定 | 我们的取值 |
|---|---|---|
| 会话里有哪些工具 | `AgentChange.tools` | `codemode` + `read` / `ls` / `glob` / `grep` |
| 谁能调它 | 工具自己的 `callers` | `codemode` 是 `["model"]`（**脚本不能起脚本**）；其余默认两边都可 |
| 递给模型哪些 | `AgentChange.modelTools`（子集） | 只有 `codemode` |

`modelTools` 这一层是本节的关键：不设它，`read` 会**同时**出现在模型手里，于是它绕过脚本一次次直读，
"四十次 read 只回一行结论"这个能力就白做了。而 `callers` 决定了脚本摸到的是四个只读工具还是九个 ——
脚本里 `tools.write` 之所以调不动，不是提示词拦的，是**这个工具根本没被注进沙箱**
（真去调会抛 `tools.write does not exist. Available: read, ls, glob, grep`）。

**没有 `bash`、没有 `write`/`edit`。** 规划表（§5.1）里给 CodeAct 写过 `bash（受限）`，落地时改成不给，
理由是**可审性**：主角色跑命令是一次一条、每条都在转录里、随时能被打断；脚本里四十条命令的输出
只有脚本自己看得到。而写工具一旦进沙箱，"子 Agent 只读"这条对五个角色都成立的不变式就破了 ——
`subagent` 的工具描述对模型承诺过这件事，它该一直是真的。要写就回主角色改。

**`models: false`。** 上游默认给脚本 `models.classify()` / `generateImages()`：那是**脚本自己发起、
按次计费**的模型调用，不经过父会话的事件流 —— §5.6 刚把预算熔断做出来，这里再开一个绕开它的口子不合适。

**60 秒 / 128MB。** 上游的 `timeoutMs` 默认 300 秒，对"一次工具调用"太长了：本地应用里
"五分钟没反应"和卡死没有区别，而派活的主角色会一直等在这条调用上。堆上限则是为了一个跑飞的
字符串拼接不要把 wasm32 的 4GiB 吃干净、把整个 server 带走。

**打包：构建成功 ≠ 能跑。** `CodemodeSandbox` 有两处按 `import.meta.url` 找东西 ——
`quickjs-wasi/quickjs.wasm`（`createRequire`）与 `./worker.js`（worker 线程入口）。esbuild 把整个
server 打成 `server.mjs` 之后这两条路径全指向 `server.mjs` 旁边，而**构建一声不响地成功**，
故障要到用户派活给 codeact 时才以"sandbox 错误"的形式出现。做法与 PGlite 同一条：外部化 + 整包拷进
`dist/server/node_modules/`，并在 `build.mjs` 里加 `assertCodemodeLayout()` 按运行期那两条规则
各解析一次（还要求解析结果落在 `dist/` 内 —— 解析到仓库自己的 `node_modules` 不算成功）。
这一步踩到三个具体的坑：

| 坑 | 症状 | 修法 |
|---|---|---|
| `require.resolve('@earendil-works/pi-codemode')` | `No "exports" main defined` | 它的 `exports` 只有 `types`/`source`/`import`，没有 `require`/`default`；`./package.json` 也没导出 → 用 `realpath` 拿 pnpm 软链指向的真包根 |
| 只拷 `quickjs.wasm` | `Cannot find ... quickjs-wasi/dist/index.js` | `vm.js` 会 `import { QuickJS } from "quickjs-wasi"` 拿它的 JS 驱动层，`dist/` 必须一起拷 |
| 过滤 `extensions` 目录 | `Cannot find ... quickjs-wasi/dist/extensions.js` | `extensions/*.so` 不拷（只有显式传 `QuickJS.create({ extensions })` 才加载），但别把同名的 `dist/extensions.js` 一起滤掉 |

**证据。** 三条服务端集成测试跑的是真沙箱（真 worker、真 QuickJS、真文件系统）：
① 派活 → 子会话 `tools` 只有 `codemode`、`callable` 只有四个只读工具 → 脚本 fan-out 读仓库里
八个源文件并统计 `useState` 出现次数，**产出的数字与测试自己算的一致**（这比断言一句话可靠：
沙箱没真读到盘就不可能对上）；② 脚本里 `write`/`edit`/`bash`/`subagent`/`codemode` 五个名字都不存在；
③ 脚本语法错误时模型看到的是 `Script failed` + 指向 `codemode.js:行` 的栈，不是一个"工具坏了"。

**缺口（如实记）**：① ~~脚本可以用 `// @options: {"timeout_ms": …}` 放大沙箱默认超时~~ ——
**已补（M6 收口后）**：`packages/agent/src/tools/codeact.ts` 的 `checkScriptOptions` 在工具入口
看一眼脚本头，超上限（180s）就拒绝并说清上限，`max_output_tokens` 同样夹在 8000
（那是唯一回到父会话上下文的东西）。**拒绝而不是静默钳制** —— 悄悄改成上限会让模型
误以为它要的超时生效了，再对"为什么还是超时"做错误推理；
② 没有配 `ExecutionEnv`，所以输出超过 token 预算时无法另存全文，只能看到截断版
（提示词因此要求"打印结论不打印数据"）；③ 嵌套调用不进父会话的事件流，用量按工具归集，
答不了「某个脚本里的某一次 read 花了多少」（与 §5.6 的欠账同源）；④ 脚本不能写文件，所以
「批量改」这类活现在只能由主角色一条条 `edit` —— 要放开得先想清楚怎么让它进 commit 审阅。

### 5.10 发布门禁：不过不许发（v1.2.21 落地）

`release.publish` 在打 tag 之前先跑一遍应用自己的 `typecheck` 与 `test`。不过就不发。

**判据是三态，不是布尔。** 这不是洁癖，是「没配测试」和「测试挂了」处置方式相反：

| 状态 | 含义 | 拦不拦 | 典型来源 |
|---|---|---|---|
| `pass` | 检查跑完了、通过了 | 不拦 | tsc exit 0 且无诊断；`pnpm run test` exit 0 |
| `fail` | **该检查的东西没检查成功** | **拦** | 有类型错误；测试红了；`tsc` 崩了/超时；有 tsconfig 却没装 typescript；有 test 脚本却没装依赖 |
| `skip` | **这个应用没有这项检查** | 不拦，但要说出来 | 没有 `tsconfig.json`；`package.json` 里没有 `scripts.test` |

判据因此只有一条：**`ok = 没有任何一项 fail`**。`skip` 放行是因为「这个项目不做类型检查」是
配置性选择（模板都带 tsconfig，真没有就是用户自己删的），而 `fail` 必拦是因为「有 tsconfig
却没装 typescript」不是「没得检查」，是「检查没做成」—— 把后者归到 `skip` 等于**删掉 node_modules
就能绕过门禁**，那是自欺。

**`force` 时仍然跑检查。** 用户可以坚持发一个有类型错误的版本（他可能比检查更懂，也可能只是急），
但**不能不知道自己在放过什么**。所以 `force` 只影响「拦不拦」，不影响「跑不跑」：结果照样算出来、
照样写进发布记录（`gateStatus: 'forced'`），界面上那个「带问题」标记就是从这来的。闸门要能开，
但开了要留痕 —— 半年后有人问「这版为什么带着错误上线」，答案得在记录里。

**留痕不能伪造。** 迁移 2 给 `releases` 加了 `gate_status` / `gate_summary` 两列，**两列都可空**：
迁移 2 之前发出去的版本没跑过门禁（那时候还没这个功能），读出来必须是 `null`，不能给个
`'pass'` 默认值把历史全改成「检查通过了」。同理 `pass` 包含「全部 skip」那种情况 —— 那是
「没得检查」，不是「偷偷发的」，不该标 `forced`。

**门禁排在版本号之前。** 否则用户会看到版本号一路往上跳（-3、-4、-5），却一版都没发出去，
还以为自己发过好几版。

**与 Reviewer 共用一份实现。** `runTypecheck` 同时服务 Reviewer 的 `typecheck` 工具和发布门禁：
一个要报告、一个要判据，但「什么算通过」只能有一个答案。共用还顺带守住了那个只在桌面版炸的坑
（`scrubEnv` 会删 `ELECTRON_RUN_AS_NODE`，不补回来 `tsc` 一行不跑、反而弹出一个窗口 —— §5.8）。
两份实现 = 两份记住这个坑的机会，早晚漏一个。

**`test` 只认 `scripts.test`。** 不猜 `vitest` / `jest` / `node --test` —— 猜错的表现是「跑了个不
存在的命令、退出码 1」，用户会看到一条莫名其妙的失败。没有脚本就是没有，说清楚就好。
跑的时候带 `CI=1`：`vitest` 默认是 watch 模式，不加会**一直挂着**直到超时被报成「测试超时」，
那不是测试的问题。

**证据。** ① 集成测试造一个真有类型错误的应用：发布被拒、`details.checks` 里 `typecheck: fail` 且
带 `TS2322`，而**仓库里既没有 tag 也没有发布记录**（不许留「有 tag 没记录」的半成品）；② 同一应用
改成正确代码后发布成功，记录是 `pass`、摘要 `类型检查 ✓ · 测试 ⏭`（模板没有 test 脚本 → skip，
不是「测试通过了」）；③ 带 `force` 发布：`ok=false`、`gateStatus='forced'`、摘要含 `类型检查 ✗`；
④ `scripts.test` 换成 `process.exit(1)`：拦下来了，且 `typecheck` 那项仍是 `pass`（说明拦的真是
测试，不是「反正都不让发」）；⑤ 迁移测试从 v1 库升上来，老记录 `gateStatus` 是 `null`。

**缺口（如实记）**：① 门禁只看类型与测试，不看 `lint`（模板没有 eslint 配置，硬塞会把真风险
淹掉 —— 与 §5.8 同一个欠账）；② 发布的仍是本地备份库，「发到真远端」还没有 transport（§13.3）；
③ 检查结果只在发布对话框里出现，主界面上没有「这个应用当前能不能发」的指示。
（原来的第①条「没有预检」已经补上了，见 §5.11。）

### 5.11 发布预检：把「点了才知道」变成「打开就知道」（v1.2.22 落地）

`release.check` 只读地回答一个问题：**现在这一版能不能发**。对话框一打开就跑它。
门禁只在 `publish` 里跑的话，用户是点了才知道，而这一步的全部价值恰恰是在发之前知道。

**它与发布共用同一个函数。** `release.publish` 内部也调 `inspectRelease`，只是拿到结果后
按 `blocked.code` 抛对应的错误码。两份实现必然漂移，而漂移的表现是「预检说能发、点下去却被拦」——
一旦出现，用户就会绕开预检，这个功能等于不存在。

**前提问题与代码问题是两种「不能发」。** 返回值里把它们分开：

| 字段 | 什么时候有值 | 意味着 | 界面 |
|---|---|---|---|
| `blocked` | 正在生成 / 没有提交 / 工作区脏 | 现在**没到**检查代码那一步 | 黄条 + 按钮置灰 |
| `gate.ok=false` | 检查跑完，有 `fail` 项 | 代码有问题，改完再查 | 红清单 + 主按钮「重新检查」 |
| `stale` | 检查期间 HEAD 变了 | 这份结论讲的是上一版 | 黄条 + 「重新查一次」 |

**前提不满足时不跑门禁**（`gate` 为 `null`）。工作区脏却去跑一遍 `tsc` 和测试，既白等几十秒，
又让人以为「测试修好就快能发了」—— 真正该做的是把这一轮跑完。`gate` 是 `null` 而不是
「跑了但没过」，这两个结论对用户的含义完全相反。

**`stale` 是这一节最要紧的一格。** 检查是**真跑**（`tsc` + `pnpm run test`），可能几十秒；
这期间 Agent 又提交了一轮，那份针对 A 版的「通过」就作废了。一份过期的通过**比不检查更糟**
—— 它给的是虚假的安心。所以前后各读一次 HEAD，不一致就 `stale`，即使 `gate.ok` 为真
`ready` 也是 `false`。`publish` 里遇到 `stale` 直接抛 `APP_BUSY` 让人重来：那时候挑哪一份结果
去打 tag 都是错的（正常不该发生 —— 前端按钮是禁用的）。

**不缓存。** 理由同上：缓存会让门禁看到一个过期的答案，而这个功能的全部价值就在于「答案是现在的」。
代价是用户点发布时服务端会**再跑一遍**（预检那一遍不复用），界面上写明了这一点。
唯一做的是**并发合并**：同一应用同时只跑一份（按 appId 的 in-flight 表），结果一出来就删。
两次预检等于同一个目录里两套 `tsc` + 两套 `vitest`，后者会往 `node_modules/.vite` 写缓存，
两个进程抢同一个目录是真实的故障源。

**`ready` 不是按钮的 disabled 依据。** `ready=false` 有两种，一种是真不能发（`blocked`），
一种是检查没过但用户有权坚持（`force`）。把 `ready` 接到 disabled 上等于把「仍然发布」焊死。

**界面上主按钮是「重新检查」。** 检查没过时绝大多数人会去改代码再来一遍，把逃生舱（「仍然发布」）
摆成主按钮等于把它放在驾驶座旁边。逃生舱降成左侧 ghost：点了先变红、文案变
「确认：带着问题发布」，**再点一次**才真的发。第一次点击只改状态，所以双击不会误发。

**证据。** ① 预检之后仓库里既没有 tag 也没有发布记录、备份库根本没建，紧接着不带 `force` 发布
版本号仍是 `-1`；② 检查没过时 `blocked=null` + `gate.ok=false`，而 `publish` 报同一个原因；
③ 工作区脏时 `gate=null`；④ 用 4 秒的慢测试造出窗口，中途提交一次 → `stale=true` 且
`gate.ok=true` 但 `ready=false`；⑤ 两次并发预检的 `elapsedMs` 完全相同（同一份结果）；
⑥ Electron 里截图走过两态（门禁失败 / 检查中）。

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
├── backups/<appId>.git             # ★ 发布目标：本地裸库（`git clone` 就得到那一版）
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
3. **迁移与快照。** TypeORM migration 是唯一 schema 事实来源。快照分两级：PGlite 用 `dumpDataDir()` 做整库归档（对应 `exports/<releaseId>/db.tar.gz`）；发布档用 `pg_dump --format=custom`（回滚时 `pg_restore`，对应妙搭 `resetArtifactVersion` 的 `dbRestore` 开关）。**跨档迁移**（PGlite → 真 PG）走**纯 JS 逻辑拷贝**（v1.2.9 变更，见下），不走 `pg_dump` 管道。

   > **v1.2.9 方案变更（实测驱动）**：原方案是 `pg_dump --format=custom` → `pg_restore`。落地时发现两个问题：① 本机（2026-11-01）`pg_dump not found`、`docker not found` —— 用户机器上同样不会有；一个「双击装完零安装」的产品让用户先 `brew install postgresql` 才能发布，等于把最难的一步留到最后。② 跨档迁移只需要**数据**，结构由 migrations 在目标库生成（同一份 migration 两档同跑，见 M2 第 1 步），`pg_dump` 连 DDL 一起搬反而要处理 `--no-owner`/`--no-acl`/扩展等一堆无关项。
   > 现方案 `packages/db-provisioner/src/migrate.ts`：两端都通过 PG 协议连接（PGlite 侧是 pg-gateway 暴露的真协议端），`information_schema` 拿表/列，`pg_constraint` 拿外键做拓扑排序，分批 `insert ... on conflict do nothing`，最后 `setval` 对齐序列并逐表比对 `count(*)`。**零二进制依赖，两档通用。**
   > `pg_dump` 仍保留在 `PostgresProvider.dump()` 里用于**发布档的整库快照**（那里目标是真 PG，用户本来就有 PG 环境）。
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
4. **`pglite → postgres` 跨档迁移走逻辑拷贝**（纯 JS，v1.2.9 变更），不是数据目录拷贝 —— 方言一致是这条能成立的前提；「只搬数据不搬结构」正是它能做到零二进制依赖的原因。

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

event: usage.update
data: {"seq":1050,"appId":"...","snapshot":{"appId":"...","totals":{"input":18342,"output":2210,"cacheRead":0,"cacheWrite":0,"totalTokens":20552,"costUsd":0.0361},"models":{"deepseek/deepseek-v4-pro":{"input":18342,"output":2210,"cacheRead":0,"cacheWrite":0,"totalTokens":20552,"costUsd":0.0361}},"tools":{},"turn":{"input":18342,"output":2210,"cacheRead":0,"cacheWrite":0,"totalTokens":20552,"costUsd":0.0361},"budget":{"maxCostUsd":5,"maxTokens":null},"level":"ok","exceeded":null}}

event: budget.exceeded
data: {"seq":1052,"appId":"...","dimension":"cost","snapshot":{"...":"同上，level 为 over"}}

event: preview.ready
data: {"seq":1060,"appId":"...","url":"http://127.0.0.1:41001","readiness":{"deps":"ready","server":"ready","preview":"ready"}}

event: taskgraph.update
data: {"seq":1065,"appId":"...","graph":{"rootConversationId":"1","nodes":[{"id":"9","kind":"generation","scope":"root","status":"waiting","phase":"tools","waitingOn":["12"],"spawned":[],"role":null,"parentId":null,"ownerId":null,"conversationId":"1"},{"id":"12","kind":"tool","scope":"root","status":"running","phase":"execute","waitingOn":[],"spawned":["13"],"role":"explore","parentId":"9","ownerId":"9","conversationId":"1"},{"id":"21","kind":"generation","scope":"delegated","status":"running","phase":"request","waitingOn":[],"spawned":[],"role":"explore","parentId":"12","ownerId":null,"conversationId":"13"}]}}
```

> `taskgraph.update` 推**全量**而不是增量：一张图只有几个节点，推 diff 要维护"哪个 op 对应哪个节点"
> 的状态机，而它带来的收益抵不上一次算错就显示错节点的代价。图空 = 现在没有任务（静止回收，见 §5.5）。

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

**★ v1.2.8 补一节（运行日志链路，M2 第 2 步落地）**：网关同时是**日志的汇流点**，
`packages/gateway/src/logs.ts` 的 `LogStore` 按应用隔离（`Map<appId, entries[]>`，上限截断）。

- **三个来源**：① 子进程 stdout/stderr（`vite` / `api`，经 `spawnLogged` 的 `onLine` 钩子；
  **tsc 编译报错也归 `api`** —— 它同样意味着"后端起不来"）；② 页面主动上报（`web`：
  `window.onerror` / `unhandledrejection` / ErrorBoundary → 同源 `POST /__tenon/log`，
  网关在路由分发**之前**拦下这条路径，回 204，**不转发上游**）；③ 平台自己的关键节点
  （`tenon` / `db`：启动、依赖装好、库就绪、预览就绪、失败原因 + 子进程尾部输出）。
- **事件与 RPC**：增量走 SSE `app.log`（带完整 `LogEntry`）；首拉/清空走 `logs.list` / `logs.clear`。
  **日志跟应用走不跟预览跑** —— 停预览缓冲还在（用户切回来还能看到刚才那条报错），
  `app.delete` 才连缓冲一起丢。
- **去重语义**：同一句 message 在 1 秒内重复 → 合并成 `repeat++` 且 **id 不变**；
  合并后的那条**照样推**（`pushLog = store.add + 无条件 publish`），前端按 id upsert
  → 界面上是"一条 ×N"，不跳行、不刷屏。子进程输出必须先 `stripAnsi` 再进这条链
  （Vite 的颜色码会让去重失效、界面全是 `[2m`）。
- **模板侧零依赖**：`tenon-log.ts`（原生事件 + fetch keepalive）与 `tenon-boundary.tsx`
  在 `react-vite` 与 `nest-api` 里各存一份（模板自包含原则）；M2-3 收编成 `@tenon/runtime`。
  上报**不带任何平台凭证** —— 走同源相对路径，网关本身不校验 Token。

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

**落地方式（v1.2.10 实测，与上面的初稿有出入）**：不做独立的 `tenon-inspector-plugin` 包 ——
生成应用不装平台包（铁律 2），所以走「源码分发 + 模板自己挂」：
`packages/runtime-sdk/src/vite/tenon-loc.ts`（Babel 插件）与 `src/browser/tenon-loc.ts`（反查器）
由 `sync-templates.mjs` 拷成模板里的 `src/tenon-loc-plugin.ts` / `src/tenon-loc.ts`，模板的
`vite.config.ts` 用 `react({ babel: { plugins: [[tenonLoc, { appRoot: import.meta.dirname }]] } })` 挂上，
且只 `command === 'serve'` 才挂（生产产物不写源码路径）。

**点选客户端（v1.2.11 落地）**：`packages/runtime-sdk/src/browser/tenon-inspector.ts`，同样源码分发进模板，
由 `main.tsx` 在 `if (import.meta.env.DEV)` 里**动态 import**（生产构建才摇得掉）。
Alt 按住进检查模式 → `event.target` 命中元素 → overlay 描边 + 跟随标签 → Alt+Click 组上下文 →
`postMessage` 给父窗口。四条实测约束：

- **overlay 必须 `pointer-events: none`**，否则鼠标永远命中 overlay 自己，"什么都选不中"
- **选中那一下要在 capture 阶段 `preventDefault + stopPropagation`**，否则生成应用自己的 onClick 会跟着触发
- **只走 `event.target`，不用 `document.elementFromPoint`**：后者在 jsdom 里没有实现，而 target 两边都有
- **安装是异步的**（动态 import），比首屏晚几十毫秒 —— 真实用户碰不到，e2e 必须先轮询 overlay 节点再点击

传输设计：token 由父窗口生成、经 **iframe 的 hash** 下发（`#tenon-inspector=<token>`；query 会进访问日志），
子页面 `postMessage(msg, '*')` —— **targetOrigin 只能写 `*`**，因为子页面在网关源、不知道父窗口是谁。
防护因此全部落在父窗口侧（`apps/web/src/lib/selection.ts`）：`event.origin` + `data.source` + `data.token` 三道，
并且把 `loc.file` 当**不可信输入**（拒绝对路径 / `..` / 盘符）—— 它会原样进 Agent 上下文，
一条 `{"loc":{"file":"../../tenon.db"}}` 就是指令注入。

**送进模型**：`pi-durable` 的 `submit()` 只吃纯文本，没有结构化附件入口。所以 `chat.ts` 把上下文压成
首行 `[TENON-SELECTION] {json}`（`packages/protocol/src/selection-text.ts` 的 `composeWithSelection`），
渲染用户气泡时再用 `stripSelectionBlock` 剥回原文 —— 两个函数成对使用，往返恒等有测试锁住。

三个约束是实测撞出来的：
- **插件文件不许 import `@babel/core` 的类型** —— 模板里没有这个包（Babel 由 `@vitejs/plugin-react` 自带），
  一 import 应用自己的 `tsc --noEmit` 就红。AST 形状在本地声明 + 运行时校验，一个 babel 包都不引
- **Babel 的行号 1 起、列号 0 起** —— 注入时 `column + 1`，否则定位整体左移一格（编辑器打开才看得出来）
- **失效是静默的** —— 插件没挂上时页面照常打开、控制台干净、HMR 正常，只有"点元素定位不到"。
  所以决策逻辑抽成 `decideInjection()` 单测（24 项），接线由 `pnpm e2e:preview` 抓 `/src/App.tsx`
  的真实转译产物做硬断言

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

### 11.1.1 为什么不用 CDP 采日志（v1.2.10 决策）

**一句话：CDP 是"从外面看"，我们要的是"应用自己说"。** 前者只能在 Chromium 且能 attach 的宿主里工作，
后者在桌面、Web、用户自己的 Safari、以及导出后的 Docker 里是同一份代码。

| 维度 | CDP（`Runtime.consoleAPICalled` / `exceptionThrown`） | 应用自报（现方案） |
|---|---|---|
| 覆盖范围 | **只有浏览器侧**：console、未捕获异常、网络 | 浏览器侧 + Nest / tsc / Vite 子进程输出 + 数据库 + 平台节点（`LogStore` 三来源） |
| 宿主要求 | 必须是 Chromium，且要能拿到 target | 任意宿主：Chrome / Safari / Firefox / Electron / 手机浏览器 |
| 独占性 | 一个 target 只允许一个 debugger 客户端；**用户按 F12 就把 channel 抢走**，`attach` 直接抛错。若我们赢了，用户就再也打不开 DevTools | 无冲突，与用户开不开 F12 无关 |
| 生命周期 | session 断开 = 这段历史消失，还得自己再做一个 store | 缓冲跟应用走：停预览后仍能回看（`app.delete` 才 `forget()`） |
| **首屏崩溃** | attach 之前的异常全丢 —— 而"打开就白屏"恰恰是最常见的那类报错 | SDK 在 `main.tsx` 第一行装好，首屏就在覆盖内 |
| HMR 整页重刷 | target 重建，需要重新 `Target.setAutoAttach` + flatten，重建窗口内事件丢失 | Vite 重刷不影响，`window.onerror` 重新挂上即可 |
| 后端 / 编译期 | 覆盖不到。Node 侧要用 CDP 就得 `--inspect`，而 `NODE_OPTIONS` 正是我们**刻意从子进程环境里洗掉的**东西 | 直接读子进程管道，无需额外开关 |
| 安全面 | Node 开 `--inspect` ≈ 给本机开一个"可执行任意代码"的端口 | 不新增任何可连端口；页面上报走同源相对路径、不带平台凭证 |
| 成本 | 要浏览器进程句柄 + 处理 attach/detach 竞态 | 约 3KB 代码、零依赖（`tenon-log.ts`） |

**CDP 唯一明显更强的是 console 全量与网络瀑布。** 这两件事留到做"性能面板"时处理 ——
届时在**桌面形态**里用 `webContents.debugger` 做可选增强（仅当用户没开 DevTools 才 attach），
**不进主链路**，因为它一旦成为主链路，Web 模式与用户自己的浏览器就永远只有一半日志。
网络状态这件事在网关侧本来就有：`/api/*` 由网关代理，4xx/5xx 是平台的既有事件，不必问浏览器要。

> 补记：CDP 在**开发期**仍然有用 —— `/tmp` 下的 `cdp-hold-persist.mjs` / `cdp-harvest-slice.mjs`
> 是研究对端行为的工具，不是产品链路。两者别混。

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
| 分支 | 只有 `main`。**不建 `release/<version>` 分支**：发布靠 tag 就够，多一条长期存活的分支只会让"哪条是准的"变模糊 |
| 发布 | `git tag v<yyyy.MM.dd>-<n>`（annotated，说明进正文）+ 推到本地裸库 `~/.tenon/backups/<id>.git`（v1.2.14 落地，§13.3）；远端 push 待接 |
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

**用户可回滚**：版本面板列出 commit（时间/摘要），支持「查看 diff」「回滚到此」（`revert`，非 `reset --hard`，不丢后续历史）。

**Diff 的形状（v1.2.12 落地）**：`git.show({appId, sha})` 返回**结构化**的逐行差异，不是一段 patch 文本：

```
{ commit, changes: [{path, status, insertions, deletions}],
  files: [{ path, status, insertions, deletions,
            lines: [{kind: 'ctx'|'add'|'del', text, oldLine, newLine}],
            patch, binary?, truncated? }],
  patch }
```

三个决定都是踩过才定的：

- **结构化而不是让前端解析 `+`/`-` 前缀** —— 行内容本身可能以 `+` 开头，纯文本解析必然错位；
  服务端拼 patch 给模型用，前端拿 `lines` 渲染，同一份事实两个视图
- **单条提交用 `git.show`，不是 `git.diff(sha)`** —— `diff(from)` 是"从 from 到 HEAD"的累积变化，
  在版本列表里点第 3 条会把第 3 条之后的改动全算进去。`showCommit` 内部取 `commit.parent[0]` 与之比较，
  根提交没有父提交则由单树 walk 把整棵树报成 `added`
- **`binary` / `truncated` 显式标记** —— `readBlob` 返回不了文本有"不存在"和"不可读"两种原因，
  混在一起会把"改了一张图"显示成"整文件被删光"

界面侧：改动面板**覆盖**在预览之上（`absolute inset-0`）而不是替换 —— 替换会卸载 iframe，
HMR 连接断开、预览归零，看完 diff 切回去等于重启一次。逐行折叠上下文（默认 ±3 行，
两处改动隔得近时合成一段），版本列表在左侧，回滚按钮两步确认。

### 12.3 数据库回滚（v1.2.13 落地）

代码能回滚，schema 也能回滚（下迁移），但**数据**不一定。策略：

- **只在"这次提交改了表结构"时存快照**（判据 `hasSchemaChange`：`api/migrations/**`、`*.entity.ts`、
  `shared/schema.ts`）。每轮都存不现实：PGlite 一份 4~5MB，聊五十轮就是两百多兆；
  而只改样式的提交库里根本没变。用**路径约定**而不是扫 SQL 关键字 —— 后者要猜方言，
  还会被字符串里的 `CREATE TABLE` 误伤
- 落点 `exports/db/<sha>/db.tar.gz`：**按 sha 归档**。按时间戳命名就得再存一份"文件 ↔ 提交"
  的映射，两份迟早对不上
  - `pglite` 档：`dumpDataDir('gzip')`。**不是 `cp -r` 数据目录** —— 那才是"必须先 stop"的场景；
    `dumpDataDir` 是 PGlite 自己的 API，运行中调用安全（已实测：库里开着未提交事务时打快照，
    还原后未提交的那行不在）
  - `postgres` 档：`pg_dump --format=custom`，缺二进制报 `DB_UNSUPPORTED`。
    **不打包 pg 二进制**：`pg_dump` 的版本必须不低于服务端版本，而发布档连的是用户自己的云 PG
    （13~19 都可能），带一份 18 的二进制去连 19 的库照样失败。发布档的数据回滚，
    云厂商的 PITR 才是正解
- **回滚时的顺序是「检查 → 还原数据 → 回滚代码」，不能换。** 覆盖库不可逆，回滚代码可逆
  （再回滚一次就回来了）。所以凡是可能失败的判断都要挤在最前面 ——
  否则用户会得到"代码回滚了、数据没回滚"的半成品状态，比直接报错难收拾得多
- **快照可能比目标更早**：父提交没改 schema 就没快照，只能往前退到最近一份。
  这时 `skippedCommits` 如实报"中间隔了几轮"，UI 据此说清会丢多少数据，而不是假装精确
- 回滚时可选 `dbRestore: true` → 还原快照（**默认关闭**）。数据比代码贵：
  "我只是想撤掉那段代码"是最常见的意图，不能让最贵的操作待在手边
- 两档统一用 `DatabaseProvider.restore()` 抽象，调用方不感知实现
- 发布时必存快照 → 对应 release 可"回滚到上线版本（含数据）"（M4 接）

**已知缺口**：快照会累积且**未做清理策略**。一个应用不可能触发五十次 schema 变更，
等真出现容量问题再加 LRU；`app.delete` 时随目录一起删。

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

| 类型 | 内容 | 用途 | 状态 |
|---|---|---|---|
| **静态包** | `dist/` + `dist-server/` + `node_modules`（prod）+ `serve.mjs` + `start.sh` + `.env.example` + `README.md` | 无 Docker 环境、拷走就跑 | ✅ 已落地（`export.static`） |
| **Docker 上下文** | 同一份构建 + `Dockerfile` + `docker-compose.yml` + `.dockerignore`（**不带宿主依赖**） | 自托管上线（主推） | ✅ 已落地（`export.docker`） |
| Git push | 代码推到用户远端（GitHub/GitLab/Gitea） | 团队接管、CI/CD | ⏳ 本地备份库已落地（§13.3） |

**先做静态包，Docker 从它派生** —— 这是一个顺序决定，不是取舍。原因：
静态包能在本地完整验证（`pnpm e2e:export` 会真起一个 PG 把产物跑起来），
而 Docker 需要容器运行时；等静态包稳了，Dockerfile 只是 `COPY 产物 + node:22-alpine`，
`compose` 再加一个 `db` 服务。反过来先做 Docker 的话，每个 bug 都要在"构建镜像"这一层
排查，慢一个数量级。

**产物里没有 pglite。** PGlite 是「预览用的零安装数据库」（§6.4），生产产物只认
`DATABASE_URL`。把 wasm + pg-gateway 塞进去等于让产物自带一个数据库运行时 —— 那是
另一个产品，也和"应用不感知运行环境"这条铁律的精神相反。

**产物里也没有组件。** AI 小助手 / 导出 CSV / 审批流是 Tenon 运行时注入到预览页的
（§21.6），不属于应用代码。导出的包自然没有它们 —— 产物 README 里明写了这一条，
免得用户以为"买椟还珠"。

### 13.2 Dockerfile（从静态包派生，⏳ 待做）

**关键决定：不做多阶段构建。** 静态包已经由 Tenon 那侧构建好（`export.static` 真跑过
`pnpm run build`），镜像只需要把产物装进去。多阶段构建意味着在镜像里再跑一遍
pnpm + devDeps + 模板工具链 —— 那会让"两台机器上构建结果不一致"这个风险重新进来，
而它正是导出这档要消灭的东西。

```dockerfile
# 由 Tenon 导出时生成。build context 就是导出的产物目录。
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000

# 三个可选的网络适配（不传 = 官方默认行为）
ARG NPM_REGISTRY
ARG BUILD_HTTP_PROXY
ARG BUILD_HTTPS_PROXY

COPY package.json pnpm-lock.yaml ./
# ★ 必须锁 pnpm 9：corepack 默认装最新版（12），而 lockfile 是 pnpm 9 生成的，
#   12 的供应链策略会拒绝它（报 "relax the policy that flagged them"，看着像依赖坏了）
RUN if [ -n "$NPM_REGISTRY" ]; then export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"; fi \
 && corepack enable \
 && corepack prepare pnpm@9 --activate \
 && pnpm install --prod --frozen-lockfile${NPM_REGISTRY:+ --registry=$NPM_REGISTRY}

COPY dist ./dist
COPY dist-server ./dist-server        # 有后端时才有这一行
COPY serve.mjs ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "serve.mjs"]
```

```yaml
# docker-compose.yml（导出时生成）—— 有后端就默认带 PostgreSQL
services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD:?自己设一个}   # 没有默认值：弱密码摆公网是常事
    volumes: [db:/var/lib/postgresql/data]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U app']
      interval: 5s
      retries: 10
  app:
    build:
      context: .
      args:
        # 不直接读 HTTP_PROXY：那是宿主视角的地址，容器里的 127.0.0.1 指向容器自己
        NPM_REGISTRY: ${NPM_REGISTRY:-}
        HTTP_PROXY: ${BUILD_HTTP_PROXY:-}
        HTTPS_PROXY: ${BUILD_HTTPS_PROXY:-}
    environment:
      DATABASE_URL: postgres://app:${DB_PASSWORD}@db:5432/app
      DATABASE_POOL_MAX: 10          # 真 PG 上就是普通连接池上限
    ports: ['3000:3000']
    depends_on:
      db: { condition: service_healthy }
volumes:
  db:
```

- **端口只有一个**：`serve.mjs` 已经在同一个端口上分流 `/api/*` 与静态文件（与静态包同一份
  启动器），所以 `EXPOSE 3000` 就够了，反代只转一个口
- **启动时自动跑迁移**（`migrationsRun: true`，编译后的迁移在
  `dist-server/api/migrations/*.js`）；业务数据在 `db` 服务的命名卷里
- **`pglite` 不进生产产物**：导出产物只认 `DATABASE_URL`，compose 里指向 `db` 服务
- **构建发生在哪**：Tenon **不在用户机器上跑 `docker build`**（可能没装 Docker）。默认只
  产出上下文 + 一条可复制命令；验证放在 CI（GitHub runner 自带 Docker）

### 13.3 发布流程（v1.2.14 落地：「冻结版本 + 本地备份库」这一档）

```
发布 → 打 annotated tag（v<yyyy.MM.dd>-<n>，发布说明写进 tag 正文）
     → 把仓库镜像到本地裸库 ~/.tenon/backups/<appId>.git（对象 + ref）
     → 记一条 release（version / commit / kind=push / artifactPath）
```

**为什么本地这一档不用 `git.push`**：isomorphic-git 1.44 的 push 只走 HTTP 传输
（对本地路径也报 `requires a "http" parameter`）—— 而「用户机器上正好有个 Git 服务」是不该有的假设，
为了备份去起一个更荒唐。所以用 git 自己的对象模型搬运：收集可达对象 → `writeObject` 写进目标裸库 → 写 ref。
传的东西和真 push 一样是**对象 + ref**，只是省掉了协商（整库镜像是全量语义，不需要增量协商；
已存在的对象会跳过，所以重复发布只写增量）。

产物是**标准裸库**，`git clone` 出来就是这一版的完整代码。`pnpm e2e:release` 请系统 git 当裁判：
`fsck --strict`（对象图完整、没有悬空引用）+ `clone` + `log`/`tag`/`cat-file` 全过才算数。
系统 git **只出现在 e2e 里**，产品运行时不依赖任何 git 二进制。

**闸门**：应用不在生成中（`APP_BUSY`）、仓库有提交（`RELEASE_NO_COMMITS`）、工作区干净
（`GIT_DIRTY_WORKTREE` —— 半截状态发出去比不发更糟）、**质量门禁通过**（`RELEASE_CHECKS_FAILED`，
v1.2.21 起：应用自己的 `typecheck` 与 `test`，见 §5.10）。推送失败会把刚打的 tag 删掉，
不留「有 tag 没记录」的半成品：否则下次发布直接跳到 `-2`，用户会以为少发了一版。

**还没做的（别在文档里假装做了）**：

| 缺口 | 为什么现在不做 |
|---|---|
| 推到真正的远端（GitHub / GitLab / Gitea） | 要凭据、要真网络，本机无法验证。接的时候是加一个 transport，不是重写发布流程 |
| ~~静态包导出~~ | ✅ **已落地**（`export.static` + `pnpm e2e:export` 22 项：产物真的起得来、`/api` 分流、迁移自动跑、缺 `DATABASE_URL` 会被拦） |
| Docker 产物 | ⏳ 静态包已就位，派生只多两个文本文件；**验证要容器运行时**（本机没有），留给 CI |
| `lint` 进闸门 | 模板没有 eslint 配置，硬塞会把「缩进不一致」和「空指针」混在一张单子上（与 §5.8 同一个欠账） |

> `release.check` 那一行已经从缺口里划掉了（v1.2.22 起有了预检，打开对话框就跑）。

**不在用户机器上直接 `docker build`**（可能没装 Docker）：默认**导出构建上下文 + 一条可复制命令**；验证放 CI（GitHub runner 自带 Docker），这也是"Docker 那一档在本地没有容器运行时也能推进"的唯一办法。

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
> **v1.2 后该清单进一步收窄**：应用库默认改为 PGlite（纯 WASM）、产品库改用 Node 内置 `node:sqlite` 之后，**默认路径上的安装包不含任何需要按平台编译的原生模块**；`embedded-postgres` 降为逃生口，不再位于默认路径。剩余平台差异只有三项：Electron 打包与签名、`gondolin` 后端缺失、端口探测命令。
> **v1.2.13 起不再把"零原生模块"当硬约束**（§2.2 变更块）：默认路径上仍然是一个原生模块都没有，
> 但需要时可以直接引入 —— 安装包预编译分发，用户机器不需要工具链。放宽的是**选择权**，
> 不是让它悄悄变成"随便带"：打包会审计并打印清单。跨平台产物的要求也没变：
> 每个平台打自己的包，`.node` 由 electron-builder 在打该平台时一并产出。
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
| **M3 精调与版本** | inspector（编译期定位注入 + 反查 + 框选）、截图、Diff 视图、回滚（`git revert` + 数据库快照，v1.2.9 起不用 `pg_dump`）、发布 push | ① 点选元素改样式并自验；② 框选区域批量改；③ 回滚到任意 commit，代码与数据一致 |
| **M4 多 Agent 与可观测增强** | 6 角色子 Agent、E2E 自验收、Reviewer、用量/预算、`taskGraph` 状态面板 | ① E2E 子 Agent 能发现并修复一个注入的 bug；② 任务图实时反映子会话；③ 超预算拦截 |
| **M5 组件体系（官方内置定型）** | chord 宿主接入、6 个标准插槽、`install_component` 工具、**bundled 插件加载器（`resources/plugins` 只读源）**、插件页 UI（列表 / 开关 / 来源标识）、L1 内置积木清单、L2 首发 3 个官方插件（AI 小助手 / Excel 导出 / 审批流）| ① 用一句话给应用装上 AI 小助手并可用；② 卸载后代码与 `AGENTS.md` 同步清理；③ 组件热重载不丢状态；④ **插件页能列出 3 个 bundled 插件并独立开关** |
| **M6 平台化与开源** | **macOS + Windows 双平台安装包**、**组件 Hub 上线（首期仅官方独源，第三方上架延后到 M7）**、覆盖层更新（hub 版 > bundled 版，不重装软件即可给内置插件打补丁）、收费授权（可延至 M6 末，不阻塞发布）、视觉/动效打磨、i18n、文档站、CI、协议与商标 | ① 两平台安装包签名可安装；② **Hub 里能装一个官方插件，且能在不重装软件的情况下更新一个已内置插件**；③ 新人 10 分钟跑通首个应用；④ 协议文件与贡献流程齐备 |
| **M7（后置）** | Linux、团队协作、托管能力（SaaS）、**第三方插件上架与审核** | 视社区反馈 |

依赖关系：M2 依赖 M1 的 harness 与事件流；M3 依赖 M2 的源码定位；M4 依赖 M3 的预览 API；M5 依赖 M2 的应用装配；M6 依赖 M5 的组件协议。

> **M2 进度（v1.2.8，2026-11-01）**：第 1 步已落地 —— `packages/db-provisioner`（两档供给 + `poolMax()` 恒 1）、
> `templates/nest-api`（NestJS 11 + TypeORM + PG 方言 + zod 共享层，迁移只写一份）、
> `preview.start` 双进程（Vite + Nest，网关按 `/api` 最长前缀分流）、桌面版自带 pnpm。
> **DoD ② 已满足**（同一份 migration 跑在 PGlite 与 postgres 两档上，切换只改 `DATABASE_URL`；
> `pnpm e2e:fullstack` 实测 `poolMax===1` 从驱动实例读回、迁移数 ≥1、CRUD 经网关、重启数据还在）。
> 第 2 步已落地（**DoD ⑤ 的面板半边**）：`packages/gateway/src/logs.ts` 的 `LogStore`
> （三来源汇流：子进程 stdout/stderr、页面经 `/__tenon/log` 同源上报、平台关键节点）+
> `app.log` SSE 事件 + `logs.list`/`logs.clear` RPC + 模板侧零依赖上报（`tenon-log.ts` / `tenon-boundary.tsx`）+
> `apps/web` 的 `LogPanel`（折叠底栏 / 来源筛选 / 错误高亮）。
> **③ 已落地（v1.2.9）**：`migrateDatabase()` 纯 JS 逻辑拷贝（外键拓扑排序 / 生成列排除 / `OVERRIDING SYSTEM VALUE` / 序列 `setval` / 逐表 `count(*)` 校验），`pglite → pglite` 全链路实测 10 项（含 TypeORM 生成的表与序列）；**`pglite → 真 PG` 尚未实测（本机无 Docker/无 PG）**。
> **⑤ 的 runtime SDK 半边已落地（v1.2.9）**：`packages/runtime-sdk`（`@tenon/runtime`）作为源码事实来源，`sync-templates.mjs` + 漂移测试把 `tenon-log` / `tenon-boundary` / `tenon-logger`（Nest 全局异常过滤器）拷进两个模板。
> **仍欠：④ Docker compose 产物 —— 2026-11-01 用户决定先跳过**（本机无 `docker`/`podman`/`colima`，
> 无法实测就不产出未验证的 Dockerfile；`templates/nest-api` 的 `Dockerfile` 与 `compose.yml` 记为已知欠账，
> 进 M3 之前不补。真 PG 端到端同理）。**M2 其余 DoD 均有实测。**

> **M3 进度（v1.2.14，2026-11-01）**：全部九步落地 —— ① 编译期注入 `data-tenon-loc` / `data-tenon-callsite`；
> ② `resolveTarget()` 反查；③ inspector 交互（Alt+Hover / Alt+Click / Alt+Drag / ESC）；④ 跨源回传
> （hash 带 token + 父窗口三道校验 + Composer chip + `chat.submit` 带 `selection`）；⑤ 真机 e2e
> （`pnpm e2e:inspector` 13 项）；⑥ Diff 视图（`git.show` 结构化逐行差异 + 覆盖式面板 + 折叠上下文）；
> ⑦ 代码回滚（`revert` 语义、两步确认、回滚后停在回滚提交上）；⑦b 数据回滚（§12.3：schema 提交自动存快照
> + `dbRestore` 可选还原，`pnpm e2e:diff` 36 项）。
> ⑧ 发布 push（§13.3）：annotated tag（说明进正文）+ 镜像到本地裸库 `~/.tenon/backups/<appId>.git`
> + release 记录；闸门是「不在生成中 / 有提交 / 工作区干净」，推送失败删 tag。
> `pnpm e2e:release` 32 项，**用系统 git 当裁判**（`fsck --strict` + `clone`）—— 只有 e2e 用系统 git，产品不依赖它。
> **M3 到此收口。** 下一步是 M4；发布侧还欠「真远端 push」「Docker / 静态包产物」「质量门禁」三块（§13.3 表格）。
> M3 DoD ① 的"改样式并自验"要等真模型 key 才能验，`faux` 只能验链路。

> **M4 进度（v1.2.15，2026-11-01）**：第 1 步落地 —— **子 Agent 能派活了**。
> ① `packages/agent/src/roles.ts`：1 主 + 5 子的**唯一事实来源**（工具白名单 / 档位 / 提示词 / 可用状态）。
> ② `subagent` 工具：真的建子会话、真的把结论带回来；`explore` / `librarian` 可用，其余三个角色
> 定义好了但工具没接（派活明确回"还没接、缺什么"）。③ 工具层补 `ls` / `glob` / `grep`（**自己实现**，
> 不用 pi 的下载二进制版，理由见 §5.2 的注）。④ faux 改成**按角色分道**的剧本 —— 否则子会话会把父轮的台词吃掉。
> `pnpm test` 新增 20 项（角色表 13 + 守卫 5 + 集成 7，其中一个断言"只读派活不产生空提交"）。
> **M4 第 1 步到此收口**（v1.2.15）。

> **M4 进度（v1.2.16，2026-11-01）**：第 2 步落地 —— **任务图面板，DoD ② 已满足**。
> ① `packages/core/src/taskgraph.ts`：`normalizeTaskGraph()` 纯函数（kind 去前缀 / 会话派生回挂 /
> 角色继承 / 按树序压平），`tasksNeedingRole()` 挑出"该去查角色"的工具 task —— 9 项单测。
> ② `packages/agent/src/taskgraph.ts`：每应用一个 `watchTaskGraph`（不是轮询），归一化后
> 通过 `taskgraph.update` 推全量；角色从 `checkpoint.arguments` 读一次并缓存。
> ③ `taskgraph.get` RPC（切应用 / SSE 重连后首拉）+ `taskgraph.update` SSE 事件。
> ④ `apps/web/src/features/tasks/TaskGraphPanel.tsx`：预览下方的任务条，空闲时整个不渲染。
> `pnpm test` 新增 13 项（归一化 9 + 集成 4，其中一条断言"派活那一轮里必须出现 delegated 节点"，
> 另一条断言"跑完就是空图"）。

> **M4 进度（v1.2.17，2026-11-01）**：第 3 步落地 —— **用量与预算熔断，DoD ③ 已满足**。
> ① `packages/core/src/usage.ts`：账本求和 / 本轮差值 / `breached` / `levelOf`（13 项单测，
> 含"上限设 0 等于关掉"与"两条线都不设就永不拦"）。② `packages/protocol/src/usage-format.ts`：
> `formatTokens` / `formatCost` / `budgetMessage` —— **放 protocol 是因为服务端与浏览器都要用**，
> core 带 `node:sqlite` 进不了前端产物。③ `packages/agent/src/usage.ts`：每应用一份
> `UsageService`（`harness.usage()` 读真值 → 推 `usage.update` 全量），`startTurn()` 顺手判额度。
> ④ 拦截两个点：`chat.submit` 抛 `BUDGET_EXCEEDED`（402）；每次模型响应后重算，顶到就 abort。
> ⑤ `usage.get` / `budget.set` RPC（额度存 `budget.app.<appId>`）+ 顶栏 `UsagePanel`（账 + 额度表单）。
> `pnpm test` 新增 29 项（core 13 + protocol 5 + 集成 11，其中一条断言"重启之后账本不变"、
> 一条断言"删掉一个应用别的应用还能跑"）。**M4 还欠**：E2E 子 Agent 的预览工具（DoD ①）、
> Reviewer 的 `git_diff`/`typecheck`、CodeAct 的 codemode；档位路由要等设置能存多个 profile；
> 额度没有跨应用的**总闸**（见 §5.6 的缺口）。

> **M4 进度（v1.2.18，2026-11-02）**：第 4 步落地 —— **e2e 子 Agent 能自己点页面，DoD ① 已满足**。
> ① `packages/gateway/src/page.ts`：`PageBridge`（会话 / 队列 / 长轮询 / 超时挂账 + 摘除 / 断开感知）
> + 注入脚本（ES5、`sessionStorage` 存 sessionId、异常也回话、`navigate` 先回话再跳）+
> `injectPageScript()`。② `proxy.ts`：吃掉四条 `/__tenon/page/*` 路径、HTML 注入（重算 `content-length`
> 并删 `transfer-encoding`）。③ `preview.ts`：每个 run 一个 `PageBridge`，`pages(appId)` 给 server 查。
> ④ `packages/agent/src/tools/preview.ts`：五个工具 + 窄接口 `PageDriver`（agent 不依赖 gateway）。
> ⑤ `roles.ts`：`e2e` 转 `ready`，主角色拿不到这五个工具。⑥ `harness-pool.ts`：`preview` 扩展
> 必须进 `extensions`，否则工具在子会话里"不存在"。
> `pnpm test` 新增 31 项（gateway page 16 + agent preview-tools 13 + server e2e-agent 2），
> `pnpm e2e:e2e` 9 项真 Electron：注入 `value + 2` 的 bug → 从真 DOM 拿到"期望 1、实测 3" →
> 主角色改成 `value + 1` → 整页重载 → **同一条断言通过**。
> **M4 还欠**：Reviewer 的 `git_diff`/`typecheck`、CodeAct 的 codemode、发布质量门禁；
> 档位路由要等设置能存多个 profile；额度没有跨应用的**总闸**（§5.6）；用量答不了"哪个角色花了多少"。

> **M4 进度（v1.2.19，2026-11-02）**：第 5 步落地 —— **Reviewer 出风险清单**。
> ① `packages/core/src/git.ts`：`worktreeDiff()`（工作区 vs HEAD，自算 blob oid、40 文件上限）。
> ② `packages/core/src/typecheck.ts`：`parseTscOutput()` / `formatTscReport()` —— 纯函数，
> "没跑成"与"通过"在类型上就分开（`ok` 只由调用方给的布尔决定）。
> ③ `packages/agent/src/tools/review.ts`：`git_diff`（默认工作区，`commit:"HEAD"` 看上一版）
> 与 `typecheck`（跑应用自己的 tsc，多 tsconfig，桌面版补回 `ELECTRON_RUN_AS_NODE`）。
> ④ `roles.ts`：`reviewer` 转 `ready`，白名单 6 个（只读 4 个 + 两个判据工具，**没有任何写工具**）。
> ⑤ 提示词写死工作顺序（先 diff 再 typecheck）与清单格式（最多五条、`[blocker|risk|nit] path:line`）。
> `pnpm test` 新增 30 项（core typecheck 10 + core worktree 5 + agent review 11 + server 集成 2
> + roles 2），其中三条盯"别把没跑成报成通过"。`lint` 未接（模板没有 eslint 配置）。

> **M4 进度（v1.2.20，2026-11-02）**：第 6 步落地 —— **CodeAct 会写脚本了，五个子角色全部接好**。
> ① `packages/agent/src/tools/codeact.ts`：`CodemodeSandbox`（60s / 128MB）+ `createCodemodeExtension`
> （`models: false`、`inlineBudget: 1200`）+ 改名 `tenon.codeact` + `close()`。
> ② `roles.ts`：`codeact` 转 `ready`；新增 `RoleSpec.modelTools`（只有 `codemode` 递给模型）与
> `RoleSpec.extensions`（`tenon.codeact` 只进子会话）。
> ③ `subagent.ts`：给子会话传 `modelTools` 与 `extensions: { add }`；"还没接"的文案抽成纯函数
> `plannedRejection()`（表里没有 `planned` 角色了，机制靠单测钉住）。
> ④ `harness-pool.ts`：装扩展、装 registry、`close()` 里先关沙箱再关 harness。
> ⑤ `apps/desktop/build.mjs`：`pi-codemode` + `quickjs-wasi` 外部化并整包拷进 `dist/server/node_modules/`，
> 加 `assertCodemodeLayout()` 自检（构建成功不等于能跑）。
> `pnpm test` 409 项（+4：server 集成 3 + roles 3 − 两条已失效的 planned 用例），
> 其中一条让脚本 fan-out 读真文件、算出的数字与测试自己算的一致。`pnpm build:desktop` 后
> 在 `dist/` 里真跑了一次沙箱（`return 42` 拿到 42）。
> **M4 还欠**：发布质量门禁（第 7 步）、档位路由要等设置能存多个 profile、额度没有跨应用的**总闸**
> （§5.6）、用量答不了"哪个角色花了多少"、脚本超时可被 `// @options` 放大（§5.9）。

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
| PG 迁移耗时（PGlite → 真 PG，数据量大时）| 低 | 后台任务 + 进度条（`MigrateProgress` 已有 phase/table/done/total）；批量 `insert` 500 行/批，不落临时文件 |
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

**facet 的 ABI（M5 第 3 步定下）**：server facet 必须导出

```ts
export function activate(input: {
  host: Host<Principal>   // chord 宿主；名字必须与契约的 hostNamed(...) 一致
  appId: string
  brain: { complete(input: { appId: string; text: string }): Promise<string> } // 宿主注入的模型能力
  storage?: ComponentStorage  // ★ M6 第 4 步：键值存储，**没有 db:* 权限时这个字段不存在**
  log: (line: string) => void
}): void | Promise<void>
```

宿主**只交给组件它真正需要的东西**：没有文件系统、没有网络、没有任意 SQL。于是
`manifest.permissions` 是"它被允许用什么的声明"，而真正能用的能力由宿主注入决定 --
两者都在 `packages/server/src/components.ts` 里看得见，不需要审计插件源码。

**存储是 KV 不是数据库连接**（M6 第 4 步的取舍）：组件声明 `db:write` 的意思是
"我要存点自己的数据"，不是"我可以动用户业务表"。给一条 SQL 通道，一个写得不好的
第三方组件就能 `DROP TABLE orders`。所以给的是按 `(appId, componentId)` 命名的
键值空间（`get / keys / set / delete / update`），配额 500 键 / 单值 64KB，
读改写由门面串行化（否则"读列表 → 加一条 → 写回"并发时会丢更新）。

三条关于存储的硬约束：

| 约束 | 为什么 |
|---|---|
| 没有 `db:read` / `db:write` → `storage` 是 **undefined**（不是"一调就抛的对象"） | 组件必须在类型层面处理"没有这个能力"；给它一个会抛的对象，只会让人写 try/catch 静默降级 |
| 命名空间由宿主绑定，组件拿不到 `appId` / `componentId` | 边界在闭包里。组件看不见，也就不可能"顺手"读隔壁的键 |
| 组件的 `activate` 可以是 async 的 | 审批流要先从存储恢复数据再 `serve`。**宿主必须 await** —— 否则客户端会撞上"这个 contract 还没人 serve" |

**关键点：收费不是"前端藏按钮"，是服务端根本不下发方法。** 未购买的用户即使改了前端代码，`ask` 也不存在。这是 chord `principal` 白送的安全性，比任何前端开关都可靠。

三条**当场抛错**的约束（都是实测）：

| 约束 | 违反的表现 |
|---|---|
| 状态字段不能叫 `status` / `error` / `variant` / `ready` / `shape` / `release` / `then` / `contract` | 定义契约那一刻抛 `member name is reserved`（那是 chord Ref 自己的成员）|
| host 的 `name` 必须等于契约里的 `hostNamed(...)`（这里是 `'server'`）| `serve` 抛「declared for server, but <别的名字> serves it」|
| 无参方法的实现签名是 `(ctx)`，不是 `(args, ctx)` | 类型检查报错（不静默），见 Spike 5 |

**状态里放整份对话，而不是一条条事件**：chord 的状态是可观察 JSON，订阅者拿到快照 + 增量。
把 `messages` 放进 state，浏览器刷新/断线重连之后界面自己就能复原，不需要"重放历史"这套东西。
反过来用一次性返回值的话，刷新即丢。

**关键点：收费不是"前端藏按钮"，是服务端根本不下发方法。** 未购买的用户即使改了前端代码，`ask` 也不存在。这是 chord `principal` 白送的安全性，比任何前端开关都可靠。

**Spike 5 实测（2026-11-02，`docs/SPIKES.md` §7）**：`principal` 分流如设计所愿 —— guest 拿到 `viewer`、是**另一个对象**（state 互不影响），强行调 `append` 得到
`not_in_variant: … append is not a method of variant viewer`。两条要记住：

- **`'ask' in ref` 恒为 `true`**（Ref 是代理，`in` 不区分变体），所以"判权限"只能真调一次并认 `not_in_variant`，任何形式的"先探测再决定"都会误判。
- **判断必须写在 factory 里**（返回哪个 `variant`），不能写在方法里再抛 `forbidden()` —— 后者是"方法存在但拒绝"，前端仍然知道它在那儿，插件页/文档也没法按能力渲染。


### 21.3 组件如何被"插进应用"

Agent 不手写接线代码，而是执行一个**标准动作**（内部工具 `install_component`）：

1. 读 `manifest.json` → 检查依赖、权限、宿主兼容性（具体是 `buildPlan`：选版、校验、排序）
2. 写一份**装配声明**到应用仓库 `app.components.json`：

```jsonc
{
  "version": 1,                       // 声明格式版本；对不上就整份拒，不猜怎么迁移
  "components": [
    { "id": "tenon.official.ai-assistant", "version": "^1.2.0", "license": "free",
      "mount": [{ "slot": "app.shell.overlay", "order": 100 },
                { "slot": "app.api", "prefix": "/_c/assistant" }] },
    { "id": "tenon.official.excel-export", "version": "^0.9.0", "license": "free",
      "enabled": false,               // 关掉：声明还在，但不加载（卸载是另一条路，会删声明）
      "mount": [{ "slot": "app.api", "prefix": "/_c/excel" }] }
  ]
}
```

**`mount` 里不写 `host`**（v1.2.24 改）：宿主由插槽决定 —— `app.api` 一定在 server，其余五个一定在
web。让声明自己写 host 只会多出一种错法（`app.api` 挂到 web 是可以写出来但没有意义的）。

3. 由**壳生成器**在应用启动时按声明加载 facet（`host.load([...])`，顺序取 `loadOrder`，依赖在前），
   生成 `src/components.generated.ts`
4. 若有插槽 UI，在 App Shell 的固定插槽渲染（`app.shell.overlay` / `app.shell.sidebar.bottom` / `app.page.header`）

**★ 装配时必须做的三件事（Spike 5 实测出来，不做就会静默坏）**：

| 事 | 为什么 |
|---|---|
| **每个组件的 `serve` 带上 `linger`** | 对象默认 `lifetime: "referenced"`，**最后一个引用释放就连同 state 销毁**（实测：root 里 `rows` 加到 5，root 结束再 `get` 同一个 input 读到 0）。不显式 `linger` 的话，悬浮球/审批流每发一次请求进度归零，且**不报任何错** |
| **每个调用自带超时** | 链路静默丢帧（`sever()` 模拟断网）时调用**既不返回也不抛**（实测 1.5s 内 `hanged`）。不能指望"断了会告诉我" |
| **不要为 chord 单独做打包特殊处理** | 它可以跟 server 一起打成单文件（实测 726KB / 构建 164ms / 跑通），与 `pi-codemode` 的 worker+wasm 相反 —— 那里必须外部化（§5.9） |

`lifetime: "host"` 不是 `linger` 的替代品：它在插件加载时就把对象建起来，只适合**没有 input** 的单例；带 input 的组件对象只能靠 `linger` 存活。

**加载器（M5 第 2 步已落地，`@tenon/component-host`）**

| 事 | 做法 | 不这么做会怎样 |
|---|---|---|
| 覆盖层解析 | `hub > bundled`，**先看根、再看版本** | 按"全局最高版本"选的话，bundled 1.3 会盖掉 hub 1.2，官方热更新永远不生效 |
| 逐条独立判定 | 每条装配条目单独解析，失败落一条 problem，其余照常加载 | 一处坏全盘空，用户以为所有组件都被卸载了 |
| 装不上就明说 | 21 个稳定 problem code（`missing` / `version-unsatisfied` / `tenon-too-old` / `dependency-cycle` …），`component.list` 恒 200 | 静默降级的表现是"组件在，但点了没反应"，比装不上更难查 |
| 依赖排序 | 拓扑排序得 `loadOrder`（依赖在前），成环整组不加载 | 加载器拿到半条链会崩，而且崩在应用启动那一刻 |

另外三条判定：

- **`minTenonVersion` 对 `0.0.0` 恒通过**：仓库里的构建就是 `0.0.0`，它代表"还没发版的开发树"。不这么判的话所有清单都得写 `0.0.0`，这个字段当场失去意义。代价是**开发构建测不出写错**，所以它有单独的测试覆盖真实分支。
- **目录名即组件 id**：清单里 `id` 与目录名不一致直接判 `id-mismatch` —— 否则放错一个目录就会"装配了 A、装上了 B"。
- **权限只认白名单**（`fs:app` / `db:read` / `db:write` / `net:fetch[:<域名>]`），出现不认识的一律拒绝整份清单；`facets` 路径不许跳出插件目录。这两条挡的是"用户以为它只能读库，其实它能随便联网/读文件"。


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

**这个决定顺带关掉两个待办**（§19.2 第 2、4 问）：市场审核策略 → 首期只有官方独源，不存在第三方审核问题，延至 M7；收费组件结算 → **M6 末已定稿**：Phase 2 不做 license 体系，Phase 3 的落地形状写在 §21.5（不阻塞发布）。

### 21.5 免费 / 收费组件的商业模式

> **本节在 M6 末定稿（2026-11-04）**。结论先写：**Phase 2 全线免费，不做 license 体系**；
> `pricing.type: 'paid'` 保留在协议里，作用是「装不了」的安全阀，不是商业模式。
> Phase 3 的授权形状在下面写死，但代码一行都不写，直到出现第一个要收费的第三方组件。

#### 21.5.1 现在（Phase 2）实际是什么

| 环节 | 现状 | 落点 |
|---|---|---|
| 清单 | `pricing: { type: 'free' \| 'paid', sku? }`，`paid` 必带 `sku` | `component-host/src/manifest.ts` |
| 门禁 | `paid` → `paid-not-available`，**安装这一步直接拒** | `install.ts`（唯一安装入口） |
| 索引 | Hub 索引也标 `pricing`，但**只用于显示** | `hub.ts` 的 `HubIndexComponent.pricing` |
| 装配 | 声明里有 `license` 字段，恒为 `'free'` | `assembly.ts` |
| 运行时 | 没有 variant、没有 `licensed` 分支 | — |

**为什么真判据必须在包里而不是索引里**：索引是"目录"，包才是"产品"。索引说 free 而包里是 paid，
安装端按包判 —— 反过来（按索引判）就是"改一个没签名的字段就能洗白付费组件"。

**为什么门禁只放在安装、且明说不是 DRM**：组件文件是明文落盘的（esbuild 产物），谁拿到目录都能读。
在加载层再拦一次不是防护，是自我安慰 —— 它只会让后来的维护者误以为这里有保护。
所以门禁写在一个地方（`installComponent`），并在报错文案里直说"付费流程还没做"。

**为什么是"装不了"而不是"装了但跑不起来"**：没有购买流程时，"装上了"只会让用户以为能用了。
一个明确的"现在还不能装"比一个装完静默降级的功能诚实得多。

#### 21.5.2 Phase 3 的授权形状（定稿，未实现）

真要做的时候按这个来，不要另起一套：

```jsonc
// ~/.tenon/licenses/<sku>.json
{
  "format": 1,
  "sku": "tenon.official.approval-pro",
  "subject": "user_8f3a…",        // 绑定用户/组织，换机器可换、换人不行
  "issuedAt": 1767225600000,
  "expiresAt": 1798761600000,     // 缺失 = 永久（一次性买断）
  "sig": "base64…"                // Ed25519，覆盖 canonicalJson(去掉 sig 的全部字段)
}
```

四条硬约束：

1. **同一把 Hub 公钥**。不再引入第二套密钥管理 —— 客户端已经内置并展示指纹（`hubKeyFingerprint`），
   多一套就意味着"这两个指纹哪个才是官方的"这种问题。
2. **两个校验点，缺一不可**：安装时（决定装不装）+ 启动时（决定能力开不开）。只装不验等于一次性买断变永久，
   只验不装等于每次启动都在问网络。
3. **过期是降级，不是删除**。license 失效 → 组件继续在、数据继续在，只关掉靠 license 才有的能力。
   删组件会把用户的数据一起带走，那是最坏的一种"到期"。
4. **离线优先**。验签是本地计算，不联网也能用已购组件。联网只做三件增强：同步已购、跨设备、续费。

计价与分成（Phase 3 才生效）：一次性买断 / 年订阅 / 按用量（AI 类）；社区开发者 7:3，官方组件不分成。

#### 21.5.3 为什么现在不做，以及什么时候回来做

**不做**的理由不是"来不及"，是**做半套比不做更糟**：

- 没有第三方上架，就不存在"卖谁的组件"；官方组件收费等于给软件本体定价 —— 那是定价问题，不是技术问题
- 半套 license 的典型死法：用户付了钱装不上、或者装上了但界面不显示"已授权"，支持成本远高于收入

**触发条件**（任一发生就回来做，工作量集中在四个文件）：
- 第一个第三方组件要上架收费
- 官方要出独立的付费扩展包

| 要改的地方 | 改什么 |
|---|---|
| `component-host/src/license.ts`（新） | 上面那个结构 + 验签 + 过期判定 |
| `install.ts` | `paid` 分支从"直接拒"变成"有 license 就放行，并把 license 标识写进装配" |
| `plan.ts` | `license` 进 `LoadTarget`，`licensed` 能力按它给不给 |
| 设置页 | 一个"已购"列表（只读即可，购买流程在浏览器里） |

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
| 产品库用 `better-sqlite3` | ⚠️ 改为 **`node:sqlite`**（v1.2）| Electron 内置 Node 22 自带 `node:sqlite`，无需 `@electron/rebuild`、不必随包带一份编译产物。**注意：v1.2.13 起"零原生模块"已不是硬约束（§2.2）** —— 这条改动现在读作"内置模块够用，没必要多带一个依赖"，而不是"带了会违规" |
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

