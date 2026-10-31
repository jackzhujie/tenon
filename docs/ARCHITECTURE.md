# ARCHITECTURE.md — 架构速览 v0.3

> ⚠️ 本文档为**速览**。完整方案见 **[DESIGN.md](DESIGN.md)**（v1.1，唯一事实来源）。
> v0.1 的 Rust/Tauri 方案、v1.0 的 SQLite 默认方案均已废弃，废弃理由见 DESIGN.md 附录 A。

## 一分钟版本

```
Electron 39（薄壳：窗口 / 菜单 / 自动更新 / spawn 子进程）
        │  preload 注入 baseUrl + token
        ▼
Tenon Web App（React 19 + shadcn/ui + Tailwind 4，纯 Web 应用）
        │  HTTP + SSE（与浏览器形态完全一致）
        ▼
Tenon Server（Node 22 + Fastify 5，只绑 127.0.0.1）
  ├─ Agent Runtime：pi-durable Harness 池（checkpoint / resume / 子 Agent / 压缩 / 任务图）
  │                 + pi-ai（BYOK 多提供商、三档模型路由、成本统计）
  ├─ 组件宿主：chord（contract + facet 热重载 + principal 授权）
  ├─ 代码生成器（模板 + AST 补丁）
  ├─ Git 服务（每轮自动 commit，发布 push + tag）
  ├─ 预览编排（每应用一个 App Gateway → Vite HMR + NestJS + PostgreSQL）
  └─ 可观测管道（console / error / network / db → 面板 + 一键修复）
        │
        ▼
生成的应用（标准全栈：React + Vite + Tailwind + shadcn ｜ NestJS + TypeORM + PostgreSQL）
        └─ Docker 导出（多阶段构建，compose 内含 db，单容器单端口）
```

## 四条不可动摇的原则

1. **Electron 不做业务**：业务全在本地 HTTP 服务里 → 同一套代码可 Web 打开、可被 Agent 直接驱动调试。
2. **Git 是一等公民**：一轮对话 = 一次 commit；回滚 = `revert`（可附带 DB 快照还原）。
3. **生成物必须是"人写的代码"**：标准目录、标准 NestJS 模块、共享 zod schema、质量门禁，随时可被开发者接管。
4. **应用只认一个 `DATABASE_URL`**（v1.1 新增）：PostgreSQL 的供给方式（embedded/docker/external/lite）由平台决定，应用代码永不感知运行环境。

## 关键选型

| 层 | 选型 |
|---|---|
| 桌面 | Electron 39.x（内置 Node 22.22.1，满足 pi 全家 ≥22.19）|
| 服务 | Fastify 5 + TypeScript 5.9 + ESM |
| Agent | `@earendil-works/pi-durable` 1.4.x（锁定）+ `pi-ai` 1.4.x |
| 插件宿主 | `@earendil-works/chord` 1.4.x（contract / facet / 热重载 / principal）|
| Tenon 前端 | React 19 · Vite 7 · Tailwind 4 · shadcn/ui · TanStack Query · Monaco |
| 生成应用前端 | React 19 · Vite 7 · React Router 7 · Tailwind 4 · shadcn/ui · zod |
| 生成应用后端 | NestJS 11 · TypeORM · **PostgreSQL 18**（本地默认 PGlite，发布切真 PG）|
| 产品库 | **`node:sqlite`**（Node 内置，零原生模块）—— 单机注册表，与应用库分开 |
| 版本 | isomorphic-git（纯 JS）|
| 协议 | AGPL-3.0（Tenon/Server）+ Apache-2.0（Runtime SDK/模板/生成物）|

## 里程碑

| 阶段 | 内容 |
|---|---|
| M1 | 骨架 + 对话 + harness + SSE + 预览热更新 + Web 模式（mac/win 双平台冒烟）|
| M2 | 全栈生成（Nest + PostgreSQL 两档供给：pglite/postgres + CRUD）+ 可观测面板 |
| M3 | 元素/框选精调 + Diff + 回滚（含 pg_dump/pg_restore）+ 发布 |
| M4 | 6 角色子 Agent + E2E 自验收 + 用量预算 + taskGraph 面板 |
| M5 | chord 组件体系 + 6 个标准插槽 + 首发 3 个官方插件（bundled 内置）|
| M6 | mac/win 双平台安装包 + 组件 Hub（首期官方独源）+ 开源发布 |
| M7 | （后置）Linux、团队协作、托管能力（SaaS）、第三方插件上架 |

详见 [DESIGN.md §17](DESIGN.md)。

## 三份文档的关系

| 文档 | 作用 |
|---|---|
| `DESIGN.md` | **唯一事实来源**，实现以此为准 |
| `PROTOCOL.md` | 妙搭行为规格（clean-room 逆向产出），只作行为参考 |
| `ARCHITECTURE.md` | 本文，给新人的十分钟速览 |
