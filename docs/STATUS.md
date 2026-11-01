# STATUS.md — 当前状态与下一步

> **用途：新会话 / 新协作者的唯一入口。读完这一页即可开工，不必先读完整 `DESIGN.md`。**
> 最后更新：2026-11-01（**M1 全部 9 步 + M2 七步落地（第 8 步 Docker 产物按用户决定跳过）+ M3 全部完成**：277 个测试 + 9 项端到端冒烟 +
> 16 项预览 e2e + 13 项精调 e2e（真 Chromium 里模拟 Alt+Click）+ 36 项改动/回滚 e2e + 32 项发布 e2e（系统 git 当裁判：`fsck --strict` + `clone`）
> + 全栈 e2e + 8 项桌面冒烟全绿；`pnpm dev:web`、`pnpm e2e:fullstack` 与打包后的 `Tenon.app` 都实测走通。**M2 已收口，M3 已收口**）

---

## 0. 一句话现状

**生成的应用现在有后端了：一句话建出来的应用自带 NestJS + PostgreSQL（默认 PGlite 零安装），
前端一个 `fetch('/api/health')` 就能打通，切换成真 PG 只改 `DATABASE_URL`，应用代码零改动。**

M1 已经全部落地（一条命令起界面、对话里改代码、iframe 当场热更新、能打成 `Tenon.app` 双击运行）；
M2 第 1 步把「只有页面」变成「有库、有接口、能 CRUD」；第 2 步把它变成「**出错了看得见**」：
Vite/Nest 子进程输出、页面异常（含堆栈）都汇进日志面板，预览停了缓冲还在；
第 3 步把「要发布」的两块补齐了 —— **运行时 SDK**（异常上报 / 错误边界 / Nest 5xx 过滤器，源码分发进模板）
与**跨档数据迁移**（`pglite → postgres` 纯 JS 逻辑拷贝，零二进制依赖）。

**M3 完成**：模板里的每个 JSX 都带着 `data-tenon-loc` / `data-tenon-callsite`（编译期注入，只 dev 生效）；
在预览里**按住 Alt** 就能描边高亮，**Alt+点一下**把元素反查回 `src/App.tsx:25:3` 并跨源送回平台，
Composer 顶部出现一个可删除的上下文 chip，发送时一并交给 Agent。整条链路在 Electron 的真 Chromium
里跑通（`pnpm e2e:inspector` 13 项，父页面与网关**跨源**，token 与 origin 都是真校验）。
**回滚现在同时管代码和数据**：改动面板里能逐行看某一版改了什么，回滚默认只退代码；
动了表结构的那几版会自动存下库快照，勾上「连数据库一起回去」才会连数据一起退 —— 而且会先检查能不能做，
做不到就什么都不动（不会留下"代码退了、数据没退"的半成品）。

**能发布了**：顶栏「发布」把这个 commit 冻结成 `v<日期>-<n>`（annotated tag，说明进正文），
推到本地裸库 `~/.tenon/backups/<appId>.git` —— 标准裸库，`git clone` 出来就是这一版的完整代码。
`pnpm e2e:release` 用**系统 git 当裁判**（`fsck --strict` + `clone`）验收；产品运行时不依赖任何 git 二进制。

先跑这几条验证它还活着：

```bash
pnpm install && pnpm dev:web    # ★ 一条命令起界面：server + 前端，浏览器打开 http://127.0.0.1:5173
pnpm dev:desktop                # ★ 桌面版（同一份 server，Electron 只当壳）
pnpm test                       # 277 项单测 + 集成测试（约 102s，含 PGlite 冷启动）
pnpm smoke                      # 9 项端到端（真 spawn 进程，走 HTTP + SSE）
pnpm e2e:preview                # 16 项真机全链路：建应用 → 装依赖 → 起 Vite → 经网关打开 → 断言定位注入 → 改文件 → HMR（要联网）
pnpm e2e:inspector               # ★ 13 项精调链路：Electron 真 Chromium，父页面与网关跨源，模拟 Alt+Click（要联网）
pnpm e2e:diff                    # ★ 36 项改动链路：git.log / git.show / git.revert 全走真 HTTP（含根提交与错误码）
pnpm e2e:release                 # ★ 32 项发布链路：打 tag + 推本地裸库，用系统 git 做 fsck --strict 与 clone 验收
pnpm e2e:fullstack              # ★ 全栈真机链路：PGlite 起库 → 迁移 → Vite+Nest 双进程 → CRUD 经网关 → 重启后数据还在
pnpm pack:desktop               # 打包成 apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop:packaged     # 8 项桌面冒烟：真的起 .app、加载界面、退出后不留孤儿进程
```

- `packages/{protocol,core,agent,server,generator,gateway,db-provisioner}` 七个包已建；`pnpm typecheck` 全绿（15 个项目）
- 服务真起来了：Fastify 5 / 随机端口绑 `127.0.0.1` / Bearer Token / `/api/health` / `TENON_READY` 握手行
- `tenon.db`（`node:sqlite`）在建应用、写设置、存提供商密钥时真的落盘
- 每应用一个 `.tenon/harness.sqlite`，进程重启后 `resume()` 把中断的一轮**跑完**（有测试）
- SSE 增量 / `message.end` / `usage` / `app.status` 全链路打通；每轮结束自动 git 提交（无改动不产生空提交）
- **Agent 能真的写代码了**：`read` / `write` / `edit` / `bash` 四个工具已接到 pi-durable 注册表上，
  写完的文件进得了这一轮的 commit（`packages/agent/src/tools/coding.ts`）
- **能真的看到一个应用**：`app.create` 会用模板铺出可跑的工作区，`preview.start` 装依赖 + 起 dev server +
  挂到 App Gateway 后面，iframe 打开的就是它
- **有界面了**：`apps/web`（React 19 + Vite 7 + Tailwind 4）左栏会话 + 右栏 iframe，`pnpm dev:web` 一条命令起；
  浏览器里实测：建应用 → 自动起预览 → iframe 出现模板页 → 改 `repo/src/App.tsx` → **iframe 不刷新就变了**
- **能装成桌面应用了**：`apps/desktop` 主进程只做生命周期（spawn server → 读 `TENON_READY` → 开窗口），
  页面由 server **同源托管**并在 index.html 里注入 Token（不走 preload、不走 `file://`）；
  `pnpm pack:desktop` 出 `Tenon.app`（338MB），打包冒烟实测：窗口出界面 → 退出后子进程收干净
- **★ M2 第 1 步（应用有后端了）**：
  - `packages/db-provisioner`：`DatabaseProvider { start/stop/connectionString/dump/restore }`，
    `pglite` 档（默认，零安装）与 `postgres` 档（发布，Docker/外部/云）同接口；**`poolMax()` 恒为 1**
  - `templates/nest-api`：NestJS 11 + TypeORM + PG 方言 + zod 共享层；**迁移只写一份，两档同跑**
  - `preview.start` 从 1 个进程变 2 个（Vite + Nest），网关按最长前缀分流：`/api/*` → Nest，其余 → Vite
  - 生成应用只认 **`DATABASE_URL`**（+ `DATABASE_POOL_MAX` 这个容量参数），不判断任何运行环境
  - 桌面版不再依赖系统 `pnpm`：安装包自带（`Resources/server/node_modules/pnpm`）
- **★ M2 第 2 步（可观测：日志/错误面板）**：
  - `packages/gateway/src/logs.ts`：`LogStore` 环形缓冲（每应用隔离、1 秒内同句合并成 `repeat++`、上限截断）；
    `stripAnsi` 剥 Vite 输出的颜色控制序列（否则界面里全是 `[2m`）
  - 三个来源汇进同一面板：子进程 stdout/stderr（`vite` / `api`）、页面主动上报（`web`，经网关
    `POST /__tenon/log`，**不转发上游**）、平台自己的关键节点（`tenon` / `db`）
  - `app.log` SSE 事件 + `logs.list` / `logs.clear` RPC；**日志跟应用走不跟预览跑** —— 停了预览缓冲还在
  - 两个模板都装了 `tenon-log.ts`（`window.onerror` / `unhandledrejection`）+
    `tenon-boundary.tsx`（ErrorBoundary）—— **零新依赖**，上报走同源 fetch
  - 界面：`apps/web/src/features/logs/LogPanel.tsx`（折叠底栏、按来源筛选、错误高亮、详情展开、清空）
- **★ M2 第 3 步（能发布了）**：
  - `packages/runtime-sdk`（`@tenon/runtime`）：**源码分发** —— `sync-templates.mjs` 把
    `tenon-log.ts` / `tenon-boundary.tsx` / `tenon-logger.ts`（Nest 全局异常过滤器）拷进两个模板，
    漂移由测试逐字节拦住。生成应用仍然**零平台依赖**（铁律 2）
  - 跨档迁移 `migrateDatabase()`：两端走 PG 协议，`information_schema` 取表列、`pg_constraint` 取外键
    做拓扑排序、分批 `insert … on conflict do nothing`、**`setval` 对齐序列**、逐表 `count(*)` 校验
  - 日志面板增强：堆栈续行（`    at …`）并进上一条的 `detail`，不再碎成三十条
- **M2 剩余**：Docker compose 产物（**阻塞：本机无 Docker / podman / colima**）

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
| `docs/DESIGN.md` | **唯一事实来源**，v1.2.9，1700+ 行 | 写涉及架构的代码前，按需读对应章节 |
| **`docs/SPIKES.md`** | 四个 spike 的实测数字与结论（含被推翻的假设）| 碰 DB / pi / 网关 / 定位插件前必读 |
| `docs/ARCHITECTURE.md` | 一分钟速览 + 四条原则 | 给别人介绍时 |
| `docs/PI-CHEATSHEET.md` | pi 全生态真实 API（读源码所得）| **写任何 pi 相关代码前必查**（比官方文档全）|
| `docs/PROTOCOL.md` | 妙搭行为规格（clean-room）| 不确定某个交互该怎么做时 |
| `docs/REVERSE_ENGINEERING.md` | 内部研究方法 | 仅内部，不随开源发布 |

`docs/reverse/`、`*.har` 已 gitignore，**不得提交**，也**不得把其中的代码/文案/提示词搬进产品**（clean-room 红线）。

---

## 4. 进度与下一步

### 4.1 第一周：4 个 spike —— ✅ **已全部完成（2026-10-31）**

| # | 验证什么 | 结果 |
|---|---|---|
| 1 | `pi-durable` 最小闭环：`Harness.open` + `submit` + 流式 + `resume()` | ✅ 10/10。**流式中途 SIGKILL → `resume()` 把同一提交从 `placed` 跑到 `done`** |
| 2 | App Gateway 代理 **Vite HMR WebSocket** | ✅ 8/8。HMR update **134ms**；上游换端口网关 URL 不变 |
| 3 | `data-tenon-loc` 在 JSX 上准确对应 `file:line`（经组合组件） | ✅ 7/7。改为 `loc`（原生）+ `callsite`（组合组件）双属性，9/9 可回溯 |
| 4 | **`PGlite + pg-gateway + TypeORM`** 稳定性与 P95 | ⚠️ **有条件通过**：20 并发 P95 14ms(读)/24ms(写)、零超时；但 **`pool.max>1` 会让并发事务互相回滚 → 必须为 1** |

详细数字、可复跑命令、被推翻的假设：**`docs/SPIKES.md`**。

### 4.2 主干（按依赖顺序）

**M1 骨架与对话**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | monorepo 骨架（workspace / tsconfig / vitest） | ✅ | `packages/*` 四个已建；`generator`、`db-provisioner`、`runtime-sdk`、`ui`、`component-host` 与 `apps/*` 随对应步骤建 |
| 2 | server 起来（Fastify 5 / 随机端口 / Token / health） | ✅ | `packages/server/src/{app,bin,index}.ts` |
| 3 | `tenon.db`（`node:sqlite`，5 张表） | ✅ | `packages/core/src/{db,stores/*}.ts` |
| 4 | harness 池（每应用一个 sqlite，`resume()`） | ✅ | `packages/agent/src/harness-pool.ts` |
| 5 | SSE 对话链路（`chat.submit/stop/history`） | ✅ | `packages/agent/src/chat.ts` + `packages/server/src/sse.ts` |
| 6 | Git 自动提交（isomorphic-git，trailer） | ✅ | `packages/core/src/git.ts` |
| 6.5 | **工具层**：read/write/edit/bash 接进 pi-durable（cwd 钉在 `repo/`、越界拒写、环境洗净） | ✅ | `packages/agent/src/tools/coding.ts` |
| 6.6 | **生成器**：`templates/react-vite` 铺进 `repo/`，与首次 commit 同一个动作 | ✅ | `packages/generator/` |
| 7 | **预览**：App Gateway + dev server 编排（`preview.start/stop/status` + `preview.status` 事件） | ✅ | `packages/gateway/` |
| 8 | **Web 模式**：`pnpm dev:web` 全流程可用（前端 React 19 + Vite 7） | ✅ | `apps/web` + `scripts/dev-web.ts` |
| 9 | **Electron 壳** + 同源托管 + 打包冒烟 | ✅ mac 实测（win 待 M6 有机器时补） | `apps/desktop`（main/supervisor/paths + build.mjs）、`packages/server/src/static.ts` |

**M1 完成**：界面上点「新建应用」→ 铺模板 → 自动起预览 → 在对话里说需求 → Agent 改代码 → iframe 热更新 →
关掉窗口、双击 `Tenon.app` 再来一次，数据都在。
`data-tenon-loc` 的编译期注入当时留到了 M3 —— **已在 M3 第 1 步落地**（Babel 插件，源码分发进模板）。

**M2 全栈生成**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **两档数据库供给**：`DatabaseProvider` 接口 + `pglite`/`postgres` 两档 + 按 appId 缓存 | ✅ | `packages/db-provisioner/src/{types,pglite,postgres,manager}.ts` |
| 2 | **全栈模板**：NestJS 11 + TypeORM + PG 方言 + zod 共享层，迁移只写一份 | ✅ | `packages/generator/templates/nest-api/` |
| 3 | **双进程预览**：Vite + Nest，网关按 `/api/*` 最长前缀分流，三端口先占后告诉 | ✅ | `packages/gateway/src/{api,child,preview}.ts` |
| 4 | **全栈端到端**：建应用 → 起库 → 迁移 → 双进程就绪 → CRUD 经网关 → 重启数据还在 | ✅ | `scripts/e2e-fullstack.ts` |
| 5 | 桌面版自带包管理器（不再依赖系统 `pnpm`） | ✅ | `packages/gateway/src/deps.ts` + `apps/desktop/{build.mjs,electron-builder.yml}` |
| 6a | **日志/错误面板**：LogStore + 三来源汇流 + `app.log` SSE + 模板侧零依赖上报 | ✅ | `packages/gateway/src/logs.ts`、`apps/web/src/features/logs/LogPanel.tsx`、模板 `src/tenon-{log,boundary}` |
| 6b | **runtime SDK**：`@tenon/runtime` 源码分发（异常上报 / 错误边界 / Nest 过滤器）+ 漂移测试 | ✅ | `packages/runtime-sdk/`（`src/browser`、`src/nest`、`scripts/sync-templates.mjs`） |
| 7 | **跨档迁移**：`pglite → postgres` 纯 JS 逻辑拷贝（v1.2.9 变更，原 `pg_dump` 方案因用户机器无二进制而废弃） | ✅ 逻辑已验；真 PG 未实测 | `packages/db-provisioner/src/migrate.ts` |
| 8 | Docker compose 产物（多阶段 + `postgres:18-alpine`） | ⏸ **用户决定先跳过**（本机无容器运行时，不产出未验证文件） | 模板 `Dockerfile` / `compose.yml`（欠账） |

**M3 精调与版本**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **编译期源码定位注入**：Babel 插件给原生标签标 `data-tenon-loc`、给组合组件标 `data-tenon-callsite`（callsite 优先，`loc` 留作 secondary）；只 dev 生效 | ✅ | `packages/runtime-sdk/src/vite/tenon-loc.ts` → 模板 `src/tenon-loc-plugin.ts` + `vite.config.ts` 的 `react({ babel: { plugins } })` |
| 2 | **反查解析器**：DOM 元素 → `{file,line,column,kind}`，`kind` 区分 usage / element / component-impl，自身没属性向上找 | ✅ | `packages/runtime-sdk/src/browser/tenon-loc.ts` → 模板 `src/tenon-loc.ts` |
| 3 | **inspector 交互**：Alt+Hover 描边+跟随标签、Alt+Click 选中、Alt+Drag 框选（只收最内层，上限 50）、ESC 退出；overlay `pointer-events:none`；capture 阶段吃掉 click | ✅ | `packages/runtime-sdk/src/browser/tenon-inspector.ts` → 模板 `src/tenon-inspector.ts`（dev 动态 import，生产被摇掉） |
| 4 | **跨源回传**：iframe hash 带 token → `postMessage` → 父窗口校验 `origin` + `source` + `token` → Composer 顶部 chip → `chat.submit` 带上 `selection` | ✅ | `apps/web/src/lib/selection.ts`、`hooks/useInspectorSelection.ts`、`packages/protocol/src/selection-text.ts` |
| 4.5 | **送到 Agent**：拼成 `[TENON-SELECTION] {json}` 首行（`pi-durable` 的 submit 只吃纯文本），渲染用户气泡时用 `stripSelectionBlock` 剥回原文 | ✅ 链路已通；"改样式并自验"仍需真模型（faux 做不到） | `packages/agent/src/chat.ts`、`MessageList.tsx` |
| 5 | **真机 e2e**：Electron 开真 Chromium，父页面在**另一个源**，模拟 Alt+Click，用平台自己的校验函数过一遍 | ✅ | `scripts/e2e-inspector.ts`（`pnpm e2e:inspector`，12 项） |
| 6 | **Diff 视图**：`git.show` 返回逐文件、逐行的结构化差异（两侧行号、`binary`/`truncated` 标记）；面板覆盖在预览之上（iframe 不卸载），左侧版本列表、右侧折叠上下文的逐行着色 | ✅ | `packages/core/src/git.ts` 的 `showCommit` / `buildDiff`、`apps/web/src/features/diff/DiffPanel.tsx`、`lib/diff.ts` |
| 7a | **代码回滚**：`git.revert` 产生反向提交（历史保留），两步确认，回滚后自动停在回滚提交上 | ✅ | `apps/web/src/hooks/useWorkspace.ts` 的 `revertCommit`、`DiffPanel` 的确认态 |
| 7b | **回滚的数据侧**：改过 schema 的 commit 自动存库快照 + `dbRestore` 可选还原 | ✅ 见 §4.7 | `packages/db-provisioner/src/manager.ts`、`packages/server/src/revert-data.ts` |
| 8 | 真机 e2e：三条 git RPC 全部走真 HTTP（含根提交、错误码映射） | ✅ | `scripts/e2e-diff.ts`（`pnpm e2e:diff`，36 项） |
| 9 | **发布 push**：打 annotated tag（版本说明进正文）+ 镜像到本地裸库 `~/.tenon/backups/<appId>.git` + 记 release；闸门是「不在生成中 / 有提交 / 工作区干净」，推送失败删 tag | ✅ 见 §4.8 | `packages/core/src/release.ts`、`packages/server/src/release.ts`、`features/release/ReleaseDialog.tsx`、`scripts/e2e-release.ts` |

### 4.3 M1 验收（DoD）

- [x] `pnpm dev:web` 打开即可对话 —— 浏览器实测：建应用 → 发消息 → 流式回来 → 自动 git 提交 → 版本数 +1
- [x] 生成一个纯前端 Todo 应用，iframe 里热更新生效 —— 模板铺得出、dev server 起得来、网关打得开；
      **浏览器里实测**：改 `repo/src/App.tsx` 的 `<h1>` → iframe 里的标题当场变，页面没有整页刷新（计数不归零）。
      `pnpm e2e:preview` 另有 14 条机器人断言（含「HMR 推送指向刚改的模块」）。**真正"Todo 应用"要等接真模型**
- [x] 每轮对话产生一个 git commit —— `chat.ts` 每轮结束调 `commitAll`；**本轮没有文件改动时不产生空提交**。
      工具层接上后已能真的产出 commit（`tools.test.ts` 断言：建应用 1 个 + 写文件那轮 1 个）
- [x] 杀进程重启后，对话与任务能续跑（`resume()`）—— `packages/server/test/chat.test.ts` 的「崩溃续跑」用例：生成中途关进程 → 重启 → 这一轮自己跑完（403ms）
- [x] 打包成桌面应用并双击可用 —— `pnpm pack:desktop` 出 `Tenon.app`（x64，338MB）；
      `pnpm smoke:desktop:packaged` 八项全过：**窗口加载的是渲染器（标题「Tenon · 榫」）**、拿到了注入的 Token、
      不落错误页、退出后 server 真的停了（端口没人听）。`build.mjs` 扫 `dist/` 做原生模块审计（v1.2.13 起只报不拦）

### 4.4 M2 第 1 步验收（DoD）—— ✅ 已完成

- [x] 生成的应用默认带库 —— `app.create` 建 `nest-api` 模板时 `DatabaseManager.acquire()` 起一个 PGlite，
      数据目录落 `~/.tenon/apps/<id>/pgdata`（38MB），**零安装、无原生模块**
- [x] **两档跑同一份迁移** —— `api/migrations/1767225600000-InitItems.ts` 只有一份；
      `pnpm e2e:fullstack` 实测 `health.db.version === 'PostgreSQL 18.6'`、迁移数 ≥1
- [x] `pool.max` 真的是 1 —— 从 Nest 侧驱动实例读回 `driver.master.options.max`，断言 `=== 1`。
      不是"文档写了 1"，是**真的传到了 `pg.Pool`**
- [x] 双进程经同一网关 —— `readiness` 四格（db/server/preview/api）全 ready，`apiPort` 非空，
      `gatewayPort === url 的端口`；`GET /api/items` 走 Nest、`GET /不存在的路径` 不回落成前端 HTML
- [x] 切换库只改连接串 —— 生成应用侧只出现 `DATABASE_URL` / `DATABASE_POOL_MAX`，
      **模板里搜不到 `NODE_ENV` / `TENON_*`**（有测试逐文件断言）
- [x] 重启不丢数据 —— 停预览 → 再起（1474ms，比首次 9711ms 快，pgdata 复用）→ 之前写的行还在
- [x] 桌面版不再要系统 pnpm —— `deps.ts` 优先找 `<Resources>/server/node_modules/pnpm/bin/pnpm.cjs`，
      打包后实测能起预览

### 4.5 M2 第 2 步验收（DoD，日志/错误面板）—— ✅ 已完成

- [x] 子进程输出进面板 —— `vite` / `api` 两个来源各有日志；**tsc 编译报错也归 `api`**
      （它同样意味着"后端起不来"）
- [x] ANSI 已剥掉 —— Vite 的彩色输出在界面里是纯文本（`stripAnsi`，有单测）
- [x] 页面异常带着堆栈上报 —— `window.onerror` / `unhandledrejection` / ErrorBoundary 三条路
      → 同源 `POST /__tenon/log` → 网关拦下（**不转发上游**）→ 面板里看到 `message + detail`；
      `pnpm e2e:fullstack` 实测：人为 throw → `logs.list` 拿得到且 `detail` 含堆栈
- [x] 上报端点回 204 —— 不落上游、不报错、不污染应用自己的 API
- [x] 停预览后日志还在 —— `LogStore` 跟应用走不跟预览跑；`app.delete` 才连缓冲一起丢（`forget()`）
- [x] 同句重复不刷屏 —— 1 秒内同一条合并成 `repeat++`，**合并后照样推**（id 不变，前端按 id upsert
      → 界面上是一条 ×N，不会跳行）
- [x] 零新依赖 —— 两个模板的上报实现不引任何包（纯 fetch + 原生事件），不破"锁版本"铁律

### 4.6 M2 第 3 步验收（DoD，能发布的那两块）—— ✅ 已完成（Docker 产物除外）

- [x] **运行时 SDK 成为唯一事实来源** —— `packages/runtime-sdk` 的 `src/browser/tenon-log.ts`、
      `src/browser/tenon-boundary.tsx`、`src/nest/tenon-logger.ts` 是原件；`scripts/sync-templates.mjs`
      把它们拷进两个模板；`test/sync.test.ts` **逐字节**比对，改一边忘另一边直接测试红
- [x] **生成应用仍然零平台依赖** —— 副本是普通 `.ts`/`.tsx` 文件，应用不 import `@tenon/runtime`、
      不认任何 `TENON_*`（导出成 Docker 也装得起来，铁律 2）
- [x] **Nest 侧 5xx 有格式** —— `TenonLoggerFilter` 全局挂上（`APP_FILTER`）：5xx 打一行摘要 + 堆栈、
      4xx 打一行 warn；`pnpm e2e:fullstack` 实测日志里有 `4xx POST /api/items → 400`（**认字面格式**，
      不是"有日志就算过"）
- [x] **全局过滤器不会把请求挂死** —— `@Catch()` 接管分发权后必须自己补响应；
      单测断言 4xx/404/500 三种情况的状态码与响应体（500 不回显内部错误）
- [x] **跨档迁移数据零丢失** —— `migrateDatabase()` 10 项实测：外键顺序（父表先插）、布尔/时间戳/
      生成列/`jsonb` 原样搬、**序列 `setval` 后新插入不撞主键**、目标缺表明确报错、可重跑
      （`on conflict do nothing`）、进度回调、TypeORM 生成的真表也认
- [x] **零二进制依赖** —— 不用 `pg_dump`/`pg_restore`/`psql`（本机与用户机器都没有）。
      两端都是 PG 协议连接，纯 SQL
- [x] **面板里的堆栈不再碎成一堆行** —— `LogStore.addLine` 把 `    at …` 续行并进上一条的 `detail`
      （id 不变 → 前端 upsert → 界面上还是一条，点开能看全栈）
- [ ] **Docker compose 产物** —— ⛔ 阻塞：本机无 `docker`/`podman`/`colima`，无法"构建并跑起来"。
      DoD ④ 不能靠猜收口，故**不产出未验证的 Dockerfile**

### 4.7 M3 第 7b 步验收（DoD，回滚的数据侧）—— ✅ 已完成

- [x] **只在改过 schema 的提交上存快照** —— 判据是路径约定（`api/migrations/**`、`*.entity.ts`、
      `shared/schema.ts`），写在 `@tenon/core` 的 `schema-change.ts` 里。7 条测试钉住正例与**反例**
      （`migrations/README.md`、`item.entity.spec.ts`、`src/pages/user/schema.ts` 都不该触发）。
      用路径不用"扫 SQL 关键字"：后者要猜方言，还会被字符串里的 `CREATE TABLE` 误伤
- [x] **快照按 commit sha 归档** —— `exports/db/<sha>/db.tar.gz`。按时间戳命名就得再存一份
      "文件 ↔ 提交"的映射，两份迟早对不上
- [x] **库不存在时不存** —— 返回 `null` 而不是存一份空库。空库快照会让"有快照"变成骗人的信号
      （测试断言连 `pgdata` 目录都不该被顺手造出来）
- [x] **存完把库按原状放回去** —— 原本 stopped 的存完还是 stopped；原本 ready 的保持 ready。
      否则每提交一次就泄漏 38MB
- [x] **★ 还原之后表结构与数据都回到那一刻** —— 真 PGlite 实测：快照后 `alter table add column`
      + 再插一行 → restore → 新列没了、只剩快照时的那行数据
- [x] **★ 运行中打快照不会卷入未提交事务** —— 开事务插一行不提交 → 打快照 → rollback → restore，
      结果里只有已提交的那行。PG 的 WAL + xid 机制本该防住，但"本该"不是证据
- [x] **`git.revert` 的 `dbRestore`（默认 false）** —— 返回 `data: { requested, restored, fromSha,
      skippedCommits }`，前端据此说清"退到了哪一版"而不是假装精确
- [x] **★ 顺序是「检查 → 还原数据 → 回滚代码」** —— 覆盖库不可逆、回滚代码可逆。`e2e:diff` 实测：
      带 `dbRestore` 但没有快照时抛 `DB_SNAPSHOT_MISSING`，**提交数不变、迁移文件还在**
      （不会留下"代码回滚了、数据没回滚"的半成品）
- [x] **`skippedCommits` 的语义** —— 从"目标的父提交"到"实际用的那份快照"之间隔了几个提交。
      6 条单测钉住偏移（父提交命中 = 0，退到祖父 = 1），错这个不会报错、只会悄悄多丢几轮数据
- [x] **档位不匹配明确拒绝** —— 拿 PGlite 的 tar.gz 去 `pg_restore` 只会得到一句天书
- [x] **UI**：勾选框默认**不勾**，文案带"会丢弃该时点之后写入的数据"；只有改过 schema 的版本才显示；
      还原后自动重起预览（服务端为免刷一屏断连错误先把它停了）

**没做的**（写在这里而不是假装做了）：`postgres` 档仍走 `pg_dump --format=custom`，缺二进制时明确报
`DB_UNSUPPORTED`。原来的计划是"用临时库 + 逻辑拷贝绕开 `pg_dump`"，v1.2.13 放开原生模块之后
这条**不需要了**，但也不该顺手接上 —— `pg_dump` 的版本必须不低于服务端版本，而发布档连的是
用户自己的云 PG（DBeaver 里有 13/14/15/16/17/18 各种），打包一份 18 的二进制去连 19 的库照样失败。
发布档的数据回滚，云厂商的 PITR 才是正解。

> 快照会累积：每个改过 schema 的提交一份，`pglite` 档一份约 4~5MB。**暂未做清理策略** ——
> 一个应用聊五十轮也不可能触发五十次，等真出现容量问题再加 LRU。`app.delete` 时随目录一起删。


### 4.8 M3 第 9 步验收（DoD，发布 push）—— ✅ 已完成

- [x] **版本号是 `v<yyyy.MM.dd>-<n>`，同日递增** —— `nextVersion()` 是纯函数（5 条单测钉住：
      当天首个 `-1`、同日递增、**别的日期的 `-9` 不影响今天**、不认识的字符串直接忽略、形状不精确就不认）
- [x] **版本号同时参考发布记录与仓库 tag** —— 只信一边都会撞号：记录被删过、或备份库是从别的机器拷来的
- [x] **tag 是 annotated 且带发布说明** —— `git cat-file -t vX` 返回 `tag`（不是 commit），
      `git cat-file -p vX` 能看到正文里的说明。轻量 tag 在 `git show` 里什么也没有，
      把备份库交给别人时版本说明就丢了
- [x] **★ 备份库是标准裸库，`git clone` 能直接用** —— e2e 请系统 git 当裁判：`fsck --strict` 通过
      （没有 missing / could not be parsed）、`rev-parse --is-bare-repository` 为 true、
      clone 出来的工作区 `status --porcelain` 干净、`log` 历史条数对得上
- [x] **★ 旧版本标签不被改写** —— 发第二版之后，`git cat-file -p <第一版 tag>:src/notes.md`
      仍然是第一版的内容（发布是**冻结**，不是覆盖）
- [x] **重复发布只写增量** —— 第二次镜像 `objects` 数为 0（已存在的对象跳过）；
      改一轮再发只写那几个新对象。备份库不会随发布次数膨胀成 N 份全量
- [x] **闸门：不在生成中** —— `app.status === 'running'` 时 `APP_BUSY`。生成中途发布 = 发一份写了一半的代码
- [x] **闸门：工作区必须干净** —— `GIT_DIRTY_WORKTREE`，错误里点名具体文件（`message` 带文件名、
      `details.paths` 带前 50 个），不是一句"有未提交改动"
- [x] **闸门：仓库必须有提交** —— `RELEASE_NO_COMMITS`，且**不留下空备份库**（e2e 断言
      `backups/<id>.git/HEAD` 不存在）
- [x] **★ 推送失败时把 tag 删掉** —— 否则留下"有 tag、没记录"的半成品：下次发布直接跳到 `-2`，
      用户会以为少发了一版。集成测试用一个「备份库路径是个普通文件」的场景逼出这条
- [x] **UI**：顶栏「发布」→ 对话框显示这一版是哪条提交、可选发布说明（进 tag 正文）、
      成功后给出**备份库路径与 `git clone` 命令**（都能一键复制）+ 发布历史列表。
      错误就地显示在对话框里（"工作区还有没提交的改动"离开上下文就没意义）

**没做的**（写在这儿而不是含糊过去）：

- **推到真正的远端**（GitHub / GitLab / Gitea）：isomorphic-git 的 `push` 只走 HTTP 传输，
  要凭据也要真网络，本机无法验证。接的时候是加一个 transport，不是重写发布流程
- **Docker 产物 / 静态包导出**：前者阻塞在"本机无容器运行时"，后者要跑 `vite build` 再打包产物
- **质量门禁**（lint / typecheck / 测试）：现在只查"有提交"与"工作区干净"

> 备份库会累积：一个应用一个裸库，每次发布写增量对象。**暂未做清理** —— 生成应用是几十个文本文件，
> 历史几十轮的体积也只有几 MB。`app.delete` 时备份库**不会**一起删（那是用户可能还想留的交付物），
> 需要时手动删 `~/.tenon/backups/<appId>.git`。

> 已知欠账（有环境就能补）：Docker compose 产物（M2 第 8 步）；
> `pglite → 真 PG` 的迁移端到端；`pnpm e2e:fullstack` 未进 CI（要联网装 NestJS）；
> `SelectionContext.screenshot` 字段留了没填（Electron `capturePage` 或 iframe 里 canvas）。
>
> **7b 的覆盖缺口（如实记）**：三条路径各自都验了 —— 库快照与还原用真 PGlite（`snapshot.test.ts`）,
> preflight 失败时"什么都不动"用真 HTTP（`e2e:diff` 第 10 节）,`skippedCommits` 的偏移用纯函数单测。
> **没验的是成功路径的完整串联**：`preview.stop → restoreDatabase → gitops.revert` 三者按序执行的
> 端到端（要真起预览装依赖，60s+，没进 CI）。手工验法：建一个全栈应用 → 让 Agent 加一列 →
> 录两行数据 → 在改动面板点那一版、勾上「连数据库一起回去」→ 确认新列消失、只留快照时那行。

### 4.8 代码地图（只列已落地的）

```
packages/
├── protocol/            # ★ 契约：errors(ErrorCode) / domain / rpc(方法表) / events(SSE) / result(信封)
│   └── src/rpc.ts       #   一张表三种用途：服务端校验、前端取类型、覆盖率测试断言
├── core/                # 领域服务，不认识 HTTP
│   ├── src/paths.ts     #   TENON_HOME 布局（唯一算路径的地方）
│   ├── src/db.ts        #   node:sqlite + PRAGMA user_version 线性迁移
│   ├── src/git.ts       #   isomorphic-git：commitAll / log / diff / showCommit / planRevert / revert（回滚 = 新提交）
│   │                    #   + createReleaseTag（annotated）/ mirrorTo（对象+ref 搬到裸库）/ uncommittedChanges
│   ├── src/schema-change.ts # ★ 快照触发判据：migrations/ + *.entity.ts + shared/schema.ts（路径约定，7 项测试）
│   ├── src/release.ts   # ★ 版本号 v<yyyy.MM.dd>-<n>（纯函数，同日递增；记录与 tag 一起参考避免撞号）
│   ├── src/secrets.ts   #   AES-256-GCM + 0600 密钥文件（桌面版换 safeStorage）
│   └── src/stores/      #   apps / releases / settings / providers
├── agent/               # pi 生态的唯一入口（铁律 3 的落地点）
│   ├── src/models.ts    #   faux / BYOK(openai-compatible, 自建 provider)；faux 可用 script() 驱动工具
│   ├── src/harness-pool.ts  # 每应用一个 harness.sqlite + resume() + 装工具扩展
│   ├── src/chat.ts      #   submit/stop/history/plan + watchEvents → SSE（40ms 合帧）
│   ├── src/tools/coding.ts  # read/write/edit/bash ↔ pi-durable 的 adapter（DESIGN §4.3.1）
│   └── src/docs.ts      #   tenon.app / tenon.plan（defineDoc）
├── generator/           # 模板铺进 repo（DESIGN §8.7）
│   ├── src/scaffold.ts  #   scaffoldApp：渲染模板 → 写文件；已有 package.json 就拒绝
│   ├── src/registry.ts  #   读 templates/<id>/template.json，递归收集文件
│   ├── src/render.ts    #   只做 {{ident}} 替换；渲染后残留占位符直接抛错
│   └── templates/
│       ├── react-vite/  #   纯前端（默认）：Vite + React 19，一条命令 dev
│       │   └── src/tenon-{log.ts,boundary.tsx}  # ★ 零依赖上报：onerror/unhandledrejection/ErrorBoundary → 同源 POST
│       ├── nest-api/    # ★ 全栈（M2）：Vite + NestJS 11 + TypeORM + zod 共享层
│       │   ├── api/     #   main / app.module / db(dataSourceOptions) / migrations / items
│       │   │            #   tenon-logger.ts（★ 从 runtime-sdk 同步，别手改）
│       │   ├── shared/  #   schema.ts：zod 契约，前后端同一份
│       │   ├── src/tenon-{log.ts,boundary.tsx}  # 同 react-vite（模板各自自包含，收编进 runtime-sdk 是 M2-3）
│       │   └── tsconfig.server.json  # ★ 必须 CommonJS + emitDecoratorMetadata（Nest DI 要）
│       └── blank/       #   空壳（entry=null，不自动起预览）
├── db-provisioner/      # ★ 应用数据库供给（M2，DESIGN §6.4）
│   ├── src/types.ts     #   DatabaseProvider 接口；文件头写明 poolMax 恒 1 与未就绪抛错
│   ├── src/pglite.ts    #   PgliteProvider：pg-gateway 起真 PG 协议端 + dumpDataDir 快照
│   ├── src/postgres.ts  #   PostgresProvider：只探活；dump/restore 走 pg_dump/pg_restore
│   ├── src/manager.ts   #   DatabaseManager：按 appId 缓存（只 stop 不丢 → 端口不变）+ migrate()
│   │                    #   + snapshot/findSnapshot/restoreSnapshot（按 commit sha 归档到 exports/db/<sha>/）
│   ├── src/migrate.ts   # ★ 跨档逻辑拷贝：外键拓扑排序 / 分批 insert / setval 对齐序列 / count 校验
│   └── src/index.ts
├── runtime-sdk/         # ★ 生成应用侧的运行时 SDK（DESIGN §6.4 注 / §17 DoD ⑤）
│   ├── src/browser/tenon-log.ts       #   window.onerror / unhandledrejection → 同源 POST（零依赖）
│   ├── src/browser/tenon-boundary.tsx #   ErrorBoundary：兜住渲染期错误 + 自包含降级 UI（inline style）
│   ├── src/nest/tenon-logger.ts       #   全局 @Catch()：5xx 摘要+堆栈、4xx 一行 warn、补回响应
│   ├── scripts/sync-templates.mjs     # ★ 源码分发：拷进模板（--check 只校验）
│   └── test/sync.test.ts              #   漂移闸门：副本与原件逐字节一致
├── gateway/             # 预览编排（DESIGN §9.1）
│   ├── src/proxy.ts     #   HTTP 转发 + upgrade 原样透传（两侧 socket 必须配对销毁）；
│   │                    #   POST /__tenon/log 在这里被拦下交给 onClientLog（不转发上游）
│   ├── src/preview.ts   #   PreviewManager：deps → 端口 → 网关 → db → vite → api → 并行探活
│   ├── src/logs.ts      # ★ LogStore（每应用隔离、1s 同句合并 repeat、上限截断、堆栈续行并入 detail）+
│   │                    #   stripAnsi / classifyLine / parseClientLog / isStackLine
│   ├── src/deps.ts      #   pnpm install（--prefer-offline，全有超时，失败带最后 20 行）
│   ├── src/vite.ts      #   spawn(process.execPath, [viteBin])：不依赖 PATH 里有 pnpm
│   ├── src/api.ts       # ★ 后端半边：resolveApiEntry + tsc --watch → 等产出 → node --watch
│   ├── src/child.ts     # ★ spawnLogged（200 行环形日志、SIGTERM→4s→SIGKILL）/ groupLaunched / nodeRunEnv
│   └── src/ports.ts     #   先定端口再 strictPort，绝不让 dev server 自己换端口
└── server/              # 只做「挂到 HTTP 上」
    ├── src/app.ts       #   Fastify 装配 / RPC 路由 / SSE / 错误处理
    ├── src/auth.ts      #   Bearer（/api/health 免 Token）
    ├── src/cors.ts      #   只放行回环 origin；预检必须排在鉴权**之前**
    ├── src/handlers.ts  #   `satisfies HandlerMap` → 漏实现编译期就报错；git.revert 的编排
    │                    #   「检查 → 还原数据 → 回滚代码」（覆盖库不可逆，回滚代码可逆）
    ├── src/revert-data.ts # ★ pickSnapshot：沿祖先链找最近一份库快照 + skippedCommits 语义（6 项测试）
    ├── src/release.ts   # ★ 发布编排：闸门（生成中/有提交/工作区干净）→ 打 tag → 镜像 → 记账；失败删 tag
    ├── src/static.ts    #   同源托管 web 产物：页面免 Token + index.html 注入 __TENON__ 与 CSP
    ├── src/bin.ts       #   CLI 入口，打印 TENON_READY（TENON_WEB_DIR 可选）
    └── test/support.ts  #   集成测试夹具：boot / rpc / openSse（先连后发只此一份实现）

apps/web/                # 渲染器：server 的纯客户端（DESIGN §14.6）
├── src/lib/rpc.ts       #   唯一的 RPC 出口；入参返回值由 protocol 方法表推导
├── src/lib/stream.ts    #   SSE：先连后发 / since 续传 / stream.reset 重拉
├── src/lib/fences.ts    #   围栏切分（纯逻辑，独立可测：流式未闭合时的闪烁问题）
├── src/hooks/useWorkspace.ts  # ★ 事件 → 界面状态的唯一归约点（reducer 在这）
├── src/features/chat/   #   MessageList（乐观插入 + 粘底）/ Composer / ChatPanel
├── src/features/preview/PreviewPanel.tsx  # iframe + 四格进度（数据/服务/预览/api）
├── src/features/logs/LogPanel.tsx  # ★ 运行日志底栏：折叠/按来源筛选/错误高亮/详情展开/清空
├── src/features/release/ReleaseDialog.tsx  # ★ 发布：说明写进 tag、成功后给路径与 git clone 命令、历史列表
├── src/features/diff/DiffPanel.tsx  # ★ 改动面板：覆盖在预览上（iframe 不卸载）、逐行着色、两步确认回滚
└── src/features/apps/   #   AppMenu / NewAppDialog（默认选能跑的那个模板）

apps/desktop/            # Electron 壳：只做生命周期（DESIGN §2.2.1）
├── src/main.ts          #   窗口 / 导航守卫 / 关窗即退出 / SMOKE 探针
├── src/supervisor.ts    #   spawn server（ELECTRON_RUN_AS_NODE）+ 解析 TENON_READY + 退避重启（不 import electron，可单测）
├── src/paths.ts         #   打包前后资源路径的唯一算法（dist/ ↔ Contents/Resources/ 同构）
├── build.mjs            #   esbuild 打 server 单文件 + 拷模板/web/pglite/pnpm + 扫原生模块（铁律 3 兜底）
├── scripts/launch.mjs   #   清掉 ELECTRON_RUN_AS_NODE 再起 electron
└── electron-builder.yml #   files: 主进程 / extraResources: server,web,templates + server/node_modules

scripts/
├── dev-web.ts           # 起 server → 读 TENON_READY → 把 url/token 注入 Vite
├── smoke.ts             # 端到端冒烟（真 spawn bin.ts）
├── smoke-desktop.ts     # 桌面冒烟：真起 Electron / Tenon.app，加载界面后退出并验证不留孤儿进程
├── e2e-preview.ts       # 16 项真机断言（含定位注入与 HMR 经网关的真实推送）
├── e2e-diff.ts          # 36 项：git.log / git.show / git.revert 的真 HTTP 行为（含 schemaChanged 判据与数据回滚的 preflight）
└── e2e-fullstack.ts     # ★ 全栈真机断言：库/迁移/双进程/CRUD 经网关/重启后数据还在
```

依赖方向（DESIGN §3.2）**禁止反向**：`protocol ← 全部`；`server → {core, agent, generator, gateway}`；
`agent/gateway → core`；`generator → protocol`（只拿 `TenonError`）；`apps/web → protocol`（**只有类型 + 两个常量**）；
`apps/desktop` **不 import 任何 `@tenon/*`**（只 spawn 进程，DESIGN 铁律 1）。
`core` 不依赖 `generator`：铺模板走 `AppStore.create` 的 `scaffold` 钩子，由 `server` 注入（DESIGN §8.7）。

---

## 5. 已知陷阱（都踩过，别重踩）

| 陷阱 | 说明 |
|---|---|
| **`PGlite` 的 `pool.max` 必须是 1** | 不是调优建议。`pool.max=2` 时两条连接的事务落在同一个 backend 会话上，一条 `ROLLBACK` 会抹掉另一条已写入的行（实测 `iso-A` 丢失）。收益只有 19% p95，不值得 |
| **`harness.resume()` 不能忘** | server 启动序列少了这句，崩溃恢复能力等于没有（spike 1 就是这么验证的）|
| **`ELECTRON_RUN_AS_NODE` 的正确用法** | `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`；不要额外打包 Node |
| **pi 依赖 `node:sqlite`** | Electron 内置 Node 有该模块（已验证），所以不能在 `node_modules` 里补 `better-sqlite3` 之类原生模块 |
| **安装包内原生模块：放开（v1.2.13）** | 原先要求"零原生模块"（v1.2 的收益），现已**撤销**为偏好 —— 安装包预编译分发，用户机器不需要 node-gyp。`build.mjs` 改为**审计**（列清单 + 体积 + 平台标签），不再失败；要卡住设 `TENON_STRICT_NATIVE=1`。**不变的边界：生成应用的依赖仍不引入需按平台编译的包**（用户在本地 `pnpm install`） |
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
| **upgrade 透传之后两侧 socket 必须成对销毁** | 客户端断开时 `upstream.destroy()`，反之亦然。漏了不报错只会漏水：Vite 每次整页刷新重连一次 HMR，几百次后 dev server 撞 FD 上限。**测试里表现为 `server.close()` 永远等不到回调、卡在 afterEach** |
| **`StartServerOptions.env` 是「覆盖对象」不是「完整环境」** | 直接拿它当子进程 env 会抹掉 `PATH`，`pnpm install` 以 `code=null` 失败、报错只说"退出码 null"。`PreviewManager.spawnEnv()` 先 `{...process.env, ...env}` 再 `scrubEnv` |
| **模板的 `{{x}}` 绝不能漏进应用** | `renderTemplate` 渲染后残留占位符直接抛 `TEMPLATE_VAR_LEFT`；`template.json.variables` 声明过的变量缺失抛 `TEMPLATE_VAR_MISSING`。有测试逐文件扫描占位符并核对声明 |
| **铺模板必须在 `initRepo` 之前** | 否则建应用会产生两个 commit（一条空提交 + 一条模板提交），历史看起来像改坏了 |
| **`@vitejs/plugin-react` 6.x 的 peer 是 `vite@^8`** | 模板用 vite 7 就必须配 5.x。装错只会得到一条 `unmet peer` 警告，然后在启动时以看不懂的方式失败 |
| **模板目录不是 workspace 包** | `packages/generator/templates/react-vite/package.json` 不能被 `pnpm install` 当成成员（glob 只到 `packages/*`）。发布时要 `extraResources` 带上整个 `templates/`，或用 `TENON_TEMPLATES_DIR` 指过去 |
| **状态只写库不推事件，前端永远不知道这一轮结束** | `chat.ts` 的 `setStatus()` 现在同时落库 + 推 `app.status`；而且**先提交 git 再发 idle**，否则前端看到"空闲"时版本列表还是旧的 |
| **submission 的 settle 回调可能晚于 `close()` 到达** | 那时 `tenon.db` 已关，写库抛 `database is not open` → unhandled rejection（表现为"33 项测试全过但有 2 个 error"）。`ChatService` 有 `closed` 门；写状态还要 try/catch |
| **测试闸门不能等 `git.commit`** | 这一轮没有文件改动就不会产生提交，等它会一直挂到超时。等 `app.status: idle`（它在提交之后发）|
| **`startGateway` 不传 `port` = HMR 永远不工作** | 端口是**先占后告诉**的：`findFreePorts` 占下 `gwPort` → 写进 `TENON_GATEWAY_PORT` → 模板用它做 `server.hmr.clientPort`。网关若自己再随机挑一个，浏览器就被指去那个没人监听的端口。**页面照常打开、日志干净、连 `url` 的探针也能连上**，只有热更新永远不来。断言要落在「`url` 的端口 === `gatewayPort`」 |
| **`.bin/<cli>` 是 shell 包装，不能用 `node` 跑** | `spawn(process.execPath, ['.bin/tsx'])` 会得到 `SyntaxError: missing ) after argument list`（那是 `sh` 脚本）。要读包自己的 `package.json.bin` 拿 `.js/.mjs` 入口再交给 node —— `scripts/dev-web.ts` 的 `resolvePackageBin()` |
| **浏览器别 import `@tenon/protocol` 主入口** | 主入口的 `z.object(...)` 全在模块顶层求值，rollup 无法 tree-shake。实测 356KB → 256KB（146 → 48 个模块）。前端只 import `@tenon/protocol/browser` |
| **flex 子项少了 `flex-1` 会静默塌成 0 高** | 两栏根节点是 `<section class="flex flex-col">` 的子项，不给增长就退回内容高度，里面的 `flex-1 overflow-y-auto` 连带塌掉。症状像"数据没回来"，DOM 里文字却都在 |
| **默认模板不能取 `templates[0]`** | `blank` 排在最前（最简单），但建完是空目录 → 预览必然以「没有 package.json」失败，用户第一眼是红字。默认取 `react-vite`；`entry === null` 的模板不自动起预览 |
| **`status` 不从列表里取就一直是「准备中」** | `select` / `booted` 两个归约都要 `apps.find(id)?.status`。只置 `null` 的话，界面要等到这个应用下次推 `app.status` 才正常 |
| **环境里的 `ELECTRON_RUN_AS_NODE` 会把 `electron .` 变成 node** | 表现是 `import { app } from 'electron'` 报 `does not provide an export named 'BrowserWindow'`，看着像"Electron 不支持 ESM"（其实 39 支持）。根因：带着这个变量，主进程按普通 node 跑，`'electron'` 解析到 npm 包里那个"返回可执行文件路径"的 shim。**从 IDE / 其他 Electron 应用里启动脚本时会自动带上它**。启动前必须删（`apps/desktop/scripts/launch.mjs` + `supervisor` 只对自己 spawn 的 server 设它） |
| **esbuild 打 ESM 单文件必须注入 `require`** | 依赖里有 CJS（isomorphic-git → shim → `sha.js`），产物以 `Dynamic require of "buffer" is not supported` 崩在启动第一行。`banner: { js: "createRequire(import.meta.url)" }`，见 `apps/desktop/build.mjs` |
| **打包后 `process.execPath` 不是 node** | 是 Tenon 自己。所以要 `ELECTRON_RUN_AS_NODE=1` 才能跑 `server.mjs`；好处是不用再塞一份 node（Electron 39 内置 22.22.1，`node:sqlite` 实测可用） |
| **`templates` 的目录位置是隐式契约** | `registry.ts` 按 `import.meta.url` 找 `../templates`。server 打成 `dist/server/server.mjs` 后，模板必须落 `dist/templates`（打包后是 `Contents/Resources/templates`）。改名就静默找不到模板 |
| **静态托管要分"页面公开"与"接口公开"** | 页面与 assets 免 Token（否则窗口里只有 401 的 JSON），但 `/rpc/*`、`/events`、`/api/*` 必须照旧要 Token。别写成"除接口外全放行"——下一个新增接口会默认裸奔 |
| **SPA 回落不能对 `/assets/*.js` 生效** | 回落成 HTML 时浏览器只报 `SyntaxError: Unexpected token '<'`，根本看不出是 404。`looksLikeFile()` 按扩展名区分 |
| **`index.html` 不能被缓存** | 它是注入 Token 的那一份，缓存住 = 上一个进程的 token（必然 401）。`no-cache`；只有带哈希的 `/assets/` 给 `immutable` |
| **Node ≥ 22.18 的原生 TypeScript 类型擦除会让 `ts-node/register` 彻底失效** | 症状：`node --require ts-node/register api/main.ts` 报 `ERR_UNKNOWN_FILE_EXTENSION` 或 `Cannot find module './app.module'`；即使 `require.extensions['.ts']` 确实注册了也没用 —— `.ts` 入口被 Node 自己的 ESM loader 抢走，CJS 的 require hook 不参与。**`node --no-experimental-strip-types` 也救不了**。全栈模板因此改用 `tsc --watch` 编译到 `dist-server/`，再用 `node --watch` 跑 `.js`（`packages/gateway/src/api.ts`）。顺带好处：Nest 的 DI 本来就需要 `emitDecoratorMetadata`，tsx/esbuild 不产出它 |
| **`node --watch` 只监听"已经加载过"的文件** | 入口文件还不存在时，它打印 `Failed running 'dist-server/api/main.js'. Waiting for file changes` 然后**永不重启**（它没监听任何东西，包括那个目录）。所以 `launchApi` 必须 `await waitForFile(outputPath, compiler, 90_000)`，等首次编译产出再起 runner；超时要把 tsc 最后几行塞进错误里，否则只有一句"没起来" |
| **子进程报错要带多行尾部，不能只取最后一行** | `node --watch` 会把真错误放在 `Failed running ...` 的**上一行**。`tailOf(launched, 6)` 而不是 `lastLine()` |
| **PGlite 必须 esbuild external 并整包拷进安装包** | 它按 `import.meta.url` 相对读 `wasm/`、`data/`、`extensions/`，打进单文件后这些路径全失效（表现为起库即崩）。`build.mjs` 里 external 掉再原样拷到 `dist/server/node_modules/` |
| **electron-builder 的 `extraResources` 会跳过相对路径含 `node_modules` 的文件** | 给 `from: dist/server` 写 `filter: ['**/*']` **也无效** —— 那一层目录直接被忽略，包能打出来、能启动，但 server 一跑就 `Cannot find module`/'server 在就绪前退出'。必须**单列一条** `from: dist/server/node_modules` → `to: server/node_modules` |
| **pnpm 自带 4 个平台的 `reflink.*.node`** | 打包时会触发"dist 里出现需要按平台编译的模块"的兜底断言。删掉后 `pnpm install` 实测照常工作（那是可选加速模块），`build.mjs` 拷贝时按扩展名过滤 |
| **`DATABASE_POOL_MAX` 是容量参数，不是环境判断** | 生成应用读它**只是**为了把 `extra.max` 传给驱动（默认 10），PGlite 档由 `db-provisioner` 注入 1。它**不许**被用来判断 desktop/docker/cloud —— 那是铁律 2 的红线。测试逐文件断言模板里搜不到 `NODE_ENV`/`TENON_*` |
| **`readiness` 从三格变四格（`deps`/`db`/`server`/`preview`）** | 新增的 `db` 格要同步到前端 `PreviewPanel` 的 `STAGES` / 进度宽度 / 四段文案，否则那一格永远灰着。改 `Readiness` 形状时 `scripts/e2e-preview.ts` 与 `scripts/e2e-fullstack.ts` 的断言都要跟（纯前端应用四格仍全 ready：`deps/db/server/preview`）；后端是否起来看 `apiPort`（纯前端应用必须 `null`，不该白起一个 Nest） |
| **日志端点 `/__tenon/log` 必须在网关层拦下，不转发上游** | 它是平台通道不是应用 API：转发给 Vite/Nest 只会得到 404（还污染应用自己的 4xx 统计）。`proxy.ts` 在路由分发**之前**匹配 `POST + LOG_PATH`，回 204。同理，新增这类"平台保留路径"时记得查一遍 `matches()` 的最长前缀逻辑 |
| **子进程输出必须先 `stripAnsi` 再进面板** | Vite/Nest 的输出带 `\u001B[32m` 这类颜色码，直接显示满屏 `[2m`。而且**同色相邻段**去掉码后可能产生首尾空格差异，去重（`repeat` 合并）要发生在剥离之后，否则同一句话被当两条 |
| **`LogStore` 合并后照样要推 SSE** | 去重容易顺手把"重复的那条"也吞了 —— 但合并是 `repeat++` 且 **id 不变**，前端按 id upsert 才能得到"一条 ×N"。吞掉的话界面上计数永远停在 1。`pushLog` = `store.add()` + 无条件 `publish` |
| **页面异常上报走同源相对路径，别加鉴权头** | 网关本身不校验 Token（它只在回环监听、生命周期跟预览走），上报用 `fetch('/__tenon/log', {keepalive:true})` 就够。想当然带上 `window.__TENON__.token` 反而把平台凭证引进了生成应用的代码 —— 违反"应用不感知平台"的方向 |
| **SSE 新增事件要过 `event-names.ts` 的穷尽闸门** | `SseEventNames` 是 `satisfies readonly SseEventType[]`，漏登记的类型检查直接红。但**别忘了** `apps/web` 的 `fences.test.ts` / reducer 的 switch 也要有对应 case —— TS 的 exhaustive 检查只覆盖有 discriminated union 的那几处 |
| **全局 `@Catch()` 过滤器接管了响应分发权** | 只记日志不写响应 = 请求永远挂着（前端只看到转圈，日志里一条异常，看起来"后端卡住"）。必须 `reply.status(status).send(body)` 把等价于 Nest 默认行为的响应补回去；单测断言 4xx/404/500 三种情况都要有响应 |
| **跨档迁移必须 `setval` 对齐序列** | 不做的后果最阴：迁移报告全绿、行数一致，用户第一次新建记录 → 主键冲突 500。`syncSequences()` 用 `max(col)` 推序列，用 TypeORM 真表跑一遍才能验到 |
| **`insert` 要排除生成列、`GENERATED ALWAYS AS IDENTITY` 要配 `OVERRIDING SYSTEM VALUE`** | 生成列写进去 → 报错；identity always 不给 overriding → 报"不能显式插入"。两者都按 `information_schema.columns` 的 `is_generated` / `identity_generation` 判断，别按列名猜 |
| **外键有环时不要"猜一个顺序"** | 猜错的代价是目标库留一半数据 + 中途报错，比一开始就失败难收拾。`orderTables()` 拓扑排序遇到环直接抛并列出环上的表；自引用（树形表）要显式跳过，否则每棵树都被判成环 |
| **迁移"只搬数据不搬结构"** | 结构由 migrations 在目标库生成（同一份 migration 两档同跑）。所以目标库缺表时**必须报错并指路**（"先让应用在目标档启动一次"），而不是悄悄把表建出来 —— 悄悄建表 = 两套 schema 事实来源 |
| **运行时 SDK 不能变成应用的 npm 依赖** | `@tenon/runtime` 没发布 npm，应用一旦 `import` 它，导出成 Docker 就装不上（铁律 2 的反面）。所以它是**源码分发**：`sync-templates.mjs` 拷贝 + `test/sync.test.ts` 逐字节拦截漂移。改源文件后别忘了跑同步脚本 |
| **跨模板共享的组件不能用模板的 css 类名** | 错误边界的降级 UI 一旦写 `className="card"`，两个模板就没法共用同一份代码（各自类名不同）。改成 inline style 才能字节级同步；错误态是兜底不是门面，朴素可接受 |
| **定位注入失效是"静默"的** | Babel 插件没挂上时页面照常打开、控制台干净、HMR 正常，只是点元素永远定位不到源码。所以 `pnpm e2e:preview` 里有一条硬断言：抓 `/src/App.tsx` 拿 Vite 吐的 JS，正则找 `data-tenon-loc": "src/App.tsx:行:列`。同理，这类"没生效但不报错"的机制必须有一条落在真实产物上的断言 |
| **Babel 的列号是 0 起，行号是 1 起** | `loc.start.column` 直接写进属性会整体左移一格（编辑器打开能看出来，代码里看不出来）。注入时 `column + 1`，测试里专门有一条盯这个 |
| **插件文件不能 import `@babel/core` 的类型** | 它要被拷进生成应用（源码分发），而模板刻意不装 `@babel/core`（`@vitejs/plugin-react` 自带 Babel），一 import 应用自己的 `tsc --noEmit` 就红。AST 形状在本地声明 + 运行时校验，一个 babel 包都不引；模板里传插件用 `as unknown as never[]` 过类型关 |
| **inspector 是动态 import 装上去的，比首屏晚几十毫秒** | `main.tsx` 用 `if (import.meta.env.DEV) void import('./tenon-inspector')`，生产构建才摇得掉。副作用：页面渲染出来之后还有一小段时间「按 Alt 没反应」。真实用户碰不到，**但 e2e 会** —— 所以 `e2e:inspector` 必须先轮询 overlay 节点数再点击，否则得到的是假失败（我第一次就栽在这儿，白查了半天） |
| **iframe 传 token 用 hash，不用 query** | query 会进网关与 dev server 的访问日志（等于把会话凭证写进日志）。hash 只在浏览器里存在。应用侧从 `location.hash` 读，`startsWith` 判断第一行即可 |
| **`postMessage` 的 targetOrigin 只能写 `*`** | 子页面在网关源、父窗口在平台源，子页面**不知道父窗口是谁**，写死就等于永远发不出去。所以防护全部落在父窗口侧：`event.origin` + `data.source` + `data.token` 三道，缺一不可（`apps/web/src/lib/selection.ts`，纯函数，16 项测试） |
| **`loc.file` 必须当成不可信输入** | 它会原样进 Agent 上下文。校验里明确拒掉绝对路径、`..`、盘符、反斜杠 —— 否则生成应用（用户和 Agent 都能改那份代码）发一条 `{loc:{file:"../../tenon.db"}}` 就等于给了一条"去读平台库"的指令注入 |
| **overlay 必须 `pointer-events: none`** | 否则鼠标永远命中高亮层，`event.target` 永远是 overlay，"什么都选不中"。同理，选中那一下要在 **capture 阶段** `preventDefault + stopPropagation`，否则生成应用自己的 onClick 会跟着触发（按钮提交表单、链接跳走） |
| **框选的元素上限要"先过滤再截断"** | `slice(0,50)` 写在过滤之前，塞几条垃圾进去就能把真元素挤掉。同理，框选只留**最内层**元素：把 `<main>` 这类容器交给 Agent 只会让它把改动面放大 |
| **`git.show` 不是 `git.diff`** | `git.diff(from)` 算的是"从 from 到 HEAD"的累积变化。版本列表里点第 3 条会显示第 3 条之后的所有改动，看起来像"这一轮改了 8 个文件"。看单条提交必须用 `showCommit`（内部取 `commit.parent[0]` 和它比）—— 有测试专门造了第三条提交来盯这件事 |
| **`''.split('\n')` 是 `['']`，不是空数组** | 新增/删除文件时缺失的那一侧不能传空串：会在全 `+` 的差异里混进一行 context，行号也整体错一格。传 `null`，内部换成 `[]` |
| **`git.resolveRef` 对 40 位 hex 不校验存在性** | 它原样返回，真正报错的是 `readCommit`（英文 "Could not find …"）。只 catch resolveRef 的话，用户传个瞎编的 sha 会拿到 `INTERNAL` 而不是 `GIT_DIFF_FAILED` |
| **改动面板必须覆盖，不能替换预览** | 替换 = iframe 卸载 = HMR 连接断开 + 预览回到空白，看完 diff 切回去等于重启一次。用 `absolute inset-0` 盖住，iframe 留在原地 |
| **Electron 的沙箱失败表现为"页面打不开"** | 被收窄的 shell 沙箱里 Chromium 报 `sandbox initialization failed: Operation not permitted` → network service 崩溃 → `loadURL` 直接 `ERR_FAILED (-2)`。文案里一个"沙箱"字都没有，第一反应会怀疑服务没起。e2e 里加 `--no-sandbox`（这条链路要验的东西全在渲染进程里，与进程隔离无关） |
| **`dumpDataDir()` 不是 `cp -r` 数据目录** | 前者是 PGlite 自己的 API，**运行中调用安全**（实测：库里开着未提交事务时打快照，还原后那行不在）；后者才是"必须先 stop 再拷"的那个坑 —— 热拷出来是半写状态，能起得来但表坏了。别把两条混成一条，否则会为了安全而白停一次库（2.4s） |
| **每轮都存库快照会塞满盘** | PGlite 一份 4~5MB，聊五十轮就是两百多兆，而只改样式的提交库里根本没变。判据是「这次提交改了 schema」（`api/migrations/**`、`*.entity.ts`、`shared/schema.ts`）。用**路径约定**，不要扫文件内容找 `CREATE TABLE` —— 要猜方言，还会被字符串字面量误伤 |
| **回滚的顺序必须是「检查 → 还原数据 → 回滚代码」** | 覆盖库**不可逆**，回滚代码**可逆**（再回滚一次就回来了）。顺序反了就会出现"库已被旧数据覆盖，然后发现这个提交根本没法回滚"。`e2e:diff` 有一条专门盯：带 `dbRestore` 但没有快照时，提交数不变、迁移文件还在 |
| **快照可能比目标更早，别假装精确** | 只有改过 schema 的提交才有快照。回滚第 N 版时父提交 N-1 若没改过 schema，只能往前退到最近一份 —— 中间那几轮写入的数据会一起丢。`skippedCommits` 就是量这个距离的，UI 必须如实说出来 |
| **快照按 commit sha 归档，不是时间戳** | `exports/db/<sha>/db.tar.gz`。时间戳命名就得再存一份"文件 ↔ 提交"的映射，两份迟早对不上，而错的那一次正好是用户最需要回滚的时候 |
| **`planRevert` 只往前看 200 条提交** | 沿祖先链找快照依赖 `git.log({depth:200})`。一个应用真到 200 轮以上时，更早的快照会"找不到"而不是"用错"（报 `DB_SNAPSHOT_MISSING`），这是有意选的方向：宁可说没有，不可悄悄退到一份对不上的状态 |
| **`git.writeObject` 传 string 会把对象写坏** | 传字符串进去，写出来的字节是乱的（实测 tag 对象解压后是一段二进制垃圾，`git fsck` 报 `object could not be parsed`），而且**没有报错**。内容一律 `Buffer.from(str, 'utf8')` 再传。commit / tree / blob 碰巧没炸，只有 tag 露了馅 —— 别因为"之前没事"就不转 |
| **isomorphic-git 的 `push` 只认 HTTP 传输** | 1.44 对本地路径（`/x/y.git` 或 `file://`）一样报 `requires a "http" parameter`。所以本地备份不能指望 `git.push`，`mirrorTo` 改成自己搬对象 + 写 ref（和真 push 传的东西一样，只是省了协商） |
| **裸库的 API 必须传 `gitdir`，不能传 `dir`** | `writeObject({dir: '/x/bare.git'})` 会去找 `/x/bare.git/.git/...`（不存在 → 静默什么都不写，`writeRef` 也一样）。裸库要 `gitdir: '/x/bare.git'`。这个坑不会报错，只会让你发现"写完了但啥也没有" |
| **备份库必须放在仓库外面** | 放进去会被 `commitAll` 一起提交，然后 `mirrorTo` 把备份库自己当内容搬进自己 —— 对象数会指数级膨胀（实测放了之后镜像一次写 16 个对象）。真实布局是 `~/.tenon/backups/<appId>.git` 与 `~/.tenon/apps/<appId>/repo` 平级，测试里也得照这个来 |
| **`app.create` 自带一个初始提交** | 「chore: 初始化应用」。所以"仓库里没有提交"这个分支没法用新建应用造出来，测试里要先删 `.git` 再 `initRepo` 造空仓库 —— 否则会以为那条闸门失效了 |
| **发布失败要把刚打的 tag 删掉** | 否则留下"有 tag、没记录"的半成品：下次 `nextVersion` 看到 tag 就算出 `-2`，用户会以为少发了一版。`publishRelease` 在 `mirrorTo` 失败时 `deleteTag` 再抛 `RELEASE_FAILED` |
| **`.gitignore` 里的 `release/` 会让 Tailwind 扫不到 `features/release/`** | Tailwind v4 的自动内容扫描**跳过 `.gitignore` 命中的路径**。`release/` 本意是 electron-builder 的产物目录，但它把 `apps/web/src/features/release/` 也一起盖住了 → 新写的类名（`max-w-lg`、`min-h-[76px]`、`bg-ok/5`）**不生成 CSS**，界面上只有"这一处新样式失效"，别处全正常，查起来像见鬼。已改成精确路径 `/apps/desktop/release/`。判断办法：`grep 类名 apps/web/dist/assets/*.css` |


---

## 6. 环境

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node | `>= 22.19`（pi 硬要求，主因 `node:sqlite`）| v22.22.2 ✅ |
| pnpm | 9.x | 9.15.9 ✅ |
| git | 任意（isomorphic-git 是纯 JS，系统 git 可选）| 2.39.5 ✅ |

日常入口（在仓库根目录）：

```bash
pnpm dev:web               # ★ 日常开工：server + 前端一起起，浏览器开 127.0.0.1:5173
pnpm dev:desktop           # ★ 桌面版：build:web + 打 server 单文件 → 起 Electron（约 6s）
pnpm dev:faux              # 只起 server（TENON_FAUX=1），打印 TENON_READY {url,port,token,home,model}
pnpm dev:server            # 同上但用真实模型（需要先配 provider，否则 health 的 model 为 null）
pnpm test                  # vitest：31 个测试文件（277 项，含迁移、runtime-sdk、定位、点选校验、diff 折叠、快照触发判据、库快照还原、版本号与发布）
pnpm smoke                 # 端到端：spawn bin.ts → health → 建应用 → SSE → 历史 → git
pnpm e2e:preview           # 真机预览链路（要联网装 React）：模板 → dev server → 网关 → HMR
pnpm e2e:fullstack         # ★ 真机全栈链路（要联网装 Nest）：PGlite → 迁移 → 双进程 → CRUD → 重启
pnpm e2e:diff              # ★ 改动/回滚：git.log / show / revert 全走真 HTTP
pnpm e2e:release           # ★ 发布：打 tag + 推本地裸库，用系统 git 验 fsck / clone
pnpm build:web             # 前端产物
pnpm build:desktop         # 桌面产物：dist/{main.mjs,server,web,templates} + server/node_modules
pnpm pack:desktop          # electron-builder --dir → apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop         # 桌面冒烟（开发态）：真起 Electron，8 项断言
pnpm smoke:desktop:packaged # 同上，但跑打包后的 Tenon.app
pnpm typecheck             # 8 个 packages + 2 个 apps + 4 个 spikes + scripts（15 个项目）

# 模板里的副本从 runtime-sdk 同步（改了 src/browser 或 src/nest 之后）
node packages/runtime-sdk/scripts/sync-templates.mjs          # 写入
node packages/runtime-sdk/scripts/sync-templates.mjs --check  # 只校验（测试也在验）
```

spike 复跑入口（历史证据，仍在）：

```bash
pnpm spike:db       # PGlite + TypeORM 压测（含正确性探针）→ spikes/db/results/spike-db.json
pnpm spike:agent    # pi-durable 闭环 + 崩溃续跑            → spikes/agent/results/spike-agent.json
pnpm spike:gateway  # 网关 HMR 代理
pnpm spike:loc      # 定位插件精度
```

服务端环境变量：`TENON_HOME`（数据目录，默认 `~/.tenon`；桌面版默认 `<userData>/home`）、
`TENON_PORT`（0=随机）、`TENON_HOST`、`TENON_TOKEN`、`TENON_FAUX=1`（假模型）、`TENON_LOG=1`（pino）、
`TENON_WEB_DIR`（给了就同源托管这份渲染器产物）、`TENON_TEMPLATES_DIR`（模板目录）、`TENON_PNPM`（装依赖用的包管理器）、
`TENON_DB_MODE=postgres` + `TENON_DATABASE_URL`（把应用库从 PGlite 切到真 PG；不设就是 `pglite`）。

注入给**生成应用**的只有两个：`DATABASE_URL`（唯一入口，铁律 2）与 `DATABASE_POOL_MAX`（容量参数，PGlite 档恒为 1）。

跨档迁移走 `DatabaseManager.migrate(appId, { mode: 'postgres', connectionString })`：
源是应用当前在用的库，目标是临时起的（迁完就关）。**目标库必须已经跑过 migrations**（先让应用在目标档启动一次），
迁移只搬数据不搬结构。

> 桌面版冒烟在**受限环境**（容器 / 无 GPU / 从 IDE 里跑）需要 `--no-sandbox --disable-gpu`，
> `scripts/smoke-desktop.ts` 已经代劳；产品本身不传这两个开关。

> **本机 shell 注入了 `NODE_OPTIONS=--require=…/node-language-shim.cjs`**（宿主的文件系统代理 + 安全删除守卫）。
> 它会让**写文件密集**的用例慢 10 倍以上：`packages/db-provisioner` 单独跑从 9.7s 变成 250s+，
> 4 个 PGlite 用例全部撞 30s 超时（看着像代码坏了，其实是环境）。
> 在本机跑测试/打包请用：
>
> ```bash
> env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE pnpm test    # 约 1 分钟；不带的话可能 8 分钟起且随机超时
> env -u NODE_OPTIONS pnpm pack:desktop                    # 否则 electron-builder 解压报 Brokered file token refused
> ```
>
> 这不是产品问题：干净环境下 `pnpm test` 就是 ~55s / 128 项全绿。

> `spikes/*/pgdata*`、`spikes/*/work/` 是运行产物，已 gitignore；`results/*.json` 保留入库作为证据。

---

## 7. 新会话开场提示词（可直接粘贴）

```
继续 Tenon（榫）项目，路径 /Users/mac/project/miaoda。

先读 docs/STATUS.md（现状、下一步、陷阱），再读 docs/SPIKES.md（四个 spike 的实测结论，
尤其 §1 的 pool.max=1 硬约束）。涉及架构再查 docs/DESIGN.md（唯一事实来源 v1.2.14），
写 pi 相关代码前必查 docs/PI-CHEATSHEET.md。

当前阶段：**M3 已收口**（源码定位注入 → Alt+Click 反查 → 框选 → Diff 视图 → 代码回滚 → 数据回滚 →
发布 push）。下一步是 M4，先看 §4.8 的"没做的"清单再决定从哪块进。
277 个测试 + smoke 9 + e2e:preview 16 + e2e:inspector 13 + e2e:diff 36 + e2e:release 32 + e2e:fullstack + 桌面包全绿。
**欠账三笔**：① M2 的 Docker compose 产物（阻塞：本机无容器运行时，没有验证就不写 Dockerfile）；
② `postgres` 档的库快照仍依赖 `pg_dump`（缺二进制报 `DB_UNSUPPORTED`，发布档应走云厂商 PITR）；
③ 发布只推得动本地备份库，真远端（GitHub 等）要凭据 + 真网络，没验证所以没接。
`pnpm test` / `pnpm smoke` 要一直保持绿；动到预览链路跑 `pnpm e2e:preview`，动到库/模板跑 `pnpm e2e:fullstack`，
动到 git / 回滚跑 `pnpm e2e:diff`，动到发布跑 `pnpm e2e:release`。

三条铁律不要违反：Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 + adapter 包装。
（「安装包零原生模块」**不在**这三条里 —— v1.2.13 起已降为偏好，别再拿它当硬约束挡需求。）
```
