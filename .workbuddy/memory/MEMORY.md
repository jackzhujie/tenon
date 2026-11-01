# 项目长期记忆 — Tenon（榫）

## 一句话
开源复刻飞书妙搭：**本地优先、可自托管的对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。
与字节/飞书无关，已避开「妙搭/Miaoda/飞书」。产品名 **Tenon（榫）**，代号 `tenon`，作用域 `@tenon/*`。
隐喻：榫卯不用钉子靠构件咬合 = 应用由标准组件咬合，Agent 只做设计与搭接。
⚠️ `LM Studio` 是第三方产品名，全局改名时必须保护。

## 当前状态（2026-11-01）
**M1 全部 9 步 + M2 第 1~3 步完成（Docker 产物除外）** → DESIGN **v1.2.9**。八个包 + 两个 app（`apps/web` 渲染器、`apps/desktop` 壳）。
服务能起、能对话（SSE 流式）、能落库、每轮自动 git 提交、崩溃后续跑；
Agent 有 read/write/edit/bash 四个工具，写完的文件进得了这一轮的 commit；
`pnpm dev:web` 一条命令起界面，改 `repo/src/App.tsx` → iframe 当场变（HMR 经网关）；
**`pnpm pack:desktop` 出 `Tenon.app`（338MB、零原生模块、自带 pnpm），打包冒烟 8 项全过**。
**M2-1：生成的应用有后端了** —— `packages/db-provisioner`（pglite 默认 / postgres 发布，`poolMax()` 恒 1）+
`templates/nest-api`（NestJS 11 + TypeORM + PG 方言 + zod 共享层，**迁移只写一份两档同跑**）+
`preview.start` 双进程（网关按 `/api` 最长前缀分流）；应用侧只认 `DATABASE_URL`（+ 容量参数 `DATABASE_POOL_MAX`）。
**M2-2：可观测了** —— `gateway/src/logs.ts` 的 `LogStore` 三来源汇流（子进程行钩子 / 页面经
`POST /__tenon/log` 网关拦截不上传 / 平台节点），`app.log` SSE + `logs.list|clear` RPC，
模板侧上报（`tenon-log.ts` + `tenon-boundary.tsx`），`apps/web` 有 `LogPanel` 底栏；
日志跟应用走不跟预览跑（停预览缓冲还在）；堆栈续行并进上一条 `detail`。
**M2-3：能发布了** —— `packages/runtime-sdk`（`@tenon/runtime`）**源码分发**：`sync-templates.mjs` 拷进两模板，
漂移测试逐字节拦；含 Nest 全局 `TenonLoggerFilter`（5xx 摘要+堆栈 / 4xx 一行 warn / 必须补响应）。
跨档迁移 `migrateDatabase()` **纯 JS 逻辑拷贝**（v1.2.9 废弃 `pg_dump` 方案）：外键拓扑排序 / 生成列排除 /
`OVERRIDING SYSTEM VALUE` / `setval` 对齐序列 / 逐表 `count(*)` 校验，零二进制依赖。
`pnpm typecheck` 15 project + `pnpm test` **159 项** + `smoke` 9 + `e2e:preview` 14 + `e2e:fullstack`（含日志与 Nest 过滤器断言）+ `smoke:desktop(:packaged)` 8 全绿。
**M2 只剩 Docker compose 产物** —— ⛔ 阻塞：本机无 docker/podman/colima（`which` 全 not found）。
没有验证就不产出 Dockerfile（不想假收口）。有容器运行时后按 STATUS §4.7 补；或直接进 M3。
**开工入口：`docs/STATUS.md`**（§4.2 进度表 / §4.4~4.6 各步 DoD / §4.7 下一步 / §4.8 代码地图 / §5 陷阱）；方案：`docs/DESIGN.md`。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成的应用永不感知运行环境**，只认一个 `DATABASE_URL`
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## spike 撞出来的硬约束（v1.2.1，违反会静默坏数据）
- **`pglite` 档 TypeORM `pool.max` 必须 = 1**：PGlite 只有一个 backend 会话，`pool>1` 时两条连接的事务串到一个 backend，一条 `ROLLBACK` 会抹掉另一条已写入的行（实测丢行）。pool=2 只有 19% p95 收益，不值得
- **LISTEN/NOTIFY 不可用**（实测 0 条通知）→ 后端推前端只走网关 SSE
- **`harness.resume()` 每个进程启动必调**，否则崩溃中断的任务不继续
- **源码定位双属性**：原生标签 `data-tenon-loc`、组合组件 `data-tenon-callsite`（需组件透传 `{...props}`）；点击时 callsite 优先
- 成本：PGlite 冷启动 2.4s、每应用 pgdata 38MB、dumpDataDir 约 4.5MB/0.7s
- 无 API Key 也能开发：`pi-ai` 的 `providers/faux`（`fauxProvider()` + `fauxAssistantMessage()`）

## M1 落地时撞出来的硬约束（v1.2.2，比 spike 更贵）
- **不能用 `git.statusMatrix` 判断变更**：isomorphic-git 的 stat 快路径会把**同长度同毫秒**的改动判成"没变"（`v1\n`→`v2\n` 返回 `[1,1,1]`，`WORKDIR.oid()` 也返回旧值）→ `commitAll` 自算 blob oid + `add({force:true})`，**别改回去**
- **`pi.live` 没有 token 增量**（只有 `{run,generation:{attempt}}`）→ 流式只能走 `watchEvents` 的 `message_update.changes[].type==='text_delta'`
- **`message_end` 对用户 entry 也触发** → 只推 `role==='assistant'` 的 `message.end`
- **SSE 必须"先连上再提交"**（建连即写 `: connected`），与 Vite HMR 首帧同一个坑
- **`defineDoc<T>` 的 T 必须用 `type` alias**（interface 拿不到隐式索引签名，`JsonObject` 约束会挂）
- **BYOK 密钥不能进 `process.env`**（生成应用子进程会继承）→ `createProvider` + `@earendil-works/pi-ai/api/openai-completions` 的 `stream/streamSimple` 现场拼 provider

## 工具层硬约束（v1.2.3）
- **`pi-coding-agent` 的工具签名 ≠ `pi-durable` 的**：`execute(toolCallId, params, signal, onUpdate, ctx)→AgentToolResult` vs `execute(args, api, context)→ToolExecutionResult` → 必须过 adapter（`packages/agent/src/tools/coding.ts`）
- **`edit` 入参是 `edits:[{oldText,newText}]`**（不是 old_string/new_string）
- **`section()` 的 key 只允许 `/^[a-z][a-z0-9_-]*$/`**，点号会让每轮 submit 抛 `INTERNAL`
- **状态变化必须同时落库 + 推 `app.status`**，否则前端不知道这一轮结束；且**先 commit 再发 idle**
- **submission settle 回调可能晚于 `close()`** → db 已关 → 必须 `closed` 门 + try/catch（否则"全绿但有 unhandled rejection"）
- **集成测试闸门等 `app.status: idle`**，不能等 `git.commit`（无改动就没有提交）
- 未做系统调用级沙箱：文件路径守卫 + bash cwd 钉死 + `scrubEnv` 洗密钥，够了就先用（完备版是 M7）

## 生成器与预览硬约束（v1.2.4）
- **模板是真实文件**（`packages/generator/templates/<id>/`），不是 TS 字符串常量；发布要 `extraResources` 或 `TENON_TEMPLATES_DIR`
- **渲染只做 `{{ident}}`，残留占位符必须抛错**（否则界面出现字面 `{{appName}}`）；`template.json.variables` 由测试逐文件核对
- **铺模板在 `initRepo` 之前** → 建应用只有一个 commit
- **core 不依赖 generator**：走 `AppStore.create` 的 `scaffold` 钩子注入（否则 generator→core 成环）
- **upgrade 透传后两侧 socket 必须成对销毁**：漏了只漏水不报错，Vite 每次整页刷权重连一次 HMR；症状是 `server.close()` 永不回调
- **`StartServerOptions.env` 是覆盖对象**，当子进程 env 用会抹掉 `PATH` → `pnpm install` 以 `code=null` 失败
- **先定端口再 `strictPort`**：让 dev server 自己换端口 = 网关指空气 + iframe 白屏无报错
- **`@vitejs/plugin-react` 6.x 的 peer 是 `vite@^8`**：模板用 vite 7 必须配 5.x
- **`preview.start` 立刻返回 `starting`**，进度靠 SSE `preview.status`，就绪发 `preview.ready`（别在 RPC 里等安装）

## 渲染器硬约束（v1.2.5，`apps/web` 实测）
- **`startGateway` 必须显式传 `port`**：端口是「先占后告诉」的（`findFreePorts` → `TENON_GATEWAY_PORT` → 模板的 `server.hmr.clientPort`）。网关自己随机挑一个，浏览器就被指去没人监听的端口 → **页面照常打开、日志干净，只有 HMR 永远不来**。断言必须是「`url` 的端口 === `gatewayPort`」，用 `url` 连 WS 是自证
- **`.bin/<cli>` 是 shell 包装**，`node .bin/tsx` → `SyntaxError`；要读 `package.json.bin` 拿 `.js/.mjs` 入口再交给 node
- **浏览器只 import `@tenon/protocol/browser`**（零依赖子路径）：主入口的 `z.object` 在模块顶层求值，rollup tree-shake 不掉，实测 356KB → 256KB
- **`TRANSPORT` 是路径与头名的唯一来源**：server 的 `app.ts`/`auth.ts`/`cors.ts` 不许再手写 `'/rpc/'`、`authorization`
- **flex 子项少了 `flex-1` 会静默塌成 0 高**（DOM 里文字都在，界面上什么都没有）
- **默认模板取 `react-vite` 不取 `templates[0]`**（`blank` 排第一但建完跑不起来）；`entry === null` 的模板不自动起预览
- **`select` / `booted` 都要从 apps 里取回 `status`**，只置 null 会一直显示「准备中」
- **CORS 预检必须排在鉴权之前**（OPTIONS 不带 Authorization）；SSE `reply.hijack()` 后要手写 `corsHeaderRecord`

## 桌面壳硬约束（v1.2.6，Electron 实测）
- **环境里的 `ELECTRON_RUN_AS_NODE` 会让 `electron .` 变成 node**：症状是 `import { app } from 'electron'` 报 `does not provide an export named 'BrowserWindow'`（像"不支持 ESM"，其实支持）。从 IDE/其他 Electron 应用启动脚本会自带它 → 启动前必须删（`apps/desktop/scripts/launch.mjs`），`scrubEnv` 也剥掉
- **esbuild 打 ESM 单文件必须 `banner: createRequire(import.meta.url)`**（isomorphic-git 依赖链里有 CJS），否则 `Dynamic require of "buffer" is not supported`
- **打包后 `process.execPath` 是 Tenon 自己**：spawn server 必须带 `ELECTRON_RUN_AS_NODE=1`；Electron 39 内置 node 22.22.1，`node:sqlite` 可用，不必再塞 node
- **`templates` 必须是 bundle 的兄弟目录**：`registry.ts` 按 `import.meta.url` 找 `../templates` → `dist/templates`（打包后 `Resources/templates`）
- **页面由 server 同源托管并在 index.html 注入 `__TENON__` + CSP**：不用 preload、不用 `file://`。页面/assets 免 Token，`/rpc/*`、`/events`、`/api/*` 要 Token（白名单方向）
- **SPA 回落不能对 `/assets/*.js` 生效**（回落成 HTML 只有 `SyntaxError`）；**index.html 必须 `no-cache`**（它携带 token）
- **冒烟要在页面内断言 `window.__TENON__.token`**，不要在外部 fetch index.html（探针打印后进程就退出，是竞态）
- 受限环境（容器/无 GPU）起 Chromium 要 `--no-sandbox --disable-gpu`，只给冒烟脚本

## 全栈后端硬约束（v1.2.7，M2 第 1 步实测）
- **Node ≥ 22.18 的原生 TS 类型擦除让 `ts-node/register` 彻底失效**：`.ts` 入口被 Node 自己的 ESM loader 抢走，`require.extensions['.ts']` 注册了也不参与，`--no-experimental-strip-types` 也救不了。→ 模板走 **`tsc --watch` 编译到 `dist-server/` + `node --watch` 跑 `.js`**（Nest DI 本来就要 `emitDecoratorMetadata`，tsx/esbuild 不产）
- **`node --watch` 只监听"已经加载过"的文件**：入口还不存在时它打印 `Failed running … Waiting for file changes` 然后永不重启 → `launchApi` 必须 `await waitForFile(output, compiler, 90s)` 再起 runner
- **子进程报错要带多行尾部**：`node --watch` 把真错误放在 `Failed running …` 的**上一行** → `tailOf(launched, 6)` 而不是 `lastLine()`
- **PGlite 必须 esbuild external 并整包拷进安装包**：它按 `import.meta.url` 读 `wasm/`/`data/`/`extensions/`，打进单文件就起不来
- **electron-builder 的 `extraResources` 会跳过相对路径含 `node_modules` 的文件**：`filter: ['**/*']` 也无效 → 必须单列 `from: dist/server/node_modules`
- **pnpm 自带 4 个平台 `reflink.*.node`**：会触发"有原生模块"的兜底断言；删掉后 `pnpm install` 实测照常
- **`DATABASE_POOL_MAX` 是容量参数不是环境判断**：只用于 `extra.max`（PGlite 档由 provisioner 注入 1）；不许用来判断 desktop/docker/cloud（铁律 2）
- **`readiness` 是四格 `deps/db/server/preview`**（不是 `api`）；后端起没起看 `apiPort`，纯前端应用必须 `null`
- **本机跑测试要 `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`**：注入的 `node-language-shim` 让写文件密集用例慢 10 倍 → PGlite 用例全撞 30s 超时（看着像代码坏了）

## 日志链路硬约束（v1.2.8，M2 第 2 步实测）
- **`POST /__tenon/log` 必须在网关层路由分发之前拦下**，回 204、不转发上游（它是平台通道不是应用 API；转发只会 404 + 污染应用 4xx 统计）
- **子进程输出先 `stripAnsi` 再去重**：Vite/Nest 的颜色码（`\u001B[32m`）会让同句去重失效、界面满屏 `[2m`
- **`LogStore` 合并后照样推 SSE**：去重是 `repeat++` 且 id 不变，前端按 id upsert 才是"一条 ×N"；把重复那条吞掉 = 计数永远停在 1
- **日志跟应用走不跟预览跑**：停预览缓冲还在（用户回看刚才的报错是主场景）；`app.delete` 才 `forget()`
- **tsc 编译报错归 `api` 来源**（它同样意味着"后端起不来"），别单独开 `tsc` 来源
- **页面上报不带任何平台凭证**：同源相对路径 + `keepalive` 就够；往上报里塞 `window.__TENON__.token` 是把平台凭证引进生成应用（违反铁律 2 方向）
- **SSE 新增事件三处要同步**：`events.ts` 的 union、`event-names.ts`（穷尽闸门）、前端 reducer 的 case（TS exhaustive 只盖有 discriminated union 的地方）

## 发布与迁移硬约束（v1.2.9，M2 第 3 步实测）
- **跨档迁移不用 `pg_dump`/`pg_restore`**：用户机器上没有（本机也没有）。`migrate.ts` 走纯 JS —— 两端 PG 协议连接 + 普通 SQL，零二进制依赖
- **迁移必须 `setval` 对齐序列**：不做的话迁移全绿、行数一致，用户第一次新建就主键冲突 500（最阴的坑）
- **`insert` 排除生成列（`is_generated='ALWAYS'`），`GENERATED ALWAYS AS IDENTITY` 要 `OVERRIDING SYSTEM VALUE`**：都按 `information_schema.columns` 判断，别按列名猜
- **外键有环别猜顺序**：拓扑排序遇环直接抛（猜错会在目标库留一半数据）；自引用外键要显式跳过
- **迁移只搬数据不搬结构**：结构由 migrations 在目标库生成；目标缺表时**报错并指路**，不偷偷建表（否则两套 schema 事实来源）
- **全局 `@Catch()` 过滤器接管响应分发权**：只记日志不写响应 = 请求永远挂着。必须 `reply.status().send()` 补回去
- **`@tenon/runtime` 不能变成生成应用的 npm 依赖**（没发布 npm，导出 Docker 就装不上）→ **源码分发** + `sync-templates.mjs` + 逐字节漂移测试
- **跨模板共享的组件不能用模板 css 类名**：错误边界降级 UI 用 inline style，才能两模板字节级共用
- **本机无 Docker/pg_dump**（2026-11-01 实测）：Docker compose 产物（DoD ④）与 `pglite → 真 PG` 端到端都要等有环境

## 已定决策 v1.2
- 桌面 **Electron 39.x**（内置 Node 22.22.1 ≥ pi 要求 22.19）；`ELECTRON_RUN_AS_NODE` spawn server 子进程
- 业务 **Fastify 5 + TS ESM**，绑 127.0.0.1 + Bearer Token；Web 模式是架构结果而非开关
- Agent：`pi-durable` 1.4 + `pi-ai` 1.4（BYOK 三档）+ `chord` 1.4（插件宿主基座）
- Tenon 前端 React 19 + Vite 7 + Tailwind 4 + shadcn + TanStack Query + Monaco
- 生成应用：前端同栈（+RR7+zod）；后端 **NestJS 11 + TypeORM + PostgreSQL 方言**
- **应用库两档**：`pglite`（WASM 版 PG，零安装，默认）/ `postgres`（Docker/external/云，发布）；`embedded`、`sqlite` 仅逃生口
- **产品库 `node:sqlite`**（Node 内置，零原生模块）→ **安装包内无任何需按平台编译的依赖**
- Git 一等公民（isomorphic-git）：一轮一 commit，发布 push+tag，回滚 `revert` + DB 快照
- 预览：每应用一个 **App Gateway**（代理 Vite HMR，iframe 不直连）
- 发布：Docker 多阶段 + compose 自带 postgres:18-alpine + 单容器单端口
- 平台：首发 **macOS + Windows**；Linux M7
- 插件：M5 bundled 内置 → M6 Hub 官方独源 → M7 第三方；同一 manifest/加载器，`hub > bundled` 覆盖（内置也能热更新）
- 商业：个人免费；企业卖协作/SSO/RBAC/私有 Hub；AGPL-3.0（Server）+ Apache-2.0（SDK/模板/生成物）+ 双许可

## 平台与 SaaS 的正确认识（曾混淆过）
- **pi 全家零平台依赖**（实测：零原生模块、无平台 optionalDeps、只用 Node 内置模块）→ Windows `npm i` 即用
- Windows 差异只在 Tenon 自己的基建层：Electron 打包签名 / `gondolin` 无后端 / 端口探测（lsof→netstat）
- **Electron 与 SaaS 正交**：同一份 server 换位置跑即另一种形态；Electron 给的是四项本地特权（本地文件/命令/OS 密钥链/离线）
- SaaS 化成本在六项 adapter（多租户隔离/存储/密钥/DB/认证计费/长连接），不在 Electron

## 待用户拍板（DESIGN §19.2，仅剩 3 条）
代码可见性节奏 / 个人商用是否也免费 / Linux 时间点
（原「收费结算」「市场审核」已因"L2 先官方独家维护"闭环：分别延至 M6 末 / M7）

## 里程碑
M1 骨架与对话 → M2 全栈生成+PG → M3 精调与版本 → M4 多 Agent → M5 组件体系(bundled) → M6 双平台+Hub+开源 → M7 后置

## 环境与资产
Node v22.22.2 ✅ / pnpm 9.15.9 ✅ / git 2.39.5 ✅
`docs/PI-CHEATSHEET.md`：pi 全生态真实 API（读源码所得，写代码前必查）
`docs/reverse/`、`*.har` 已 gitignore，仅内部研究，**clean-room 红线：不得搬运其代码/文案/提示词**
逆向工具链（临时，在 /tmp）：nettap2.js、cdp-hold-persist.mjs（须托管后台任务）、cdp-harvest-slice.mjs
