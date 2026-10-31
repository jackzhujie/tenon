# 项目长期记忆 — Tenon（榫）

## 一句话
开源复刻飞书妙搭：**本地优先、可自托管的对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。
与字节/飞书无关，已避开「妙搭/Miaoda/飞书」。产品名 **Tenon（榫）**，代号 `tenon`，作用域 `@tenon/*`。
隐喻：榫卯不用钉子靠构件咬合 = 应用由标准组件咬合，Agent 只做设计与搭接。
⚠️ `LM Studio` 是第三方产品名，全局改名时必须保护。

## 当前状态（2026-10-31 深夜）
M0 逆向完成 → **DESIGN v1.2.4** → 四个 spike 全过 → **M1 主干第 1~7 步已落地**（`599ed98`、`6f08edb`、最新一次）。
六个包 `packages/{protocol,core,agent,generator,gateway,server}`：
服务能起、能对话（SSE 流式）、能落库、能每轮自动 git 提交、崩溃后 `resume()` 续跑；
**Agent 有 read/write/edit/bash 四个工具、写完的文件进得了这一轮的 commit**；
**新建应用会用 `react-vite` 模板铺出可跑工作区，`preview.start` 装依赖 + 起 Vite + 挂网关，iframe 打开的就是它**。
`pnpm test` 62 项 + `pnpm smoke` 9 项 + `pnpm e2e:preview` 12 项全绿；`pnpm dev:faux` 不需要任何 API Key。
**下一步**：`apps/web`（会话 + iframe 两栏）→ `pnpm dev:web` → Electron 壳。
**开工入口：`docs/STATUS.md`**（§4.2 进度表 / §4.4 下一步拆解 / §4.5 代码地图 / §5 陷阱）；方案：`docs/DESIGN.md`（唯一事实来源）。

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
