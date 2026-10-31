# 项目长期记忆 — 妙搭开源复刻（studio）

## 项目定位
- 开源复刻飞书妙搭：本地优先、可自托管的对话式 AI 全栈应用搭建平台（桌面 + Web 同构）
- 与字节/飞书无关联；命名必须避开「妙搭 / Miaoda / 飞书」商标

## 已确认决策（2026-10-31 大改版，覆盖 2026-10-24 的 Rust 方案）
- **桌面**：Electron 39.x（内置 Node 22.22.1），**Electron 只做壳，不含业务**
- **业务**：全部在本地 HTTP 服务（Node 22 + Fastify 5 + TS ESM，只绑 127.0.0.1）
- **Agent**：`@earendil-works/pi-durable` 1.4.x（精确锁版本）+ `pi-ai` 0.82.x；pi-durable 提供 checkpoint/resume/子 Agent/压缩/usage
- **Studio 前端**：React 19 + Vite 7 + Tailwind 4 + shadcn/ui + TanStack Query + Monaco
- **生成应用**：前端同栈（+React Router 7 + zod）；后端 **NestJS 11 + TypeORM + SQLite**，标准目录 utils/components/hooks/api/server modules
- **版本**：Git 一等公民（isomorphic-git）——一轮对话一次 commit，发布 push + tag，回滚 revert（可选 DB 快照）
- **发布**：Docker 多阶段、单容器单端口（Nest ServeStatic 托管前端）；默认只导出上下文+命令，不强制本机构建
- **预览**：每应用一个 App Gateway（稳定端口）→ Vite dev(HMR WS 代理) + Nest
- **License**：AGPL-3.0（Studio/Server）+ Apache-2.0（Runtime SDK/模板/生成物）+ 商业双许可
- 废弃：Tauri/Rust、Axum 单二进制、纯 Apache-2.0

## 关键约定
- 文档：`docs/DESIGN.md` 为**唯一事实来源**（v1.0）；`ARCHITECTURE.md` 仅为速览；`PROTOCOL.md` 为妙搭行为规格（clean-room）
- Clean-room：`docs/reverse/` 与所有 `*.har` 已 gitignore，仅内部研究；开源仓库只含重写规格，严禁复制字节代码/文案/资源
- pi-durable 属实验性 API：必须 `save-exact` 锁版本，并在 `packages/agent/adapter` 包一层隔离升级
- 逆向环境（已收尾，可复用）：调试 Chrome CDP 127.0.0.1:9222，profile /tmp/miaoda-rea-profile（--no-sandbox）
- 采集工具链：/tmp/nettap2.js（fetch/SSE/XHR流式/WS二进制 base64）、/tmp/cdp-hold-persist.mjs（持久注入，需托管后台任务）、/tmp/cdp-harvest-slice.mjs（分片收割）

## 待用户拍板（DESIGN.md §19）
产品名 / 生成应用默认 DB / 首发平台 / 是否多人协作 / 商业版边界 / 代码可见性节奏
