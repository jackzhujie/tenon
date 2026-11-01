# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。产品名 Tenon，作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，全局改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / §4.9 当前步 / 代码地图 / **§5 陷阱 76 条**）；方案 `docs/DESIGN.md`。
这里只留「不知道就会走错方向」的，细节查 STATUS §5，别重复。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`DATABASE_POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-01）
M1 九步 + M2 七步（第 8 步 Docker 产物按用户决定跳过）+ M3 九步 + **M4 第 1 步** → DESIGN **v1.2.15**。
八个包 + `apps/web`（渲染器）+ `apps/desktop`（壳）。
全绿基线：typecheck 15 project / test **302** / smoke 9 / e2e:preview **16** / e2e:inspector **13** /
e2e:diff **36** / e2e:release **32** / e2e:fullstack / smoke:desktop:packaged 8 / build:web 282KB。
M3 已通：定位注入 → 反查 → Alt+Click → 跨源回传 → 逐行差异 → 代码回滚 → 数据回滚 → 发布（tag + 本地裸库）。
M4 第 1 步：**子 Agent 能派活**（`roles.ts` 是 1 主 + 5 子的唯一事实来源；`subagent` 建真子会话、
只读白名单、递归从工具集上断；`explore`/`librarian` 可用，其余三角色待接工具）。
**下一步：M4 第 2 步 = 任务图面板**（`harness.taskGraph()` → RPC + SSE + UI，DoD ②）。
欠账：Docker compose 产物、真远端 push、发布质量门禁。

## 已定的架构选择（推翻要重做很多）
- 两边都 **Fastify 5 + TS ESM**（server 与生成应用后端是 NestJS 11 + TypeORM + PG 方言）
- 应用库两档 `pglite`（默认，零安装）/ `postgres`（发布）；产品库 `node:sqlite`
- **「安装包零原生模块」v1.2.13 起不再是硬约束**：预编译分发，`build.mjs` 只审计不拦。
  **仍守的边界：生成应用模板不引入需编译的包**（用户自己 `pnpm install`）
- Git 一等公民（isomorphic-git **纯 JS**，打进 `server.mjs`）：一轮一 commit；回滚用 `revert`；
  看单条改动用 `git.show`（`diff(sha)` 是累积语义）
- 跨档迁移**纯 JS 逻辑拷贝**，不用 `pg_dump`（用户机器上没有二进制）
- `@tenon/runtime` **源码分发**进模板（不发布 npm）+ 逐字节漂移测试
- **发布不用 `git.push`**（只走 HTTP 传输）：自己搬对象 + 写 ref 到裸库。真远端是"再加一个 transport"
- 日志采集走**应用自报**不走 CDP（只覆盖浏览器侧 / F12 就抢走 / 首屏全丢）→ DESIGN §11.1.1
- **只读检索 `ls`/`glob`/`grep` 是自己的实现**：`pi-coding-agent` 的 grep/find 会下载 rg/fd 二进制
- **档位（fast/comprehensive/thinking）目前只是声明**：设置只能存一个 provider，按档换模型是后续步骤

## 会静默坏数据/静默失效的（忘了看不出来）
- **pglite 档 `pool.max` 必须 = 1**：事务串到同一 backend，一条 ROLLBACK 抹掉另一条已写入的行（实测丢行）
- **不能用 `git.statusMatrix` 判变更**：同长度同毫秒的改动被判"没变" → 自算 blob oid + `add({force:true})`
- **迁移必须 `setval` 对齐序列**：否则全绿、行数一致，用户第一次新建就主键冲突 500
- **回滚顺序必须是「检查 → 还原数据 → 回滚代码」**：覆盖库不可逆。快照按 commit sha 归档，沿祖先链找
- **`dumpDataDir()` ≠ `cp -r` 数据目录**：前者运行中调用安全，后者才必须先 stop
- **`git.writeObject` 传 string 写坏对象**（fsck 报 could not be parsed 还不报错）→ 一律 Buffer；
  裸库 API 必须传 `gitdir` 不是 `dir`
- **`api.conversation(id)` 的句柄没有 `configure()`** → 子会话的模型/工具/指令只能在
  `harness.createConversation({ agent })` 那一刻定；`ConversationRecord` 的字段叫 `owner` 不是 `ownership`
- **faux 的响应工厂只服务一次**（内部 `shift()`）→ 必须把自己 `appendResponses` 塞回队尾；
  父子会话**必须分道**，否则子 Agent 吃掉父轮的台词（表现：派了活没干活）
- **`.gitignore` 的 `release/` 会让 Tailwind 跳过 `features/release/`**（v4 不扫 gitignore 命中路径）

## 本机环境
Node v22.22.2 / pnpm 9.15.9。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`
（注入的 node-language-shim 让 PGlite 慢 10 倍 → 撞 30s 超时；Electron 也要去掉）。
无 `docker`/`podman`/`colima`、无 `pg_dump`。Electron 需 `--no-sandbox`（否则 ERR_FAILED）。
`docs/PI-CHEATSHEET.md` 是 pi 全生态真实 API，写代码前必查。`docs/reverse/`、`*.har` 仅内部研究，
**clean-room 红线：不得搬运其代码 / 文案 / 提示词**。
