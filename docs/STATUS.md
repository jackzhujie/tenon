# STATUS.md — 当前状态与下一步

> **用途：新会话 / 新协作者的唯一入口。读完这一页即可开工，不必先读完整 `DESIGN.md`。**
> 最后更新：2026-10-31（DESIGN 升到 v1.2）

---

## 0. 一句话现状

**M0 逆向研究已完成 → 方案 v1.2 定稿 → 即将进入 M1 骨架实施（代码尚未开始，仓库里只有 `docs/` 与 README）。**

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
| `docs/DESIGN.md` | **唯一事实来源**，v1.2，1500+ 行 | 写涉及架构的代码前，按需读对应章节 |
| `docs/ARCHITECTURE.md` | 一分钟速览 + 四条原则 | 给别人介绍时 |
| `docs/PI-CHEATSHEET.md` | pi 全生态真实 API（读源码所得）| **写任何 pi 相关代码前必查**（比官方文档全）|
| `docs/PROTOCOL.md` | 妙搭行为规格（clean-room）| 不确定某个交互该怎么做时 |
| `docs/REVERSE_ENGINEERING.md` | 内部研究方法 | 仅内部，不随开源发布 |

`docs/reverse/`、`*.har` 已 gitignore，**不得提交**，也**不得把其中的代码/文案/提示词搬进产品**（clean-room 红线）。

---

## 4. 下一步：M1 骨架与对话

### 4.1 第一周：4 个 spike（先做，任一失败要回退方案）

| # | 验证什么 | 失败的话 |
|---|---|---|
| 1 | `pi-durable` 最小闭环：`Harness.open` + `submit` + `watchEvents` 流式输出 + `resume()` 续跑 | 检查是否 Node 版本/`node:sqlite` 问题；最坏换 `pi-agent` 裸用 |
| 2 | App Gateway 代理 **Vite HMR WebSocket**（iframe 走网关，不是直连） | 退化为轮询刷新，体验降级但可接受 |
| 3 | `data-tenon-loc` 在 JSX 上准确对应 `file:line`（经 Tailwind/shadcn 组合组件后仍准） | M3 精调改为「AST 反查 + 文件名兜底」 |
| 4 | **`PGlite + pg-gateway + TypeORM` 在 `pool.max=1~2` 下的稳定性与 P95 延迟** | **退回 `embedded` 默认档**（DESIGN §6.4 的逃生口就是为此保留的）|

> 第 4 条是**整个数据库选型唯一可能被推翻的点**，务必早撞。压测脚本要覆盖：并发 20 请求、事务回滚、连接复用、迁移执行。

### 4.2 M1 主干（按依赖顺序）

1. **monorepo 骨架** — pnpm workspace；`packages/{protocol,server,agent,generator,db-provisioner,runtime-sdk,ui}` + `apps/desktop`；tsconfig base + eslint + vitest
2. **server 起来** — Fastify 5 + TS ESM，随机端口绑 `127.0.0.1`，Bearer Token，`/api/health`
3. **`tenon.db`** — 用 `node:sqlite` 建 `apps` / `releases` / `settings` / `provider_profiles`（schema 见 DESIGN §6.2）
4. **harness 池** — 每应用一个 `.tenon/harness.sqlite`，pi-durable 封装在 `packages/agent/adapter`
5. **SSE 对话链路** — `chat.submit` / `chat.stop` / 事件流（`requestId` 幂等，`whenBusy` 策略）
6. **Git 自动提交** — isomorphic-git init，每轮 commit 带 trailer 元数据
7. **静态预览** — App Gateway 托管一个纯前端 React 应用，热更新打通（M1 不碰数据库）
8. **Web 模式** — `pnpm dev:web` 全流程可用
9. **Electron 壳** — **最后接入**，打包冒烟（mac + win）

### 4.3 M1 验收（DoD）

- [ ] `pnpm dev:web` 打开即可对话
- [ ] 生成一个纯前端 Todo 应用，iframe 里热更新生效
- [ ] 每轮对话产生一个 git commit
- [ ] 杀进程重启后，对话与任务能续跑（`resume()`）

---

## 5. 已知陷阱（都踩过，别重踩）

| 陷阱 | 说明 |
|---|---|
| **`ELECTRON_RUN_AS_NODE` 的正确用法** | `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`；不要额外打包 Node |
| **pi 依赖 `node:sqlite`** | Electron 内置 Node 有该模块（已验证），所以不能在 `node_modules` 里补 `better-sqlite3` 之类原生模块 |
| **安装包内不得有原生模块** | 这是 v1.2 的核心收益：产品库用内置 `node:sqlite`、应用库用 WASM 版 PG → 无需 `@electron/rebuild`、无需 node-gyp |
| **TypeORM 连接池** | 连 PGlite 必须 `pool.max = 1~2`，默认 10 会串行化超时 |
| **端口探测跨平台** | Windows 无 `lsof`，用 `netstat` / `Get-NetTCPConnection` |
| **`gondolin` 在 Windows 无后端** | 不在 Windows 启用；L3 组件走「独立子进程 + 权限清单」（DESIGN §15.3 方案 B）|
| **不要用 `reset --hard` 做回滚** | 一律 `git revert`，保留历史 |
| **产品库与应用库是两件事** | 别把 `tenon.db`（SQLite）和用户业务库（PG）混为一谈 |

---

## 6. 环境

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node | `>= 22.19`（pi 硬要求，主因 `node:sqlite`）| v22.22.2 ✅ |
| pnpm | 9.x | 9.15.9 ✅ |
| git | 任意（isomorphic-git 是纯 JS，系统 git 可选）| 2.39.5 ✅ |

---

## 7. 新会话开场提示词（可直接粘贴）

```
继续 Tenon（榫）项目，路径 /Users/mac/project/miaoda。

先读 docs/STATUS.md（现状、下一步、陷阱），再按需查 docs/DESIGN.md（唯一事实来源 v1.2）
和 docs/PI-CHEATSHEET.md（pi 真实 API）。

当前阶段：M1 骨架与对话，代码尚未开始。按 STATUS.md §4 的顺序推进，
第一周先做 4 个 spike，其中第 4 条（PGlite + TypeORM 压测）最关键。

三条铁律不要违反：Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 + adapter 包装。
```
