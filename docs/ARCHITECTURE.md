# ARCHITECTURE.md — 架构速览 v0.2

> ⚠️ 本文档为**速览**。完整方案见 **[DESIGN.md](DESIGN.md)**（v1.0，唯一事实来源）。
> v0.1 的 Rust/Tauri 方案已废弃，废弃理由见 DESIGN.md 附录 A。

## 一分钟版本

```
Electron 39（薄壳：窗口 / 菜单 / 自动更新 / spawn 子进程）
        │  preload 注入 baseUrl + token
        ▼
Studio Web App（React 19 + shadcn/ui + Tailwind 4，纯 Web 应用）
        │  HTTP + SSE（与浏览器形态完全一致）
        ▼
Studio Server（Node 22 + Fastify 5，只绑 127.0.0.1）
  ├─ Agent Runtime：pi-durable Harness 池（checkpoint / resume / 子 Agent / 压缩）
  │                 + pi-ai（BYOK 多提供商、三档模型路由、成本统计）
  ├─ 代码生成器（模板 + AST 补丁）
  ├─ Git 服务（每轮自动 commit，发布 push + tag）
  ├─ 预览编排（每应用一个 App Gateway → Vite HMR + NestJS）
  └─ 可观测管道（console / error / network / db → 面板 + 一键修复）
        │
        ▼
生成的应用（标准全栈：React + Vite + Tailwind + shadcn ｜ NestJS + TypeORM + SQLite）
        └─ Docker 导出（多阶段构建、单容器单端口）
```

## 三条不可动摇的原则

1. **Electron 不做业务**：业务全在本地 HTTP 服务里 → 同一套代码可 Web 打开、可被 Agent 直接驱动调试。
2. **Git 是一等公民**：一轮对话 = 一次 commit；回滚 = `revert`（可附带 DB 快照还原）。
3. **生成物必须是"人写的代码"**：标准目录、标准 NestJS 模块、共享 zod schema、质量门禁，随时可被开发者接管。

## 关键选型

| 层 | 选型 |
|---|---|
| 桌面 | Electron 39.x（内置 Node 22.22.1，满足 pi-durable ≥22.19） |
| 服务 | Fastify 5 + TypeScript 5.9 + ESM |
| Agent | `@earendil-works/pi-durable` 1.4.x（锁定）+ `pi-ai` 0.82.x |
| Studio 前端 | React 19 · Vite 7 · Tailwind 4 · shadcn/ui · TanStack Query · Monaco |
| 生成应用前端 | React 19 · Vite 7 · React Router 7 · Tailwind 4 · shadcn/ui · zod |
| 生成应用后端 | NestJS 11 · TypeORM · better-sqlite3（Docker 可换 Postgres） |
| 版本 | isomorphic-git（纯 JS） |
| 协议 | AGPL-3.0（Studio/Server）+ Apache-2.0（Runtime SDK/模板/生成物） |

## 里程碑

| 阶段 | 内容 |
|---|---|
| M1 | 骨架 + 对话 + harness + SSE + 预览热更新 + Web 模式 |
| M2 | 全栈生成（Nest + DB + CRUD）+ 可观测面板 |
| M3 | 元素/框选精调 + Diff + 回滚 + 发布 |
| M4 | 6 角色子 Agent + E2E 自验收 + 用量预算 |
| M5 | 打磨 + 三平台安装包 + 开源发布 |

详见 [DESIGN.md §17](DESIGN.md#17-里程碑)。
