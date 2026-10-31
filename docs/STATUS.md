# STATUS.md — 当前状态与下一步

> **用途：新会话 / 新协作者的唯一入口。读完这一页即可开工，不必先读完整 `DESIGN.md`。**
> 最后更新：2026-10-31（**M1 全部 9 步 + M2 第 1 步落地**：105 个测试 + 9 项端到端冒烟 + 14 项预览 e2e +
> 全栈 e2e + 8 项桌面冒烟全绿；`pnpm dev:web`、`pnpm e2e:fullstack` 与打包后的 `Tenon.app` 都实测走通）

---

## 0. 一句话现状

**生成的应用现在有后端了：一句话建出来的应用自带 NestJS + PostgreSQL（默认 PGlite 零安装），
前端一个 `fetch('/api/health')` 就能打通，切换成真 PG 只改 `DATABASE_URL`，应用代码零改动。**

M1 已经全部落地（一条命令起界面、对话里改代码、iframe 当场热更新、能打成 `Tenon.app` 双击运行）；
M2 第 1 步把「只有页面」变成「有库、有接口、能 CRUD」。

先跑这几条验证它还活着：

```bash
pnpm install && pnpm dev:web    # ★ 一条命令起界面：server + 前端，浏览器打开 http://127.0.0.1:5173
pnpm dev:desktop                # ★ 桌面版（同一份 server，Electron 只当壳）
pnpm test                       # 105 项单测 + 集成测试（约 60s）
pnpm smoke                      # 9 项端到端（真 spawn 进程，走 HTTP + SSE）
pnpm e2e:preview                # 14 项真机全链路：建应用 → 装依赖 → 起 Vite → 经网关打开 → 改文件 → HMR（要联网）
pnpm e2e:fullstack              # ★ 全栈真机链路：PGlite 起库 → 迁移 → Vite+Nest 双进程 → CRUD 经网关 → 重启后数据还在
pnpm pack:desktop               # 打包成 apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop:packaged     # 8 项桌面冒烟：真的起 .app、加载界面、退出后不留孤儿进程
```

- `packages/{protocol,core,agent,server,generator,gateway,db-provisioner}` 七个包已建；`pnpm typecheck` 全绿（14 个项目）
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
  `pnpm pack:desktop` 出 `Tenon.app`（338MB，**零原生模块**），打包冒烟实测：窗口出界面 → 退出后子进程收干净
- **★ M2 第 1 步（应用有后端了）**：
  - `packages/db-provisioner`：`DatabaseProvider { start/stop/connectionString/dump/restore }`，
    `pglite` 档（默认，零安装）与 `postgres` 档（发布，Docker/外部/云）同接口；**`poolMax()` 恒为 1**
  - `templates/nest-api`：NestJS 11 + TypeORM + PG 方言 + zod 共享层；**迁移只写一份，两档同跑**
  - `preview.start` 从 1 个进程变 2 个（Vite + Nest），网关按最长前缀分流：`/api/*` → Nest，其余 → Vite
  - 生成应用只认 **`DATABASE_URL`**（+ `DATABASE_POOL_MAX` 这个容量参数），不判断任何运行环境
  - 桌面版不再依赖系统 `pnpm`：安装包自带（`Resources/server/node_modules/pnpm`）
- **M2 剩余**：runtime SDK、日志/错误面板、`pg_dump` 跨档迁移到 Docker PG、Docker compose 产物

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
| `docs/DESIGN.md` | **唯一事实来源**，v1.2.7，1700+ 行 | 写涉及架构的代码前，按需读对应章节 |
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
`data-tenon-loc` 的编译期注入按计划留到 M3 —— 它是编译期插件，对已存在的应用补上不产生任何返工，不急。

**M2 全栈生成**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **两档数据库供给**：`DatabaseProvider` 接口 + `pglite`/`postgres` 两档 + 按 appId 缓存 | ✅ | `packages/db-provisioner/src/{types,pglite,postgres,manager}.ts` |
| 2 | **全栈模板**：NestJS 11 + TypeORM + PG 方言 + zod 共享层，迁移只写一份 | ✅ | `packages/generator/templates/nest-api/` |
| 3 | **双进程预览**：Vite + Nest，网关按 `/api/*` 最长前缀分流，三端口先占后告诉 | ✅ | `packages/gateway/src/{api,child,preview}.ts` |
| 4 | **全栈端到端**：建应用 → 起库 → 迁移 → 双进程就绪 → CRUD 经网关 → 重启数据还在 | ✅ | `scripts/e2e-fullstack.ts` |
| 5 | 桌面版自带包管理器（不再依赖系统 `pnpm`） | ✅ | `packages/gateway/src/deps.ts` + `apps/desktop/{build.mjs,electron-builder.yml}` |
| 6 | runtime SDK（生成应用侧的 `@tenon/runtime`）+ 日志/错误面板 | ⬜ 下一步 | 待建 `packages/runtime-sdk`、`apps/web/src/features/logs` |
| 7 | 跨档迁移：`pg_dump` → Docker PG，数据零丢失 | ⬜ | `packages/db-provisioner` + 发布流程 |
| 8 | Docker compose 产物（多阶段 + `postgres:18-alpine`） | ⬜ | 模板 `Dockerfile` / `compose.yml` |

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
      不落错误页、退出后 server 真的停了（端口没人听）。安装包内**零原生模块**（`build.mjs` 扫 `dist/` 兜底）

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

### 4.5 下一步具体做什么（M2 第 2 步：让它可观测 + 可发布）

第 1 步解决的是「能不能起来」。第 2 步解决的是「**起不来/出错了看不看得见**」和「**能不能搬去生产**」：

1. **`packages/runtime-sdk`（生成应用侧）**：`templates/nest-api` 与前端各引一个薄壳，
   把 `console`/未捕获异常/HTTP 5xx 规范化后推到 `POST /api/__tenon/log`。
   **注意别踩铁律 2**：SDK 只认一个 `TENON_APP_ID` 之类的标识，不判断 desktop/web/cloud。
2. **日志与错误面板**：`packages/server` 侧收拢上面那条链 + 两个子进程的 stdout（`spawnLogged` 已有 200 行环形缓冲），
   经 SSE 推给 `apps/web`；界面加一个可折叠的底栏（现在只有 `PreviewPanel` 的四格进度）。
   验收：在 `repo/src/App.tsx` 里 `throw` → 面板里出现这条错误和它的堆栈。
3. **跨档迁移**：`DatabaseManager` 已有 `dump()`，但 `pglite → postgres` 的**逻辑导出**还没实测
   （spike 只验了 PGlite 内部快照）。要做的是一条命令：`pglite` 档 `pg_dump --format=custom` →
   `postgres` 档 `pg_restore`，然后用同一批 `GET /api/items` 断言数据零丢失。这是 DESIGN §17 的 DoD ③。
4. **Docker compose 产物**：模板里加 `Dockerfile`（多阶段）+ `compose.yml`（自带 `postgres:18-alpine`），
   构建并跑起来 —— DoD ④。这步同时验证"生成应用真的不感知运行环境"。

> 顺序建议：先 1+2（没有它，3 和 4 出问题只能靠猜），再 3，最后 4。

### 4.6 代码地图（只列已落地的）

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
├── generator/           # 模板铺进 repo（DESIGN §8.7）
│   ├── src/scaffold.ts  #   scaffoldApp：渲染模板 → 写文件；已有 package.json 就拒绝
│   ├── src/registry.ts  #   读 templates/<id>/template.json，递归收集文件
│   ├── src/render.ts    #   只做 {{ident}} 替换；渲染后残留占位符直接抛错
│   └── templates/
│       ├── react-vite/  #   纯前端（默认）：Vite + React 19，一条命令 dev
│       ├── nest-api/    # ★ 全栈（M2）：Vite + NestJS 11 + TypeORM + zod 共享层
│       │   ├── api/     #   main / app.module / db(dataSourceOptions) / migrations / items
│       │   ├── shared/  #   schema.ts：zod 契约，前后端同一份
│       │   └── tsconfig.server.json  # ★ 必须 CommonJS + emitDecoratorMetadata（Nest DI 要）
│       └── blank/       #   空壳（entry=null，不自动起预览）
├── db-provisioner/      # ★ 应用数据库供给（M2，DESIGN §6.4）
│   ├── src/types.ts     #   DatabaseProvider 接口；文件头写明 poolMax 恒 1 与未就绪抛错
│   ├── src/pglite.ts    #   PgliteProvider：pg-gateway 起真 PG 协议端 + dumpDataDir 快照
│   ├── src/postgres.ts  #   PostgresProvider：只探活；dump/restore 走 pg_dump/pg_restore
│   ├── src/manager.ts   #   DatabaseManager：按 appId 缓存（只 stop 不丢 → 端口不变）
│   └── src/index.ts
├── gateway/             # 预览编排（DESIGN §9.1）
│   ├── src/proxy.ts     #   HTTP 转发 + upgrade 原样透传（两侧 socket 必须配对销毁）
│   ├── src/preview.ts   #   PreviewManager：deps → 端口 → 网关 → db → vite → api → 并行探活
│   ├── src/deps.ts      #   pnpm install（--prefer-offline，全有超时，失败带最后 20 行）
│   ├── src/vite.ts      #   spawn(process.execPath, [viteBin])：不依赖 PATH 里有 pnpm
│   ├── src/api.ts       # ★ 后端半边：resolveApiEntry + tsc --watch → 等产出 → node --watch
│   ├── src/child.ts     # ★ spawnLogged（200 行环形日志、SIGTERM→4s→SIGKILL）/ groupLaunched / nodeRunEnv
│   └── src/ports.ts     #   先定端口再 strictPort，绝不让 dev server 自己换端口
└── server/              # 只做「挂到 HTTP 上」
    ├── src/app.ts       #   Fastify 装配 / RPC 路由 / SSE / 错误处理
    ├── src/auth.ts      #   Bearer（/api/health 免 Token）
    ├── src/cors.ts      #   只放行回环 origin；预检必须排在鉴权**之前**
    ├── src/handlers.ts  #   `satisfies HandlerMap` → 漏实现编译期就报错
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
├── e2e-preview.ts       # 14 项真机断言（含 HMR 经网关的真实推送）
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
pnpm test                  # vitest：9 个 packages/apps + 4 个 spikes（105 项）
pnpm smoke                 # 端到端：spawn bin.ts → health → 建应用 → SSE → 历史 → git
pnpm e2e:preview           # 真机预览链路（要联网装 React）：模板 → dev server → 网关 → HMR
pnpm e2e:fullstack         # ★ 真机全栈链路（要联网装 Nest）：PGlite → 迁移 → 双进程 → CRUD → 重启
pnpm build:web             # 前端产物
pnpm build:desktop         # 桌面产物：dist/{main.mjs,server,web,templates} + server/node_modules
pnpm pack:desktop          # electron-builder --dir → apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop         # 桌面冒烟（开发态）：真起 Electron，8 项断言
pnpm smoke:desktop:packaged # 同上，但跑打包后的 Tenon.app
pnpm typecheck             # 7 个 packages + 2 个 apps + 4 个 spikes + scripts（14 个项目）
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
> 这不是产品问题：干净环境下 `pnpm test` 就是 ~60s / 105 项全绿。

> `spikes/*/pgdata*`、`spikes/*/work/` 是运行产物，已 gitignore；`results/*.json` 保留入库作为证据。

---

## 7. 新会话开场提示词（可直接粘贴）

```
继续 Tenon（榫）项目，路径 /Users/mac/project/miaoda。

先读 docs/STATUS.md（现状、下一步、陷阱），再读 docs/SPIKES.md（四个 spike 的实测结论，
尤其 §1 的 pool.max=1 硬约束）。涉及架构再查 docs/DESIGN.md（唯一事实来源 v1.2.7），
写 pi 相关代码前必查 docs/PI-CHEATSHEET.md。

当前阶段：M2 全栈生成。第 1 步已完成（packages/db-provisioner + templates/nest-api + 双进程预览，
105 个测试 + smoke 9 + e2e:preview 14 + e2e:fullstack + 桌面包全绿）。
接着做 STATUS.md §4.5：runtime SDK + 日志/错误面板 → pg_dump 跨档迁移 → Docker compose 产物。
`pnpm test` / `pnpm smoke` 要一直保持绿；动到预览链路跑 `pnpm e2e:preview`，动到库/后端跑 `pnpm e2e:fullstack`。

三条铁律不要违反：Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 + adapter 包装。
```
