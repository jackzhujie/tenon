# 项目长期记忆 — Tenon（榫）

## 定位
开源复刻飞书妙搭：本地优先、可自托管的对话式 AI 全栈应用搭建平台（桌面 + Web 同构）。
与字节/飞书无关联；命名已避开「妙搭 / Miaoda / 飞书」。

## 命名
**Tenon（榫）**，中文「榫」，代码代号 `tenon`，包作用域 `@tenon/*`。
隐喻：榫卯不用钉子靠构件咬合 = 应用由标准组件咬合，Agent 只做设计与搭接。
避讳检查通过；备选 Mortise / Kiln / Weft。注意 `LM Studio` 是第三方产品名，全局改名时须保护。

## 已确认决策（DESIGN.md v1.1，2026-10-31）
- **桌面**：Electron 39.x（内置 Node 22.22.1，满足 pi ≥22.19）；**Electron 只做壳，不含业务**
- **业务**：本地 HTTP 服务（Node 22 + Fastify 5 + TS ESM，只绑 127.0.0.1）→ Web 打开是架构本身，非开关
- **Agent**：`pi-durable` 1.4（Harness/任务图/子会话/压缩/重放）+ `pi-ai` 1.4（BYOK）
- **插件生态**：`chord` 1.4（contract/facet/principal/热重载）——组件市场基座
- **Tenon 前端**：React 19 + Vite 7 + Tailwind 4 + shadcn/ui + TanStack Query + Monaco
- **生成应用**：前端同栈（+React Router 7 + zod）；后端 **NestJS 11 + TypeORM + PostgreSQL 18**
- **数据库供给**：应用只认一个 `DATABASE_URL`；四档 = embedded-postgres（默认）/ docker / external / pglite 降级（pg-gateway 提 TCP）
- **产品库**：SQLite（tenon.db / harness.sqlite / telemetry.db），与应用库分离
- **版本**：Git 一等公民（isomorphic-git）——一轮对话一次 commit，发布 push+tag，回滚 revert + pg_dump/pg_restore
- **发布**：Docker 多阶段 + compose 自带 postgres + 单容器单端口
- **预览**：每应用一个 App Gateway（稳定端口）→ Vite HMR + Nest + PG
- **平台**：首发 **macOS + Windows**；Linux M7
- **商业化**：个人免费（含全部核心能力）；企业版卖协作/SSO/RBAC/私有市场；组件市场分免费/收费，授权在 principal 层
- **License**：AGPL-3.0（Tenon/Server）+ Apache-2.0（Runtime SDK/模板/生成物）+ 商业双许可

## 关键约定
- `docs/DESIGN.md` 为**唯一事实来源**（v1.1）；`ARCHITECTURE.md` 速览；`PROTOCOL.md` 妙搭行为规格（clean-room）
- `docs/PI-CHEATSHEET.md`：pi 全生态真实 API 速查（读源码所得，写代码前必查）
- Clean-room：`docs/reverse/` 与 `*.har` 已 gitignore，仅内部研究
- pi 全家属实验性 API：必须 `save-exact` 锁版本，并在 `packages/agent/adapter` 包一层
- 生成应用代码**永不感知运行环境**（不判断 desktop/docker），供给由平台层注入
- **Windows 无 gondolin 后端**：L3 社区组件用独立子进程 + 权限清单（DESIGN §15.3 方案 B）
- 沙箱层级：L1 内置积木（不隔离）/ L2 官方组件（签名）/ L3 社区组件（子进程+权限）

## 里程碑
M1 骨架与对话 → M2 全栈生成+PG → M3 精调与版本 → M4 多 Agent → M5 组件体系 → M6 双平台+市场+开源 → M7 后置

## 待用户拍板（DESIGN §19.2）
代码可见性节奏 / 收费组件结算方式 / 个人免费边界（个人商用）/ 市场审核策略 / Linux 时间点

## 逆向资产（已收尾）
调试 Chrome CDP 127.0.0.1:9222，profile /tmp/miaoda-rea-profile（--no-sandbox）
工具链：/tmp/nettap2.js、/tmp/cdp-hold-persist.mjs（须托管后台任务）、/tmp/cdp-harvest-slice.mjs
