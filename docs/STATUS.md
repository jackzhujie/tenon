# STATUS.md — 当前状态与下一步

> **用途：新会话 / 新协作者的唯一入口。读完这一页即可开工，不必先读完整 `DESIGN.md`。**
> 最后更新：2026-10-31（四个 spike 全部跑完，进入 M1 主干）

---

## 0. 一句话现状

**M0 逆向完成 → DESIGN v1.2.1 定稿 → 第一周四个 spike 全部通过（撞出 `pool.max=1` 硬约束）→ 现在做 M1 主干。**
仓库里已有一层 pnpm workspace 骨架与 `spikes/`（四个 spike 都能 `pnpm spike:*` 复跑）。

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
| `docs/DESIGN.md` | **唯一事实来源**，v1.2.1，1500+ 行 | 写涉及架构的代码前，按需读对应章节 |
| **`docs/SPIKES.md`** | 四个 spike 的实测数字与结论（含被推翻的假设）| 碰 DB / pi / 网关 / 定位插件前必读 |
| `docs/ARCHITECTURE.md` | 一分钟速览 + 四条原则 | 给别人介绍时 |
| `docs/PI-CHEATSHEET.md` | pi 全生态真实 API（读源码所得）| **写任何 pi 相关代码前必查**（比官方文档全）|
| `docs/PROTOCOL.md` | 妙搭行为规格（clean-room）| 不确定某个交互该怎么做时 |
| `docs/REVERSE_ENGINEERING.md` | 内部研究方法 | 仅内部，不随开源发布 |

`docs/reverse/`、`*.har` 已 gitignore，**不得提交**，也**不得把其中的代码/文案/提示词搬进产品**（clean-room 红线）。

---

## 4. 下一步：M1 骨架与对话

### 4.1 第一周：4 个 spike —— ✅ **已全部完成（2026-10-31）**

| # | 验证什么 | 结果 |
|---|---|---|
| 1 | `pi-durable` 最小闭环：`Harness.open` + `submit` + 流式 + `resume()` | ✅ 10/10。**流式中途 SIGKILL → `resume()` 把同一提交从 `placed` 跑到 `done`** |
| 2 | App Gateway 代理 **Vite HMR WebSocket** | ✅ 8/8。HMR update **134ms**；上游换端口网关 URL 不变 |
| 3 | `data-tenon-loc` 在 JSX 上准确对应 `file:line`（经组合组件） | ✅ 7/7。改为 `loc`（原生）+ `callsite`（组合组件）双属性，9/9 可回溯 |
| 4 | **`PGlite + pg-gateway + TypeORM`** 稳定性与 P95 | ⚠️ **有条件通过**：20 并发 P95 14ms(读)/24ms(写)、零超时；但 **`pool.max>1` 会让并发事务互相回滚 → 必须为 1** |

详细数字、可复跑命令、被推翻的假设：**`docs/SPIKES.md`**。

### 4.2 M1 主干（按依赖顺序）—— 现在从这里开始

进度：第 1 步已开一半（workspace + `spikes/` 已就位，`packages/*` 尚未建）。

1. **monorepo 骨架** — pnpm workspace ✅ / `packages/{protocol,server,agent,generator,db-provisioner,runtime-sdk,ui,core,component-host}` + `apps/{web,desktop}` 待建；tsconfig base ✅ + eslint/biome + vitest
2. **server 起来** — Fastify 5 + TS ESM，随机端口绑 `127.0.0.1`，Bearer Token，`/api/health`
3. **`tenon.db`** — 用 `node:sqlite` 建 `apps` / `releases` / `settings` / `provider_profiles`（schema 见 DESIGN §6.2）
4. **harness 池** — 每应用一个 `.tenon/harness.sqlite`，pi-durable 封装在 `packages/agent/adapter`（**照 `spikes/agent/src/index.ts` 抄，别忘 `resume()`**）
5. **SSE 对话链路** — `chat.submit` / `chat.stop` / 事件流（`requestId` 幂等，`whenBusy` 策略）
6. **Git 自动提交** — isomorphic-git init，每轮 commit 带 trailer 元数据
7. **静态预览** — App Gateway 托管一个纯前端 React 应用（**`spikes/gateway` 可直接演进**），热更新打通（M1 不碰数据库）
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
| **`PGlite` 的 `pool.max` 必须是 1** | 不是调优建议。`pool.max=2` 时两条连接的事务落在同一个 backend 会话上，一条 `ROLLBACK` 会抹掉另一条已写入的行（实测 `iso-A` 丢失）。收益只有 19% p95，不值得 |
| **`harness.resume()` 不能忘** | server 启动序列少了这句，崩溃恢复能力等于没有（spike 1 就是这么验证的）|
| **`ELECTRON_RUN_AS_NODE` 的正确用法** | `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`；不要额外打包 Node |
| **pi 依赖 `node:sqlite`** | Electron 内置 Node 有该模块（已验证），所以不能在 `node_modules` 里补 `better-sqlite3` 之类原生模块 |
| **安装包内不得有原生模块** | 这是 v1.2 的核心收益：产品库用内置 `node:sqlite`、应用库用 WASM 版 PG → 无需 `@electron/rebuild`、无需 node-gyp |
| **PGlite 冷启动 2.4s / 每应用 38MB** | 建应用与快照都要算这笔账：`app.create` 要给分阶段进度，`dumpDataDir` 约 4.5MB、0.7s |
| **LISTEN/NOTIFY 不可用** | PGlite + pg-gateway 下监听端收不到通知（实测 0 条）。后端推前端只能走网关 SSE |
| **HMR 首帧会丢** | 客户端要在 WS 握手**之前**挂好 `message` 监听，否则丢掉 Vite 的 `connected` |
| **taskGraph 静止时为空** | 任务结束节点会被回收；状态面板要在跑动中采样，静止时展示"上次结果" |
| **端口探测跨平台** | Windows 无 `lsof`，用 `netstat` / `Get-NetTCPConnection` |
| **`gondolin` 在 Windows 无后端** | 不在 Windows 启用；L3 组件走「独立子进程 + 权限清单」（DESIGN §15.3 方案 B）|
| **不要用 `reset --hard` 做回滚** | 一律 `git revert`，保留历史 |
| **产品库与应用库是两件事** | 别把 `tenon.db`（SQLite）和用户业务库（PG）混为一谈 |
| **无 API Key 也能开发** | `pi-ai` 自带 `providers/faux`（`fauxProvider()` + `fauxAssistantMessage()`），CI 与本地都用它，别 mock harness |

---

## 6. 环境

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node | `>= 22.19`（pi 硬要求，主因 `node:sqlite`）| v22.22.2 ✅ |
| pnpm | 9.x | 9.15.9 ✅ |
| git | 任意（isomorphic-git 是纯 JS，系统 git 可选）| 2.39.5 ✅ |

spike 复跑入口（在仓库根目录）：

```bash
pnpm install
pnpm spike:db       # PGlite + TypeORM 压测（含正确性探针）→ spikes/db/results/spike-db.json
pnpm spike:agent    # pi-durable 闭环 + 崩溃续跑            → spikes/agent/results/spike-agent.json
pnpm spike:gateway  # 网关 HMR 代理
pnpm spike:loc      # 定位插件精度
```

> `spikes/*/pgdata*`、`spikes/*/work/` 是运行产物，已 gitignore；`results/*.json` 保留入库作为证据。

---

## 7. 新会话开场提示词（可直接粘贴）

```
继续 Tenon（榫）项目，路径 /Users/mac/project/miaoda。

先读 docs/STATUS.md（现状、下一步、陷阱），再读 docs/SPIKES.md（四个 spike 的实测结论，
尤其 §1 的 pool.max=1 硬约束）。涉及架构再查 docs/DESIGN.md（唯一事实来源 v1.2.1），
写 pi 相关代码前必查 docs/PI-CHEATSHEET.md。

当前阶段：M1 主干。四个 spike 已全部通过，按 STATUS.md §4.2 的顺序推进，
从 packages/protocol + packages/server 起（spikes/ 里的四个脚本是可直接演进的参考实现）。

三条铁律不要违反：Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 + adapter 包装。
```
