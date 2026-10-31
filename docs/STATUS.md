# STATUS.md — 当前状态与下一步

> **用途：新会话 / 新协作者的唯一入口。读完这一页即可开工，不必先读完整 `DESIGN.md`。**
> 最后更新：2026-10-31（M1 主干第 1~6 步 + **工具层**落地，33 个测试 + 9 项端到端冒烟全绿）

---

## 0. 一句话现状

**M0 逆向完成 → DESIGN v1.2.3 → 四个 spike 全过 → M1 主干前 6 步 + 工具层已落地（能跑、能写代码、有测试）。**

先跑这三条验证它还活着：

```bash
pnpm install && pnpm dev:faux   # 不需要 API Key，用 faux 模型起服务（会打印 TENON_READY）
pnpm test                       # 33 项单测 + 集成测试
pnpm smoke                      # 9 项端到端（真 spawn 进程，走 HTTP + SSE）
```

- `packages/{protocol,core,agent,server}` 已建；`pnpm typecheck` 全绿（含四个 spike）
- 服务真起来了：Fastify 5 / 随机端口绑 `127.0.0.1` / Bearer Token / `/api/health` / `TENON_READY` 握手行
- `tenon.db`（`node:sqlite`）在建应用、写设置、存提供商密钥时真的落盘
- 每应用一个 `.tenon/harness.sqlite`，进程重启后 `resume()` 把中断的一轮**跑完**（有测试）
- SSE 增量 / `message.end` / `usage` / `app.status` 全链路打通；每轮结束自动 git 提交（无改动不产生空提交）
- **Agent 能真的写代码了**：`read` / `write` / `edit` / `bash` 四个工具已接到 pi-durable 注册表上，
  写完的文件进得了这一轮的 commit（`packages/agent/src/tools/coding.ts`）
- **还没做**：生成器与模板、预览网关（第 7 步）、Web 前端（第 8 步）、Electron 壳（第 9 步）

---

## 1. 三条铁律（违反即返工）

| # | 铁律 | 违反的后果 |
|---|---|---|
| 1 | **Electron 只做壳，业务全在本地 HTTP Server 里** | Web 模式、Agent 自调试、SaaS 化三件事同时废掉 |
| 2 | **生成的应用代码永不感知运行环境**（不判断 desktop/docker/cloud），只认一个 `DATABASE_URL` | 导出到 Docker 就必然破 |
| 3 | **pi 全家与 PGlite 都是实验性 API** → `save-exact` 锁版本 + 在 `packages/*/adapter` 包一层 | 上游一次 minor 升级就打穿业务代码 |

---

## 2. 已定决策速查（v1.2）

| 议题 | 结论 |
|---|---|
| 产品名 | **Tenon（榫）**，包作用域 `@tenon/*` |
| 桌面 | **Electron 39.x**（内置 Node 22.22.1，满足 pi `>=22.19`）；只做窗口/菜单/更新 |
| 业务进程 | 本地 **Fastify 5 + TS ESM**，只绑 `127.0.0.1`，随机端口 + Bearer Token；`ELECTRON_RUN_AS_NODE=1` spawn 子进程 |
| Agent | `pi-durable` 1.4（Harness/任务图/子会话/压缩/重放）+ `pi-ai` 1.4（BYOK，三档路由）+ `chord` 1.4（插件宿主）|
| Tenon 前端 | React 19 · Vite 7 · Tailwind 4 · shadcn/ui · TanStack Query · Monaco |
| 生成应用 | 前端：React 19 + Vite 7 + RR7 + zod + TanStack Query；后端：**NestJS 11 + TypeORM + PostgreSQL 方言** |
| **应用数据库** | **两档 + 逃生口**：`pglite`（WASM 版 PG，零安装，**默认**）/ `postgres`（Docker / external / 云托管，**发布**）；`embedded`、`sqlite` 仅逃生口 |
| **产品库** | **`node:sqlite`**（Node 内置，零原生模块）—— `tenon.db` / `harness.sqlite` / `telemetry.db` |
| 版本 | **Git 一等公民**（isomorphic-git）：一轮对话一次 commit，发布 push + tag，回滚 `revert`（非 `reset --hard`）+ DB 快照 |
| 预览 | 每应用一个 **App Gateway**（稳定端口）→ 代理 Vite HMR + Nest，iframe 不直连 dev server |
| 发布 | Docker 多阶段，compose 自带 `postgres:18-alpine`，单容器单端口 |
| **平台** | 首发 **macOS + Windows**；Linux M7 |
| **插件分发** | M5 bundled 内置 → M6 Hub 官方独源 → M7 第三方上架；**同一 manifest + 同一加载器，只差 `source`**；解析优先级 `hub > bundled`（内置插件也能热更新）|
| 商业化 | 个人免费（含全部核心能力）；企业版卖协作/SSO/RBAC/私有 Hub；License = AGPL-3.0（Server）+ Apache-2.0（Runtime SDK/模板/生成物）+ 双许可 |

---

## 3. 文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| **`docs/STATUS.md`**（本文件） | 现状、下一步、陷阱 | **每次开工先读** |
| `docs/DESIGN.md` | **唯一事实来源**，v1.2.1，1500+ 行 | 写涉及架构的代码前，按需读对应章节 |
| **`docs/SPIKES.md`** | 四个 spike 的实测数字与结论（含被推翻的假设）| 碰 DB / pi / 网关 / 定位插件前必读 |
| `docs/ARCHITECTURE.md` | 一分钟速览 + 四条原则 | 给别人介绍时 |
| `docs/PI-CHEATSHEET.md` | pi 全生态真实 API（读源码所得）| **写任何 pi 相关代码前必查**（比官方文档全）|
| `docs/PROTOCOL.md` | 妙搭行为规格（clean-room）| 不确定某个交互该怎么做时 |
| `docs/REVERSE_ENGINEERING.md` | 内部研究方法 | 仅内部，不随开源发布 |

`docs/reverse/`、`*.har` 已 gitignore，**不得提交**，也**不得把其中的代码/文案/提示词搬进产品**（clean-room 红线）。

---

## 4. 下一步：M1 骨架与对话

### 4.1 第一周：4 个 spike —— ✅ **已全部完成（2026-10-31）**

| # | 验证什么 | 结果 |
|---|---|---|
| 1 | `pi-durable` 最小闭环：`Harness.open` + `submit` + 流式 + `resume()` | ✅ 10/10。**流式中途 SIGKILL → `resume()` 把同一提交从 `placed` 跑到 `done`** |
| 2 | App Gateway 代理 **Vite HMR WebSocket** | ✅ 8/8。HMR update **134ms**；上游换端口网关 URL 不变 |
| 3 | `data-tenon-loc` 在 JSX 上准确对应 `file:line`（经组合组件） | ✅ 7/7。改为 `loc`（原生）+ `callsite`（组合组件）双属性，9/9 可回溯 |
| 4 | **`PGlite + pg-gateway + TypeORM`** 稳定性与 P95 | ⚠️ **有条件通过**：20 并发 P95 14ms(读)/24ms(写)、零超时；但 **`pool.max>1` 会让并发事务互相回滚 → 必须为 1** |

详细数字、可复跑命令、被推翻的假设：**`docs/SPIKES.md`**。

### 4.2 M1 主干（按依赖顺序）

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | monorepo 骨架（workspace / tsconfig / vitest） | ✅ | `packages/*` 四个已建；`generator`、`db-provisioner`、`runtime-sdk`、`ui`、`component-host` 与 `apps/*` 随对应步骤建 |
| 2 | server 起来（Fastify 5 / 随机端口 / Token / health） | ✅ | `packages/server/src/{app,bin,index}.ts` |
| 3 | `tenon.db`（`node:sqlite`，5 张表） | ✅ | `packages/core/src/{db,stores/*}.ts` |
| 4 | harness 池（每应用一个 sqlite，`resume()`） | ✅ | `packages/agent/src/harness-pool.ts` |
| 5 | SSE 对话链路（`chat.submit/stop/history`） | ✅ | `packages/agent/src/chat.ts` + `packages/server/src/sse.ts` |
| 6 | Git 自动提交（isomorphic-git，trailer） | ✅ | `packages/core/src/git.ts` |
| 6.5 | **工具层**：read/write/edit/bash 接进 pi-durable（cwd 钉在 `repo/`、越界拒写、环境洗净） | ✅ | `packages/agent/src/tools/coding.ts` |
| 7 | **静态预览**：App Gateway 托管纯前端 React 应用，HMR 打通（M1 不碰数据库） | ⬜ 下一步 | 从 `spikes/gateway` 演进成 `packages/gateway` |
| 8 | **Web 模式**：`pnpm dev:web` 全流程可用（前端 React 19 + Vite 7） | ⬜ | `apps/web` |
| 9 | **Electron 壳**：最后接入，打包冒烟（mac + win） | ⬜ | `apps/desktop`，spawn `server/src/bin.ts` 读 `TENON_READY` |

第 7 步之前还缺**模板**：Agent 已有工具能自由写文件，但「一个能跑起来的 React 应用骨架」不应该每次靠模型从零拼 ——
`packages/generator` 负责把模板铺进 `repo/`（见 §4.4 第 2 项）。

### 4.3 M1 验收（DoD）

- [ ] `pnpm dev:web` 打开即可对话 —— server 侧已具备，缺 Web 前端（第 8 步）
- [ ] 生成一个纯前端 Todo 应用，iframe 里热更新生效 —— 工具已就位，缺生成器模板与预览网关（第 7 步）
- [x] 每轮对话产生一个 git commit —— `chat.ts` 每轮结束调 `commitAll`；**本轮没有文件改动时不产生空提交**。
      工具层接上后已能真的产出 commit（`tools.test.ts` 断言：建应用 1 个 + 写文件那轮 1 个）
- [x] 杀进程重启后，对话与任务能续跑（`resume()`）—— `packages/server/test/chat.test.ts` 的「崩溃续跑」用例：生成中途关进程 → 重启 → 这一轮自己跑完（403ms）

### 4.4 下一步具体做什么（第 7 步拆解）

1. ~~**工具层**~~ ✅ 已完成：`packages/agent/src/tools/coding.ts`（adapter 见 DESIGN §4.3.1）
2. **生成器**：`packages/generator` 模板渲染（`templates/`）+ `data-tenon-loc` 注入（照 `spikes/loc` 的双属性）。
   M1 只要**一个**模板：`react-vite`（`index.html` + `vite.config.ts` + `src/main.tsx` + `src/App.tsx`），
   建应用时铺进去，Agent 只在上面改
3. **网关**：`packages/gateway` 从 `spikes/gateway` 演进，`preview.start/stop/status` 三个 RPC 落地，事件用 `preview.ready`
4. **前端**：`apps/web` 先做「会话 + iframe 预览」两栏，SSE 客户端注意**先连后发**（DESIGN §4.5 第 4 条）

### 4.5 代码地图（只列已落地的）

```
packages/
├── protocol/            # ★ 契约：errors(ErrorCode) / domain / rpc(方法表) / events(SSE) / result(信封)
│   └── src/rpc.ts       #   一张表三种用途：服务端校验、前端取类型、覆盖率测试断言
├── core/                # 领域服务，不认识 HTTP
│   ├── src/paths.ts     #   TENON_HOME 布局（唯一算路径的地方）
│   ├── src/db.ts        #   node:sqlite + PRAGMA user_version 线性迁移
│   ├── src/git.ts       #   isomorphic-git：commitAll / log / diff / revert（回滚 = 新提交）
│   ├── src/secrets.ts   #   AES-256-GCM + 0600 密钥文件（桌面版换 safeStorage）
│   └── src/stores/      #   apps / releases / settings / providers
├── agent/               # pi 生态的唯一入口（铁律 3 的落地点）
│   ├── src/models.ts    #   faux / BYOK(openai-compatible, 自建 provider)；faux 可用 script() 驱动工具
│   ├── src/harness-pool.ts  # 每应用一个 harness.sqlite + resume() + 装工具扩展
│   ├── src/chat.ts      #   submit/stop/history/plan + watchEvents → SSE（40ms 合帧）
│   ├── src/tools/coding.ts  # read/write/edit/bash ↔ pi-durable 的 adapter（DESIGN §4.3.1）
│   └── src/docs.ts      #   tenon.app / tenon.plan（defineDoc）
└── server/              # 只做「挂到 HTTP 上」
    ├── src/app.ts       #   Fastify 装配 / RPC 路由 / SSE / 错误处理
    ├── src/auth.ts      #   Bearer（/api/health 免 Token）
    ├── src/handlers.ts  #   `satisfies HandlerMap` → 漏实现编译期就报错
    ├── src/bin.ts       #   CLI 入口，打印 TENON_READY
    └── test/support.ts  #   集成测试夹具：boot / rpc / openSse（先连后发只此一份实现）
```

依赖方向（DESIGN §3.2）**禁止反向**：`protocol ← core/agent/server`；`server → agent → core`。

---

## 5. 已知陷阱（都踩过，别重踩）

| 陷阱 | 说明 |
|---|---|
| **`PGlite` 的 `pool.max` 必须是 1** | 不是调优建议。`pool.max=2` 时两条连接的事务落在同一个 backend 会话上，一条 `ROLLBACK` 会抹掉另一条已写入的行（实测 `iso-A` 丢失）。收益只有 19% p95，不值得 |
| **`harness.resume()` 不能忘** | server 启动序列少了这句，崩溃恢复能力等于没有（spike 1 就是这么验证的）|
| **`ELECTRON_RUN_AS_NODE` 的正确用法** | `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`；不要额外打包 Node |
| **pi 依赖 `node:sqlite`** | Electron 内置 Node 有该模块（已验证），所以不能在 `node_modules` 里补 `better-sqlite3` 之类原生模块 |
| **安装包内不得有原生模块** | 这是 v1.2 的核心收益：产品库用内置 `node:sqlite`、应用库用 WASM 版 PG → 无需 `@electron/rebuild`、无需 node-gyp |
| **PGlite 冷启动 2.4s / 每应用 38MB** | 建应用与快照都要算这笔账：`app.create` 要给分阶段进度，`dumpDataDir` 约 4.5MB、0.7s |
| **LISTEN/NOTIFY 不可用** | PGlite + pg-gateway 下监听端收不到通知（实测 0 条）。后端推前端只能走网关 SSE |
| **HMR 首帧会丢** | 客户端要在 WS 握手**之前**挂好 `message` 监听，否则丢掉 Vite 的 `connected` |
| **taskGraph 静止时为空** | 任务结束节点会被回收；状态面板要在跑动中采样，静止时展示"上次结果" |
| **端口探测跨平台** | Windows 无 `lsof`，用 `netstat` / `Get-NetTCPConnection` |
| **`gondolin` 在 Windows 无后端** | 不在 Windows 启用；L3 组件走「独立子进程 + 权限清单」（DESIGN §15.3 方案 B）|
| **不要用 `reset --hard` 做回滚** | 一律 `git revert`，保留历史 |
| **产品库与应用库是两件事** | 别把 `tenon.db`（SQLite）和用户业务库（PG）混为一谈 |
| **无 API Key 也能开发** | `pi-ai` 自带 `providers/faux`（`fauxProvider()` + `fauxAssistantMessage()`），CI 与本地都用它，别 mock harness |
| **`git.statusMatrix` 会漏改动** | isomorphic-git 的 stat 快路径把**同长度、同一毫秒**的改动判成"没变"（`v1\n`→`v2\n` 返回 `[1,1,1]`），`WORKDIR` walker 的 `oid()` 也返回旧值。`commitAll` 已改为自算 blob oid + `add({force:true})`，见 `packages/core/src/git.ts`。**别改回去** |
| **`pi.live` 没有 token 增量** | 它只有 `{run,generation:{attempt}}`。流式必须用 `watchEvents(...)` 的 `message_update.changes[].type==='text_delta'` |
| **`message_end` 对用户 entry 也触发** | 服务端只推 `role === 'assistant'` 的 `message.end`，否则前端会重绘自己刚发的气泡 |
| **SSE 必须先连上再提交** | 与 HMR 首帧同一个坑。`GET /events` 建连时立刻写 `: connected`，测试/前端要等它再发 `chat.submit` |
| **`defineDoc<T>` 的 T 必须用 `type` 不能是 `interface`** | 约束是 `T extends JsonObject`，而只有类型别名会拿到隐式索引签名；interface 会报「缺少索引签名」 |
| **模型密钥不能塞 `process.env`** | 生成应用的子进程会继承环境变量，那是真实泄漏面。`packages/agent/src/models.ts` 用 `createProvider` + `api/openai-completions` 现场拼 provider；bash 工具另有一道 `scrubEnv`（按名字洗掉 `*_KEY/TOKEN/SECRET` 与 `TENON_*`）|
| **`pi-coding-agent` 的工具签名 ≠ `pi-durable` 的** | 前者 `execute(toolCallId, params, signal, onUpdate, ctx) → AgentToolResult`，后者 `execute(args, api, context) → ToolExecutionResult`。必须过 adapter（`packages/agent/src/tools/coding.ts`），别试图直接塞进 registry |
| **`edit` 的入参是 `edits: [{ oldText, newText }]`** | 不是 `old_string`/`new_string`。照 `pi-coding-agent` 的 schema 写，自己另造一份会静默变成"工具报错 → 模型重试 → 死循环" |
| **`section()` 的 key 只能 `[a-z][a-z0-9_-]*`** | 写成 `tenon.workspace` 会让**每一轮 submit** 直接抛 `INTERNAL: Section key ... must match ...`。不是渲染问题，是整轮失败 |
| **状态只写库不推事件，前端永远不知道这一轮结束** | `chat.ts` 的 `setStatus()` 现在同时落库 + 推 `app.status`；而且**先提交 git 再发 idle**，否则前端看到"空闲"时版本列表还是旧的 |
| **submission 的 settle 回调可能晚于 `close()` 到达** | 那时 `tenon.db` 已关，写库抛 `database is not open` → unhandled rejection（表现为"33 项测试全过但有 2 个 error"）。`ChatService` 有 `closed` 门；写状态还要 try/catch |
| **测试闸门不能等 `git.commit`** | 这一轮没有文件改动就不会产生提交，等它会一直挂到超时。等 `app.status: idle`（它在提交之后发）|

---

## 6. 环境

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node | `>= 22.19`（pi 硬要求，主因 `node:sqlite`）| v22.22.2 ✅ |
| pnpm | 9.x | 9.15.9 ✅ |
| git | 任意（isomorphic-git 是纯 JS，系统 git 可选）| 2.39.5 ✅ |

日常入口（在仓库根目录）：

```bash
pnpm dev:faux       # TENON_FAUX=1 起 server，打印 TENON_READY {url,port,token,home,model}
pnpm dev:server     # 同上但用真实模型（需要先配 provider，否则 health 的 model 为 null）
pnpm test           # vitest：core（db/git/secrets/apps）+ server（rpc/sse/chat/续跑）
pnpm smoke          # 端到端：spawn bin.ts → health → 建应用 → SSE → 历史 → git
pnpm typecheck      # 4 个 packages + 4 个 spikes
```

spike 复跑入口（历史证据，仍在）：

```bash
pnpm spike:db       # PGlite + TypeORM 压测（含正确性探针）→ spikes/db/results/spike-db.json
pnpm spike:agent    # pi-durable 闭环 + 崩溃续跑            → spikes/agent/results/spike-agent.json
pnpm spike:gateway  # 网关 HMR 代理
pnpm spike:loc      # 定位插件精度
```

服务端环境变量：`TENON_HOME`（数据目录，默认 `~/.tenon`）、`TENON_PORT`（0=随机）、
`TENON_HOST`、`TENON_TOKEN`、`TENON_FAUX=1`（假模型）、`TENON_LOG=1`（pino）。

> `spikes/*/pgdata*`、`spikes/*/work/` 是运行产物，已 gitignore；`results/*.json` 保留入库作为证据。

---

## 7. 新会话开场提示词（可直接粘贴）

```
继续 Tenon（榫）项目，路径 /Users/mac/project/miaoda。

先读 docs/STATUS.md（现状、下一步、陷阱），再读 docs/SPIKES.md（四个 spike 的实测结论，
尤其 §1 的 pool.max=1 硬约束）。涉及架构再查 docs/DESIGN.md（唯一事实来源 v1.2.3），
写 pi 相关代码前必查 docs/PI-CHEATSHEET.md。

当前阶段：M1 主干。第 1~6 步 + 工具层已完成（packages/{protocol,core,agent,server}，33 个测试 + 9 项冒烟全绿）。
接着做 STATUS.md §4.4：生成器（react-vite 模板）→ 预览网关 → Web 前端。`pnpm test` 与 `pnpm smoke` 要一直保持绿。

三条铁律不要违反：Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 + adapter 包装。
```
