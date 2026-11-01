# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。产品名 Tenon，作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，全局改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / §4.7 下一步 / 代码地图 / **§5 陷阱 70+ 条**）；方案 `docs/DESIGN.md`。
这里只留「不知道就会走错方向」的，细节查 STATUS §5，别重复。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`DATABASE_POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-01）
M1 九步 + M2 七步（第 8 步 Docker 产物按用户决定跳过）+ **M3 九步全部完成** → DESIGN **v1.2.14**。
八个包 + `apps/web`（渲染器）+ `apps/desktop`（壳）。
全绿基线：typecheck 15 project / test **277** / smoke 9 / e2e:preview **16** / e2e:inspector **13** /
e2e:diff **36** / e2e:release **32** / e2e:fullstack / smoke:desktop:packaged 8 / build:web 282KB。
M3 已通：定位注入 → `resolveTarget()` 反查 → Alt+Click → 跨源 postMessage（hash token + 三道校验）
→ Composer chip → `chat.submit.selection` → `git.show` 逐行差异 + 改动面板 → `revert` 代码回滚
→ **数据回滚**（schema 提交自动存快照 + `dbRestore` 勾选）→ **发布**（annotated tag + 镜像到
`~/.tenon/backups/<appId>.git` 裸库 + release 记录）。
**下一步：M4**。欠账三笔：Docker compose 产物（本机无容器运行时）、`postgres` 档快照仍靠 `pg_dump`、
发布只推得动本地裸库（真远端要凭据 + 网络，没验所以没接）。

## 已定的架构选择（推翻要重做很多）
- 两边都 **Fastify 5 + TS ESM**（server 与生成应用后端是 NestJS 11 + TypeORM + PG 方言）
- 应用库两档 `pglite`（默认，零安装）/ `postgres`（发布）；产品库 `node:sqlite`
- **「安装包零原生模块」v1.2.13 起不再是硬约束**（从来就不是三条铁律之一，是被误标成"铁律 3 兜底"）：
  安装包预编译分发，用户机器不需要 node-gyp。`build.mjs` 只审计并打印清单，要卡住设 `TENON_STRICT_NATIVE=1`。
  **仍守的边界：生成应用的模板依赖不引入需编译的包**（用户在自己机器上 `pnpm install`）
- Git 一等公民（isomorphic-git 1.44.8 **纯 JS，不调系统 git**，打进 `server.mjs` 单文件，包里没有 git 二进制）：
  一轮一 commit；回滚用 `revert` 不用 `reset --hard`；看单条改动用 `git.show`（`diff(sha)` 是累积语义，不对）
- 跨档迁移**纯 JS 逻辑拷贝**，不用 `pg_dump`（用户机器上没有二进制；发布档的 `pg_dump` 快照也不打包 ——
  版本必须 ≥ 服务端版本，而用户连的云 PG 版本不可预测）
- `@tenon/runtime` **源码分发**进模板（不发布 npm），`sync-templates.mjs` + 逐字节漂移测试
- **发布不用 `git.push`**（isomorphic-git 的 push 只走 HTTP 传输，本地路径也报 `requires "http"`）：
  改成自己搬对象 + 写 ref 到裸库。真远端是"再加一个 transport"，不是重写流程
- 日志采集走**应用自报**不走 CDP（只覆盖浏览器侧 / 独占 target、F12 就抢走 / 首屏与 HMR 期全丢 /
  Node 侧等于开个能执行代码的端口）→ DESIGN §11.1.1

## 会静默坏数据的三条（忘了看不出来）
- **pglite 档 `pool.max` 必须 = 1**：两条连接的事务串到同一 backend，一条 `ROLLBACK` 抹掉另一条已写入的行（实测丢行）
- **不能用 `git.statusMatrix` 判变更**：同长度同毫秒的改动被判"没变" → `commitAll` 自算 blob oid + `add({force:true})`，别改回去
- **迁移必须 `setval` 对齐序列**：否则迁移全绿、行数一致，用户第一次新建就主键冲突 500
- **回滚顺序必须是「检查 → 还原数据 → 回滚代码」**：覆盖库不可逆、回滚代码可逆。反了会留下
  "代码退了、数据没退"的半成品。快照按 commit sha 归档（`exports/db/<sha>/`），沿祖先链找最近一份
- **`dumpDataDir()` ≠ `cp -r` 数据目录**：前者运行中调用安全（实测未提交事务不会被卷进去）；
  后者才必须先 stop。别为了"安全"白停一次库（2.4s）
- **`git.writeObject` 传 string 会写坏对象**（tag 对象解压后是乱码、`fsck` 报 could not be parsed，
  还不报错）→ 内容一律 Buffer；打 tag 直接用 `git.writeTag`。裸库 API 必须传 `gitdir` 而不是 `dir`
- **`.gitignore` 的 `release/` 会让 Tailwind 跳过 `features/release/`**（v4 不扫 gitignore 命中的路径）
  → 新类名不生成 CSS、只有那一处样式失效。已改精确路径 `/apps/desktop/release/`

## 本机环境
Node v22.22.2 / pnpm 9.15.9。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`
（注入的 `node-language-shim` 让 PGlite 慢 10 倍 → 撞 30s 超时；Electron 也要去掉）。
无 `docker`/`podman`/`colima`、无 `pg_dump`。Electron 需 `--no-sandbox`（否则 ERR_FAILED）。
`docs/PI-CHEATSHEET.md` 是 pi 全生态真实 API，写代码前必查。`docs/reverse/`、`*.har` 仅内部研究，
**clean-room 红线：不得搬运其代码 / 文案 / 提示词**。
