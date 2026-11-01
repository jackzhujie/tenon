# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。产品名 Tenon，作用域 `@tenon/*`。
隐喻：应用由标准组件咬合，Agent 只做设计与搭接。⚠️ `LM Studio` 是第三方名，全局改名须保护。

**开工入口：`docs/STATUS.md`**（进度表 §4.2 / 各步 DoD / §4.7 下一步 / §4.8 代码地图 / **§5 全部陷阱 70+ 条**）；方案 `docs/DESIGN.md`。
本节只留「不知道就会走错方向」的那几条，细节一律查 STATUS §5，别在这里重复。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`DATABASE_POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-01）
M1 九步全完成 + M2 七步（第 8 步 Docker 产物按用户决定跳过）+ **M3 第 1~2 步** → DESIGN **v1.2.10**。
八个包 + `apps/web`（渲染器）+ `apps/desktop`（壳）。
全绿基线：`pnpm typecheck` 15 project / `pnpm test` **187 项** / `smoke` 9 / `e2e:preview` **16** / `e2e:fullstack` / `smoke:desktop:packaged` 8。
M3 已落地：JSX 编译期注入 `data-tenon-loc` / `data-tenon-callsite`（Babel 插件，源码分发进模板，只 dev 生效）
+ `resolveTarget()` 反查。**下一步 M3 第 3 步：inspector 交互（Alt+Click / 框选 / SelectionContext 回传）**。
Docker compose 产物 ⏸ 欠账（本机无容器运行时，不产出未验证的 Dockerfile）。

## 已定的架构选择（推翻要重做很多）
- 两边都 **Fastify 5 + TS ESM**（server 与生成应用后端是 NestJS 11 + TypeORM + PG 方言）
- 应用库两档 `pglite`（默认，零安装）/ `postgres`（发布）；产品库 `node:sqlite` → **安装包零原生模块**
- Git 一等公民（isomorphic-git）：一轮一 commit；回滚用 `revert` 不用 `reset --hard`
- 跨档迁移**纯 JS 逻辑拷贝**，不用 `pg_dump`（用户机器上没有二进制）
- `@tenon/runtime` **源码分发**进模板（不发布 npm），`sync-templates.mjs` + 逐字节漂移测试
- 日志采集走**应用自报**不走 CDP：CDP 只能看浏览器侧、要独占 target（用户按 F12 就被抢走）、
  首屏崩溃与 HMR 重刷窗口内的异常全丢、Node 侧要开 `--inspect`（等于本机开一个可执行代码的端口）
  → 细节与反驳都在 DESIGN §11.1.1。CDP 只留作未来性能面板的**可选增强**，不进主链路

## 会静默坏数据的三条（忘了看不出来）
- **pglite 档 `pool.max` 必须 = 1**：两条连接的事务串到同一 backend，一条 `ROLLBACK` 抹掉另一条已写入的行（实测丢行）
- **不能用 `git.statusMatrix` 判变更**：同长度同毫秒的改动被判"没变" → `commitAll` 自算 blob oid + `add({force:true})`，别改回去
- **迁移必须 `setval` 对齐序列**：否则迁移全绿、行数一致，用户第一次新建就主键冲突 500

## 本机环境
Node v22.22.2 / pnpm 9.15.9。写文件密集的测试（PGlite）必须
`env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE pnpm test`（注入的 `node-language-shim` 让它慢 10 倍 → 全撞 30s 超时，看着像代码坏了）。
无 `docker`/`podman`/`colima`、无 `pg_dump`。
`docs/PI-CHEATSHEET.md` 是 pi 全生态真实 API，写代码前必查。`docs/reverse/`、`*.har` 仅内部研究，
**clean-room 红线：不得搬运其代码 / 文案 / 提示词**。
