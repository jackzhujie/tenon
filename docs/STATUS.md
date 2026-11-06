# STATUS.md — 当前状态与下一步

> **用途：新会话 / 新协作者的唯一入口。读完这一页即可开工，不必先读完整 `DESIGN.md`。**
> 最后更新：2026-11-04（**M1 全部 9 步 + M2 七步落地（第 8 步 Docker 产物按用户决定跳过）+ M3 全部完成
> + M4 第 1–7 步（子 Agent 能派活 + 任务图面板 + 用量与预算熔断 + e2e 子 Agent 的预览工具
> + Reviewer 出风险清单 + CodeAct 的脚本沙箱 + 发布前质量门禁）
> + **发布预检**（`release.check`：打开对话框就知道能不能发）
> + **M5 第 1 步**（chord 宿主接入 spike，10 项，`pnpm spike:chord`）
> + **M5 第 2 步**（组件加载器：清单 / 装配声明 / 覆盖层解析 / 加载计划 / `component.list`）
> + **M5 第 3 步（a）**（第一个真组件：契约 + server facet + 插件构建 + 宿主装载）
> + **M5 第 3 步（b）**（界面半边：web facet + 网关注入 + WS 链路）
> + **M5 第 4–8 步**（install / remove 工具、插件页开关、另两个官方组件、组件端到端 5/5）
> + **M5.5**（真模型验收 12/12、模型设置页与热切换、依赖安装时机、模型价格表）
> + **M6 第 1–5 步（M6 收口）**（Hub 客户端：验签 + 原子落盘；签名索引 + 更新检查；组件商店：装/卸 + 付费门禁；
> 组件持久化；**授权模型定稿 + Hub 配置随包分发 + `pnpm e2e:hub` 从零发布 32 项**）：**700 个测试** + 9 项端到端冒烟 + 16 项预览 e2e + 13 项精调 e2e（真 Chromium 里模拟 Alt+Click）+
> 44 项改动/回滚与发布 e2e（发布那条用系统 git 当裁判：`fsck --strict` + `clone`）+ 9 项自验收 e2e（真 Electron 里点页面）
> + 全栈 e2e + 8 项桌面冒烟全绿；`pnpm dev:web`、`pnpm e2e:fullstack` 与打包后的 `Tenon.app` 都实测走通。**M2 / M3 已收口**）

---

## 0. 一句话现状

**生成的应用现在有后端了：一句话建出来的应用自带 NestJS + PostgreSQL（默认 PGlite 零安装），
前端一个 `fetch('/api/health')` 就能打通，切换成真 PG 只改 `DATABASE_URL`，应用代码零改动。**

M1 已经全部落地（一条命令起界面、对话里改代码、iframe 当场热更新、能打成 `Tenon.app` 双击运行）；
M2 第 1 步把「只有页面」变成「有库、有接口、能 CRUD」；第 2 步把它变成「**出错了看得见**」：
Vite/Nest 子进程输出、页面异常（含堆栈）都汇进日志面板，预览停了缓冲还在；
第 3 步把「要发布」的两块补齐了 —— **运行时 SDK**（异常上报 / 错误边界 / Nest 5xx 过滤器，源码分发进模板）
与**跨档数据迁移**（`pglite → postgres` 纯 JS 逻辑拷贝，零二进制依赖）。

**M3 完成**：模板里的每个 JSX 都带着 `data-tenon-loc` / `data-tenon-callsite`（编译期注入，只 dev 生效）；
在预览里**按住 Alt** 就能描边高亮，**Alt+点一下**把元素反查回 `src/App.tsx:25:3` 并跨源送回平台，
Composer 顶部出现一个可删除的上下文 chip，发送时一并交给 Agent。整条链路在 Electron 的真 Chromium
里跑通（`pnpm e2e:inspector` 13 项，父页面与网关**跨源**，token 与 origin 都是真校验）。
**回滚现在同时管代码和数据**：改动面板里能逐行看某一版改了什么，回滚默认只退代码；
动了表结构的那几版会自动存下库快照，勾上「连数据库一起回去」才会连数据一起退 —— 而且会先检查能不能做，
做不到就什么都不动（不会留下"代码退了、数据没退"的半成品）。

**能发布了**：顶栏「发布」把这个 commit 冻结成 `v<日期>-<n>`（annotated tag，说明进正文），
推到本地裸库 `~/.tenon/backups/<appId>.git` —— 标准裸库，`git clone` 出来就是这一版的完整代码。
`pnpm e2e:release` 用**系统 git 当裁判**（`fsck --strict` + `clone`）验收；产品运行时不依赖任何 git 二进制。
**而且现在发不出去坏东西**（M4 第 7 步）：打 tag 之前先跑应用自己的 `typecheck` 与 `test`，不过就拦下
（`RELEASE_CHECKS_FAILED`），被拒的发布连 tag 都不留、也不消耗版本号。判断是三态 —— 「这个应用没有
那项检查」放行并说明，「该检查的没检查成功」必拦。用户确实要发，可以点「仍然发布」（二次确认），
但记录里会标成 `带问题`，半年后查得出来。

**组件能装了**（M5 第 2 步）：应用里装了什么组件写在它自己的仓库里（`app.components.json`，跟着 git 走），
加载器按 `hub > bundled` 的覆盖层挑版本、逐条独立判定，装不上的原因（21 个稳定 code）原样返回给界面 ——
`component.list` 恒 200，插件页要能说清"它要求 Tenon ≥ 1.4.0，你是 1.2.0"。真组件（AI 小助手）是下一步。

**而且打开对话框就知道能不能发（预检 `release.check`）**：不用点了才知道。查一次是**真跑**
一遍（`tsc` + `pnpm run test`），所以界面上有转圈和已等秒数；查完什么都不留下 —— 不打 tag、
不写记录、不消耗版本号。三种结果长得不一样：前提不满足（工作区脏 / 没提交 / 正在生成）一句话
说清并置灰按钮、连检查都不跑；检查没过直接把清单摊开，主按钮是「重新检查」；检查通过是绿的。
还有一格 `stale`：检查期间仓库又前进了，那份「通过」讲的是上一版代码，界面会说「再查一次」
而不是「可以发」—— 拿 A 版的通过给 B 版背书，比不检查更糟。

**M5 开工了，但先撞了一遍地基（第 1 步：chord spike）**：组件体系整套押在 chord 上，所以先验它。
10 项全绿，同时撞出两条会静默坏事的约束 —— **对象默认 `lifetime:"referenced"`，root 一结束就连 state 一起销毁**
（组件不显式 `linger`，悬浮球/审批流每发一次请求进度就归零，还不报错）；**断链时调用会挂住**（静默丢帧、不发
close），所以 web facet 的每个调用都得自己带超时。好消息是打包没有坑：726KB 单文件、164ms、跑通，
不用像 pi-codemode 那样外部化。

**M4 第 1 步：能派活了**。Agent 不再只有一个大脑 —— 主角色（Builder）可以把「这个东西在哪」
「这个库怎么用」这类只读的活交给子角色，自己专心改代码。子角色是**真的另一个会话**（独立 transcript、
独立工具白名单、独立提示词），只读角色的工具集里连 `write` 都没有，`subagent` 自己也不在里面 ——
递归派活从工具集上就断了。角色没接好时它会明确回一句「还没接、缺什么」，而不是让模型去撞墙。

**也能看见它在跑（M4 第 2 步）**：预览下方多了一条「任务」。Agent 一开始跑它就出现，
展开是这棵树（层级用缩进，状态说人话）：

```
⌄ 任务  3  [1 个子会话]
● 主对话  等 1 个子任务
  ● 派活 Explore  执行中            派 #13
    ● Explore  等模型                #13
```

关键词是**实时**：`harness.watchTaskGraph()` 逐帧推，不是轮询。而且它**跑完就消失**——
pi 静止时会回收任务节点，所以"空"不是没数据，是没人跑了；要看"派过几次活"得查会话，不是这张图（§4.10）。

**看得见花了多少（M4 第 3 步）**：顶栏多了一个小数字 —— 点开是这个应用的账
（累计多少 token / 多少钱、这一轮多少、按模型分几档），以及额度表单。额度顶到线之后
**发都发不出去**（`BUDGET_EXCEEDED`），跑在中途冲过线会被当场掐掉（`budget.exceeded`）。
真值来自 `harness.usage()` 的会话账本：**跨重启不丢**，而且把子 Agent 与压缩摘要都算进去 ——
这两块恰恰是前端自己累加永远算不到的（§4.11 / DESIGN §5.6）。

**Agent 自己去验页面了（M4 第 4 步）**：e2e 子 Agent 有了五个预览工具
（`preview_read` / `preview_assert` / `preview_click` / `preview_type` / `preview_open`），
它**驱动的是用户眼前那个页面**：网关往 HTML 里注一行脚本，页面反连回来领命令
（HTTP 长轮询，不新起浏览器、不加依赖）。所以"改完的按钮点一下对不对"这件事，
现在有 DOM 里的证据，而不是靠读源码猜（§4.12 / DESIGN §5.7）。

**提交前也能叫人来审了（M4 第 5 步）**：主角色改完代码能派活给 reviewer，它只拿四个只读工具
加两个判据工具 —— `git_diff`（**工作区**对 HEAD，不是已提交版本：评审发生在提交之前）
与 `typecheck`（跑应用自己的 `tsc`，多 tsconfig）。回来是一份**最多五条、带 `path:line`
与修法的风险清单**，外加一句"查了什么、什么没查成"。关键在于它**不会把没查成说成没问题**：
缺 `node_modules`、缺 `tsconfig`、超时，三种都明说"没跑成"（§4.13 / DESIGN §5.8）。

**会写脚本了（M4 第 6 步）**：CodeAct 拿到一个 QuickJS 沙箱（`codemode`），**一次工具调用**就能
fan-out 读四十个文件、过滤、汇总，只有它 `text()` 出来的一行结论进上下文 —— 模型不会写循环，
这是唯一能把它当循环用的地方。边界是三层而不是一层提示词：会话里有哪些工具、工具能被谁调
（`callers`）、递给模型哪些（`modelTools` 只留 `codemode`）。所以脚本里 `tools.write` 调不动
不是提示词拦的，是它**根本没被注进沙箱**；`bash` 也没给 —— 命令一条条在转录里可审，
脚本里四十条命令只有脚本自己看得到（§4.14 / DESIGN §5.9）。

先跑这几条验证它还活着：

```bash
pnpm install && pnpm dev:web    # ★ 一条命令起界面：server + 前端，浏览器打开 http://127.0.0.1:5173
pnpm dev:desktop                # ★ 桌面版（同一份 server，Electron 只当壳）
pnpm test                       # 435 项单测 + 集成测试（约 190s，含 PGlite 冷启动与真 QuickJS）
pnpm smoke                      # 9 项端到端（真 spawn 进程，走 HTTP + SSE）
pnpm e2e:preview                # 16 项真机全链路：建应用 → 装依赖 → 起 Vite → 经网关打开 → 断言定位注入 → 改文件 → HMR（要联网）
pnpm e2e:inspector               # ★ 13 项精调链路：Electron 真 Chromium，父页面与网关跨源，模拟 Alt+Click（要联网）
pnpm e2e:diff                    # ★ 36 项改动链路：git.log / git.show / git.revert 全走真 HTTP（含根提交与错误码）
pnpm e2e:release                 # ★ 44 项发布链路：预检只读 → 门禁拦截 → 打 tag + 推本地裸库，用系统 git 做 fsck --strict 与 clone 验收
pnpm e2e:e2e                     # ★ 9 项自验收：真 Electron 里由 e2e 子 Agent 点页面 —— 注入的 bug 被断言抓到、修好后同一条断言通过
pnpm e2e:fullstack              # ★ 全栈真机链路：PGlite 起库 → 迁移 → Vite+Nest 双进程 → CRUD 经网关 → 重启后数据还在
pnpm pack:desktop               # 打包成 apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop:packaged     # 8 项桌面冒烟：真的起 .app、加载界面、退出后不留孤儿进程
```

- `packages/{protocol,core,agent,server,generator,gateway,db-provisioner}` 七个包已建；`pnpm typecheck` 全绿（15 个项目）
- 服务真起来了：Fastify 5 / 随机端口绑 `127.0.0.1` / Bearer Token / `/api/health` / `TENON_READY` 握手行
- `tenon.db`（`node:sqlite`）在建应用、写设置、存提供商密钥时真的落盘
- 每应用一个 `.tenon/harness.sqlite`，进程重启后 `resume()` 把中断的一轮**跑完**（有测试）
- SSE 增量 / `message.end` / `usage` / `app.status` 全链路打通；每轮结束自动 git 提交（无改动不产生空提交）
- **Agent 能真的写代码了**：`read` / `write` / `edit` / `bash` 四个工具已接到 pi-durable 注册表上，
  写完的文件进得了这一轮的 commit（`packages/agent/src/tools/coding.ts`）
- **能真的看到一个应用**：`app.create` 会用模板铺出可跑的工作区，`preview.start` 装依赖 + 起 dev server +
  挂到 App Gateway 后面，iframe 打开的就是它
- **有界面了**：`apps/web`（React 19 + Vite 7 + Tailwind 4）左栏会话 + 右栏 iframe，`pnpm dev:web` 一条命令起；
  浏览器里实测：建应用 → 自动起预览 → iframe 出现模板页 → 改 `repo/src/App.tsx` → **iframe 不刷新就变了**
- **能装成桌面应用了**：`apps/desktop` 主进程只做生命周期（spawn server → 读 `TENON_READY` → 开窗口），
  页面由 server **同源托管**并在 index.html 里注入 Token（不走 preload、不走 `file://`）；
  `pnpm pack:desktop` 出 `Tenon.app`（338MB），打包冒烟实测：窗口出界面 → 退出后子进程收干净
- **★ M2 第 1 步（应用有后端了）**：
  - `packages/db-provisioner`：`DatabaseProvider { start/stop/connectionString/dump/restore }`，
    `pglite` 档（默认，零安装）与 `postgres` 档（发布，Docker/外部/云）同接口；**`poolMax()` 恒为 1**
  - `templates/nest-api`：NestJS 11 + TypeORM + PG 方言 + zod 共享层；**迁移只写一份，两档同跑**
  - `preview.start` 从 1 个进程变 2 个（Vite + Nest），网关按最长前缀分流：`/api/*` → Nest，其余 → Vite
  - 生成应用只认 **`DATABASE_URL`**（+ `DATABASE_POOL_MAX` 这个容量参数），不判断任何运行环境
  - 桌面版不再依赖系统 `pnpm`：安装包自带（`Resources/server/node_modules/pnpm`）
- **★ M2 第 2 步（可观测：日志/错误面板）**：
  - `packages/gateway/src/logs.ts`：`LogStore` 环形缓冲（每应用隔离、1 秒内同句合并成 `repeat++`、上限截断）；
    `stripAnsi` 剥 Vite 输出的颜色控制序列（否则界面里全是 `[2m`）
  - 三个来源汇进同一面板：子进程 stdout/stderr（`vite` / `api`）、页面主动上报（`web`，经网关
    `POST /__tenon/log`，**不转发上游**）、平台自己的关键节点（`tenon` / `db`）
  - `app.log` SSE 事件 + `logs.list` / `logs.clear` RPC；**日志跟应用走不跟预览跑** —— 停了预览缓冲还在
  - 两个模板都装了 `tenon-log.ts`（`window.onerror` / `unhandledrejection`）+
    `tenon-boundary.tsx`（ErrorBoundary）—— **零新依赖**，上报走同源 fetch
  - 界面：`apps/web/src/features/logs/LogPanel.tsx`（折叠底栏、按来源筛选、错误高亮、详情展开、清空）
- **★ M2 第 3 步（能发布了）**：
  - `packages/runtime-sdk`（`@tenon/runtime`）：**源码分发** —— `sync-templates.mjs` 把
    `tenon-log.ts` / `tenon-boundary.tsx` / `tenon-logger.ts`（Nest 全局异常过滤器）拷进两个模板，
    漂移由测试逐字节拦住。生成应用仍然**零平台依赖**（铁律 2）
  - 跨档迁移 `migrateDatabase()`：两端走 PG 协议，`information_schema` 取表列、`pg_constraint` 取外键
    做拓扑排序、分批 `insert … on conflict do nothing`、**`setval` 对齐序列**、逐表 `count(*)` 校验
  - 日志面板增强：堆栈续行（`    at …`）并进上一条的 `detail`，不再碎成三十条
- **M2 剩余**：Docker compose 产物（**阻塞：本机无 Docker / podman / colima**）

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
| `docs/DESIGN.md` | **唯一事实来源**，v1.2.9，1700+ 行 | 写涉及架构的代码前，按需读对应章节 |
| **`docs/SPIKES.md`** | 五个 spike 的实测数字与结论（含被推翻的假设）| 碰 DB / pi / 网关 / 定位插件 / chord 前必读 |
| `docs/ARCHITECTURE.md` | 一分钟速览 + 四条原则 | 给别人介绍时 |
| `docs/PI-CHEATSHEET.md` | pi 全生态真实 API（读源码所得）| **写任何 pi 相关代码前必查**（比官方文档全）|
| `docs/PROTOCOL.md` | 妙搭行为规格（clean-room）| 不确定某个交互该怎么做时 |
| `docs/REVERSE_ENGINEERING.md` | 内部研究方法 | **已移出版本库**（本地保留，`.gitignore` 挡住）—— 之前"声明不随开源发布"但文件实际在公开仓库里，见 §4.45 |

`docs/reverse/`、`*.har` 已 gitignore，**不得提交**，也**不得把其中的代码/文案/提示词搬进产品**（clean-room 红线）。

---

## 4. 进度与下一步

### 4.1 spike（第一周 4 个 + M5 前置 1 个）—— ✅ **已全部完成**

| # | 验证什么 | 结果 |
|---|---|---|
| 1 | `pi-durable` 最小闭环：`Harness.open` + `submit` + 流式 + `resume()` | ✅ 10/10。**流式中途 SIGKILL → `resume()` 把同一提交从 `placed` 跑到 `done`** |
| 2 | App Gateway 代理 **Vite HMR WebSocket** | ✅ 8/8。HMR update **134ms**；上游换端口网关 URL 不变 |
| 3 | `data-tenon-loc` 在 JSX 上准确对应 `file:line`（经组合组件） | ✅ 7/7。改为 `loc`（原生）+ `callsite`（组合组件）双属性，9/9 可回溯 |
| 4 | **`PGlite + pg-gateway + TypeORM`** 稳定性与 P95 | ⚠️ **有条件通过**：20 并发 P95 14ms(读)/24ms(写)、零超时；但 **`pool.max>1` 会让并发事务互相回滚 → 必须为 1** |
| 5 | **chord 宿主接入**（M5 前置，2026-11-02）：契约 / 变体 / 跨 host / 热重载 / 打包 | ✅ 10/10。**默认 `lifetime:"referenced"` 会让 state 随 root 静默归零 → 组件必须 `linger`**；断链调用会挂住；单文件打包 726KB 无坑 |

详细数字、可复跑命令、被推翻的假设：**`docs/SPIKES.md`**。

### 4.2 主干（按依赖顺序）

**M1 骨架与对话**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | monorepo 骨架（workspace / tsconfig / vitest） | ✅ | `packages/*` 四个已建；`generator`、`db-provisioner`、`runtime-sdk`、`ui`、`component-host` 与 `apps/*` 随对应步骤建 |
| 2 | server 起来（Fastify 5 / 随机端口 / Token / health） | ✅ | `packages/server/src/{app,bin,index}.ts` |
| 3 | `tenon.db`（`node:sqlite`，5 张表） | ✅ | `packages/core/src/{db,stores/*}.ts` |
| 4 | harness 池（每应用一个 sqlite，`resume()`） | ✅ | `packages/agent/src/harness-pool.ts` |
| 5 | SSE 对话链路（`chat.submit/stop/history`） | ✅ | `packages/agent/src/chat.ts` + `packages/server/src/sse.ts` |
| 6 | Git 自动提交（isomorphic-git，trailer） | ✅ | `packages/core/src/git.ts` |
| 6.5 | **工具层**：read/write/edit/bash 接进 pi-durable（cwd 钉在 `repo/`、越界拒写、环境洗净） | ✅ | `packages/agent/src/tools/coding.ts` |
| 6.6 | **生成器**：`templates/react-vite` 铺进 `repo/`，与首次 commit 同一个动作 | ✅ | `packages/generator/` |
| 7 | **预览**：App Gateway + dev server 编排（`preview.start/stop/status` + `preview.status` 事件） | ✅ | `packages/gateway/` |
| 8 | **组件热重载不丢状态（DoD ③）+ 端到端验收（DoD ①）** | ✅ 见 §4.26（`pnpm e2e:component` 5/5） | `scripts/e2e-component.ts` |
| 9 | **Electron 壳** + 同源托管 + 打包冒烟 | ✅ mac 实测（win 待 M6 有机器时补） | `apps/desktop`（main/supervisor/paths + build.mjs）、`packages/server/src/static.ts` |

**M1 完成**：界面上点「新建应用」→ 铺模板 → 自动起预览 → 在对话里说需求 → Agent 改代码 → iframe 热更新 →
关掉窗口、双击 `Tenon.app` 再来一次，数据都在。
`data-tenon-loc` 的编译期注入当时留到了 M3 —— **已在 M3 第 1 步落地**（Babel 插件，源码分发进模板）。

**M2 全栈生成**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **两档数据库供给**：`DatabaseProvider` 接口 + `pglite`/`postgres` 两档 + 按 appId 缓存 | ✅ | `packages/db-provisioner/src/{types,pglite,postgres,manager}.ts` |
| 2 | **全栈模板**：NestJS 11 + TypeORM + PG 方言 + zod 共享层，迁移只写一份 | ✅ | `packages/generator/templates/nest-api/` |
| 3 | **双进程预览**：Vite + Nest，网关按 `/api/*` 最长前缀分流，三端口先占后告诉 | ✅ | `packages/gateway/src/{api,child,preview}.ts` |
| 4 | **全栈端到端**：建应用 → 起库 → 迁移 → 双进程就绪 → CRUD 经网关 → 重启数据还在 | ✅ | `scripts/e2e-fullstack.ts` |
| 5 | 桌面版自带包管理器（不再依赖系统 `pnpm`） | ✅ | `packages/gateway/src/deps.ts` + `apps/desktop/{build.mjs,electron-builder.yml}` |
| 6a | **日志/错误面板**：LogStore + 三来源汇流 + `app.log` SSE + 模板侧零依赖上报 | ✅ | `packages/gateway/src/logs.ts`、`apps/web/src/features/logs/LogPanel.tsx`、模板 `src/tenon-{log,boundary}` |
| 6b | **runtime SDK**：`@tenon/runtime` 源码分发（异常上报 / 错误边界 / Nest 过滤器）+ 漂移测试 | ✅ | `packages/runtime-sdk/`（`src/browser`、`src/nest`、`scripts/sync-templates.mjs`） |
| 7 | **跨档迁移**：`pglite → postgres` 纯 JS 逻辑拷贝（原 `pg_dump` 方案因用户机器无二进制而废弃） | ✅ 逻辑 + **真 PG** 都已实测（§4.40，`e2e:postgres`） | `packages/db-provisioner/src/migrate.ts` |
| 8 | **Docker 构建上下文**（不做多阶段：静态包已构建过 + `postgres:18-alpine`） | ✅ §4.39（`e2e:docker` 21 项真跑 compose） | `packages/server/src/export.ts` 的 `renderDockerfile` / `renderCompose` |

**M3 精调与版本**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **编译期源码定位注入**：Babel 插件给原生标签标 `data-tenon-loc`、给组合组件标 `data-tenon-callsite`（callsite 优先，`loc` 留作 secondary）；只 dev 生效 | ✅ | `packages/runtime-sdk/src/vite/tenon-loc.ts` → 模板 `src/tenon-loc-plugin.ts` + `vite.config.ts` 的 `react({ babel: { plugins } })` |
| 2 | **反查解析器**：DOM 元素 → `{file,line,column,kind}`，`kind` 区分 usage / element / component-impl，自身没属性向上找 | ✅ | `packages/runtime-sdk/src/browser/tenon-loc.ts` → 模板 `src/tenon-loc.ts` |
| 3 | **inspector 交互**：Alt+Hover 描边+跟随标签、Alt+Click 选中、Alt+Drag 框选（只收最内层，上限 50）、ESC 退出；overlay `pointer-events:none`；capture 阶段吃掉 click | ✅ | `packages/runtime-sdk/src/browser/tenon-inspector.ts` → 模板 `src/tenon-inspector.ts`（dev 动态 import，生产被摇掉） |
| 4 | **跨源回传**：iframe hash 带 token → `postMessage` → 父窗口校验 `origin` + `source` + `token` → Composer 顶部 chip → `chat.submit` 带上 `selection` | ✅ | `apps/web/src/lib/selection.ts`、`hooks/useInspectorSelection.ts`、`packages/protocol/src/selection-text.ts` |
| 4.5 | **送到 Agent**：拼成 `[TENON-SELECTION] {json}` 首行（`pi-durable` 的 submit 只吃纯文本），渲染用户气泡时用 `stripSelectionBlock` 剥回原文 | ✅ 链路已通；"改样式并自验"仍需真模型（faux 做不到） | `packages/agent/src/chat.ts`、`MessageList.tsx` |
| 5 | **真机 e2e**：Electron 开真 Chromium，父页面在**另一个源**，模拟 Alt+Click，用平台自己的校验函数过一遍 | ✅ | `scripts/e2e-inspector.ts`（`pnpm e2e:inspector`，12 项） |
| 6 | **Diff 视图**：`git.show` 返回逐文件、逐行的结构化差异（两侧行号、`binary`/`truncated` 标记）；面板覆盖在预览之上（iframe 不卸载），左侧版本列表、右侧折叠上下文的逐行着色 | ✅ | `packages/core/src/git.ts` 的 `showCommit` / `buildDiff`、`apps/web/src/features/diff/DiffPanel.tsx`、`lib/diff.ts` |
| 7a | **代码回滚**：`git.revert` 产生反向提交（历史保留），两步确认，回滚后自动停在回滚提交上 | ✅ | `apps/web/src/hooks/useWorkspace.ts` 的 `revertCommit`、`DiffPanel` 的确认态 |
| 7b | **回滚的数据侧**：改过 schema 的 commit 自动存库快照 + `dbRestore` 可选还原 | ✅ 见 §4.7 | `packages/db-provisioner/src/manager.ts`、`packages/server/src/revert-data.ts` |
| 8 | 真机 e2e：三条 git RPC 全部走真 HTTP（含根提交、错误码映射） | ✅ | `scripts/e2e-diff.ts`（`pnpm e2e:diff`，36 项） |
| 9 | **发布 push**：打 annotated tag（版本说明进正文）+ 镜像到本地裸库 `~/.tenon/backups/<appId>.git` + 记 release；闸门是「不在生成中 / 有提交 / 工作区干净」，推送失败删 tag | ✅ 见 §4.8 | `packages/core/src/release.ts`、`packages/server/src/release.ts`、`features/release/ReleaseDialog.tsx`、`scripts/e2e-release.ts` |

**M4 多 Agent 与可观测增强**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **子 Agent 骨架**：角色表（1 主 + 5 子，工具白名单/档位/提示词/可用状态）+ `subagent` 工具（真子会话、幂等复用、递归禁止）+ `ls`/`glob`/`grep` 只读检索 + faux 按角色分道 | ✅ 见 §4.9 | `packages/agent/src/roles.ts`、`tools/subagent.ts`、`tools/search.ts`、`models.ts`（分道）、`harness-pool.ts`（注入 harness） |
| 2 | **任务图**：`watchTaskGraph` 逐帧归一化 → `taskgraph.update` 事件 + `taskgraph.get` RPC + 预览下方任务条（DoD ②） | ✅ 见 §4.10 | `packages/core/src/taskgraph.ts`、`packages/agent/src/taskgraph.ts`、`features/tasks/TaskGraphPanel.tsx` |
| 3 | **用量与预算**：`harness.usage()` 会话账本 → `usage.update` 全量快照 + `usage.get`/`budget.set` RPC + 顶栏用量面板 + 两个拦截点（开跑前 402 / 半路 abort，DoD ③） | ✅ 见 §4.11 | `packages/core/src/usage.ts`、`packages/agent/src/usage.ts`、`packages/protocol/src/usage-format.ts`、`features/usage/UsagePanel.tsx` |
| 4 | **E2E 子 Agent 的预览工具**（`preview_read/assert/click/type/open`）+ 自验收流程（DoD ①） | ✅ 见 §4.12 | `packages/gateway/src/page.ts`（页面通道）、`packages/agent/src/tools/preview.ts`、`scripts/e2e-e2e-agent.ts` |
| 5 | Reviewer：`git_diff` + `typecheck` 工具，出风险清单 | ✅ 见 §4.13 | `packages/core/src/git.ts`（`worktreeDiff`）、`packages/core/src/typecheck.ts`、`packages/agent/src/tools/review.ts` |
| 6 | CodeAct：`codemode` 沙箱接入 | ✅ 见 §4.14 | `packages/agent/src/tools/codeact.ts`、`packages/agent/src/roles.ts`（`modelTools`）、`apps/desktop/build.mjs`（外部化 + `assertCodemodeLayout`） |
| 7 | **发布前质量门禁**：`typecheck` / `test` 不过不许发（三态判据、`force` 留痕、迁移 2 加两列）；预检 `release.check` 见 §4.16 | ✅ 见 §4.15 | `packages/agent/src/checks.ts`、`packages/server/src/release.ts`、`packages/core/src/pnpm.ts`、`packages/core/src/db.ts`（迁移 2） |

**M5 组件体系（官方内置定型）**

| # | 步骤 | 状态 | 落在哪 |
|---|---|---|---|
| 1 | **chord 宿主接入 spike**：契约 / 变体 / 跨 host / 热重载 / 打包（10 项） | ✅ 见 §4.17 | `spikes/chord/` |
| 2 | **bundled 插件加载器**：`resources/plugins/<id>/` 只读源 + 清单（依赖/权限/宿主兼容）+ 装配声明 `app.components.json` + `component.list` | ✅ 见 §4.18 | `packages/component-host/`、`plugins/bundled/`、`apps/desktop/src/{paths,main}.ts`、`apps/desktop/{build.mjs,electron-builder.yml}` |
| 3a | **第一个真组件（服务端半边）**：契约 + server facet + 插件构建 + 宿主装载 + 注入的模型能力 | ✅ 见 §4.19 | `plugins/bundled/tenon.official.ai-assistant/`、`scripts/build-plugins.ts`、`packages/agent/src/assistant.ts`、`packages/server/src/components.ts` |
| 3b | **第一个真组件（界面半边）**：web facet + 传输（WS 链路）+ `app.shell.overlay` 插槽渲染 | ✅ 见 §4.21（浏览器里的整页验收放到第 8 步） | `packages/gateway/src/components.ts`、`packages/server/src/components-link.ts`、`plugins/bundled/tenon.official.ai-assistant/web.ts` |
| 4 | **`install_component` 工具**：写装配声明 + 同步 `docs/AGENTS.md` + 装完立刻生效（不生成 `components.generated.ts`，见 §4.22） | ✅ 见 §4.22 | `packages/component-host/src/{install,agents-doc}.ts`、`packages/agent/src/tools/components.ts`、`packages/server/src/index.ts` |
| 5 | **卸载即清理**（声明 + `AGENTS.md` + 仓库零残留引用，幂等；DoD ②） | ✅ 见 §4.23 | `packages/component-host/src/install.ts`（`uninstallComponent`）、`packages/agent/src/tools/components.ts`（`remove_component`）、`packages/server/test/component-uninstall.test.ts` |
| 6 | **插件页**：列表 / 独立开关 / 来源标识 / "官方 Hub 筹备中"占位（DoD ④） | ✅ 见 §4.24 | `apps/web/src/features/plugins/PluginsPanel.tsx`、`component.setEnabled`（protocol + server + `setComponentEnabled`） |
| 7 | 另两个官方插件（**导出 CSV** / 审批流）+ L1 内置积木清单 | ✅ 见 §4.25 | `plugins/bundled/tenon.official.{csv-export,approval}/`、`plugins/bundled/README.md`（L1 清单） |
| 8 | 组件热重载不丢状态（DoD ③）+ 端到端验收（DoD ①） | 🚧 脚本就位（`pnpm e2e:component`），卡在真页面里球没出现，见 §4.26 | `scripts/e2e-component.ts` |

### 4.3 M1 验收（DoD）

- [x] `pnpm dev:web` 打开即可对话 —— 浏览器实测：建应用 → 发消息 → 流式回来 → 自动 git 提交 → 版本数 +1
- [x] 生成一个纯前端 Todo 应用，iframe 里热更新生效 —— 模板铺得出、dev server 起得来、网关打得开；
      **浏览器里实测**：改 `repo/src/App.tsx` 的 `<h1>` → iframe 里的标题当场变，页面没有整页刷新（计数不归零）。
      `pnpm e2e:preview` 另有 14 条机器人断言（含「HMR 推送指向刚改的模块」）。**真正"Todo 应用"要等接真模型**
- [x] 每轮对话产生一个 git commit —— `chat.ts` 每轮结束调 `commitAll`；**本轮没有文件改动时不产生空提交**。
      工具层接上后已能真的产出 commit（`tools.test.ts` 断言：建应用 1 个 + 写文件那轮 1 个）
- [x] 杀进程重启后，对话与任务能续跑（`resume()`）—— `packages/server/test/chat.test.ts` 的「崩溃续跑」用例：生成中途关进程 → 重启 → 这一轮自己跑完（403ms）
- [x] 打包成桌面应用并双击可用 —— `pnpm pack:desktop` 出 `Tenon.app`（x64，338MB）；
      `pnpm smoke:desktop:packaged` 八项全过：**窗口加载的是渲染器（标题「Tenon · 榫」）**、拿到了注入的 Token、
      不落错误页、退出后 server 真的停了（端口没人听）。`build.mjs` 扫 `dist/` 做原生模块审计（v1.2.13 起只报不拦）

### 4.4 M2 第 1 步验收（DoD）—— ✅ 已完成

- [x] 生成的应用默认带库 —— `app.create` 建 `nest-api` 模板时 `DatabaseManager.acquire()` 起一个 PGlite，
      数据目录落 `~/.tenon/apps/<id>/pgdata`（38MB），**零安装、无原生模块**
- [x] **两档跑同一份迁移** —— `api/migrations/1767225600000-InitItems.ts` 只有一份；
      `pnpm e2e:fullstack` 实测 `health.db.version === 'PostgreSQL 18.6'`、迁移数 ≥1
- [x] `pool.max` 真的是 1 —— 从 Nest 侧驱动实例读回 `driver.master.options.max`，断言 `=== 1`。
      不是"文档写了 1"，是**真的传到了 `pg.Pool`**
- [x] 双进程经同一网关 —— `readiness` 四格（db/server/preview/api）全 ready，`apiPort` 非空，
      `gatewayPort === url 的端口`；`GET /api/items` 走 Nest、`GET /不存在的路径` 不回落成前端 HTML
- [x] 切换库只改连接串 —— 生成应用侧只出现 `DATABASE_URL` / `DATABASE_POOL_MAX`，
      **模板里搜不到 `NODE_ENV` / `TENON_*`**（有测试逐文件断言）
- [x] 重启不丢数据 —— 停预览 → 再起（1474ms，比首次 9711ms 快，pgdata 复用）→ 之前写的行还在
- [x] 桌面版不再要系统 pnpm —— `deps.ts` 优先找 `<Resources>/server/node_modules/pnpm/bin/pnpm.cjs`，
      打包后实测能起预览

### 4.5 M2 第 2 步验收（DoD，日志/错误面板）—— ✅ 已完成

- [x] 子进程输出进面板 —— `vite` / `api` 两个来源各有日志；**tsc 编译报错也归 `api`**
      （它同样意味着"后端起不来"）
- [x] ANSI 已剥掉 —— Vite 的彩色输出在界面里是纯文本（`stripAnsi`，有单测）
- [x] 页面异常带着堆栈上报 —— `window.onerror` / `unhandledrejection` / ErrorBoundary 三条路
      → 同源 `POST /__tenon/log` → 网关拦下（**不转发上游**）→ 面板里看到 `message + detail`；
      `pnpm e2e:fullstack` 实测：人为 throw → `logs.list` 拿得到且 `detail` 含堆栈
- [x] 上报端点回 204 —— 不落上游、不报错、不污染应用自己的 API
- [x] 停预览后日志还在 —— `LogStore` 跟应用走不跟预览跑；`app.delete` 才连缓冲一起丢（`forget()`）
- [x] 同句重复不刷屏 —— 1 秒内同一条合并成 `repeat++`，**合并后照样推**（id 不变，前端按 id upsert
      → 界面上是一条 ×N，不会跳行）
- [x] 零新依赖 —— 两个模板的上报实现不引任何包（纯 fetch + 原生事件），不破"锁版本"铁律

### 4.6 M2 第 3 步验收（DoD，能发布的那两块）—— ✅ 已完成（Docker 产物除外）

- [x] **运行时 SDK 成为唯一事实来源** —— `packages/runtime-sdk` 的 `src/browser/tenon-log.ts`、
      `src/browser/tenon-boundary.tsx`、`src/nest/tenon-logger.ts` 是原件；`scripts/sync-templates.mjs`
      把它们拷进两个模板；`test/sync.test.ts` **逐字节**比对，改一边忘另一边直接测试红
- [x] **生成应用仍然零平台依赖** —— 副本是普通 `.ts`/`.tsx` 文件，应用不 import `@tenon/runtime`、
      不认任何 `TENON_*`（导出成 Docker 也装得起来，铁律 2）
- [x] **Nest 侧 5xx 有格式** —— `TenonLoggerFilter` 全局挂上（`APP_FILTER`）：5xx 打一行摘要 + 堆栈、
      4xx 打一行 warn；`pnpm e2e:fullstack` 实测日志里有 `4xx POST /api/items → 400`（**认字面格式**，
      不是"有日志就算过"）
- [x] **全局过滤器不会把请求挂死** —— `@Catch()` 接管分发权后必须自己补响应；
      单测断言 4xx/404/500 三种情况的状态码与响应体（500 不回显内部错误）
- [x] **跨档迁移数据零丢失** —— `migrateDatabase()` 10 项实测：外键顺序（父表先插）、布尔/时间戳/
      生成列/`jsonb` 原样搬、**序列 `setval` 后新插入不撞主键**、目标缺表明确报错、可重跑
      （`on conflict do nothing`）、进度回调、TypeORM 生成的真表也认
- [x] **零二进制依赖** —— 不用 `pg_dump`/`pg_restore`/`psql`（本机与用户机器都没有）。
      两端都是 PG 协议连接，纯 SQL
- [x] **面板里的堆栈不再碎成一堆行** —— `LogStore.addLine` 把 `    at …` 续行并进上一条的 `detail`
      （id 不变 → 前端 upsert → 界面上还是一条，点开能看全栈）
- [ ] **Docker compose 产物** —— ⛔ 阻塞：本机无 `docker`/`podman`/`colima`，无法"构建并跑起来"。
      DoD ④ 不能靠猜收口，故**不产出未验证的 Dockerfile**

### 4.7 M3 第 7b 步验收（DoD，回滚的数据侧）—— ✅ 已完成

- [x] **只在改过 schema 的提交上存快照** —— 判据是路径约定（`api/migrations/**`、`*.entity.ts`、
      `shared/schema.ts`），写在 `@tenon/core` 的 `schema-change.ts` 里。7 条测试钉住正例与**反例**
      （`migrations/README.md`、`item.entity.spec.ts`、`src/pages/user/schema.ts` 都不该触发）。
      用路径不用"扫 SQL 关键字"：后者要猜方言，还会被字符串里的 `CREATE TABLE` 误伤
- [x] **快照按 commit sha 归档** —— `exports/db/<sha>/db.tar.gz`。按时间戳命名就得再存一份
      "文件 ↔ 提交"的映射，两份迟早对不上
- [x] **库不存在时不存** —— 返回 `null` 而不是存一份空库。空库快照会让"有快照"变成骗人的信号
      （测试断言连 `pgdata` 目录都不该被顺手造出来）
- [x] **存完把库按原状放回去** —— 原本 stopped 的存完还是 stopped；原本 ready 的保持 ready。
      否则每提交一次就泄漏 38MB
- [x] **★ 还原之后表结构与数据都回到那一刻** —— 真 PGlite 实测：快照后 `alter table add column`
      + 再插一行 → restore → 新列没了、只剩快照时的那行数据
- [x] **★ 运行中打快照不会卷入未提交事务** —— 开事务插一行不提交 → 打快照 → rollback → restore，
      结果里只有已提交的那行。PG 的 WAL + xid 机制本该防住，但"本该"不是证据
- [x] **`git.revert` 的 `dbRestore`（默认 false）** —— 返回 `data: { requested, restored, fromSha,
      skippedCommits }`，前端据此说清"退到了哪一版"而不是假装精确
- [x] **★ 顺序是「检查 → 还原数据 → 回滚代码」** —— 覆盖库不可逆、回滚代码可逆。`e2e:diff` 实测：
      带 `dbRestore` 但没有快照时抛 `DB_SNAPSHOT_MISSING`，**提交数不变、迁移文件还在**
      （不会留下"代码回滚了、数据没回滚"的半成品）
- [x] **`skippedCommits` 的语义** —— 从"目标的父提交"到"实际用的那份快照"之间隔了几个提交。
      6 条单测钉住偏移（父提交命中 = 0，退到祖父 = 1），错这个不会报错、只会悄悄多丢几轮数据
- [x] **档位不匹配明确拒绝** —— 拿 PGlite 的 tar.gz 去 `pg_restore` 只会得到一句天书
- [x] **UI**：勾选框默认**不勾**，文案带"会丢弃该时点之后写入的数据"；只有改过 schema 的版本才显示；
      还原后自动重起预览（服务端为免刷一屏断连错误先把它停了）

**没做的**（写在这里而不是假装做了）：`postgres` 档仍走 `pg_dump --format=custom`，缺二进制时明确报
`DB_UNSUPPORTED`。原来的计划是"用临时库 + 逻辑拷贝绕开 `pg_dump`"，v1.2.13 放开原生模块之后
这条**不需要了**，但也不该顺手接上 —— `pg_dump` 的版本必须不低于服务端版本，而发布档连的是
用户自己的云 PG（DBeaver 里有 13/14/15/16/17/18 各种），打包一份 18 的二进制去连 19 的库照样失败。
发布档的数据回滚，云厂商的 PITR 才是正解。

> 快照会累积：每个改过 schema 的提交一份，`pglite` 档一份约 4~5MB。**暂未做清理策略** ——
> 一个应用聊五十轮也不可能触发五十次，等真出现容量问题再加 LRU。`app.delete` 时随目录一起删。


### 4.8 M3 第 9 步验收（DoD，发布 push）—— ✅ 已完成

- [x] **版本号是 `v<yyyy.MM.dd>-<n>`，同日递增** —— `nextVersion()` 是纯函数（5 条单测钉住：
      当天首个 `-1`、同日递增、**别的日期的 `-9` 不影响今天**、不认识的字符串直接忽略、形状不精确就不认）
- [x] **版本号同时参考发布记录与仓库 tag** —— 只信一边都会撞号：记录被删过、或备份库是从别的机器拷来的
- [x] **tag 是 annotated 且带发布说明** —— `git cat-file -t vX` 返回 `tag`（不是 commit），
      `git cat-file -p vX` 能看到正文里的说明。轻量 tag 在 `git show` 里什么也没有，
      把备份库交给别人时版本说明就丢了
- [x] **★ 备份库是标准裸库，`git clone` 能直接用** —— e2e 请系统 git 当裁判：`fsck --strict` 通过
      （没有 missing / could not be parsed）、`rev-parse --is-bare-repository` 为 true、
      clone 出来的工作区 `status --porcelain` 干净、`log` 历史条数对得上
- [x] **★ 旧版本标签不被改写** —— 发第二版之后，`git cat-file -p <第一版 tag>:src/notes.md`
      仍然是第一版的内容（发布是**冻结**，不是覆盖）
- [x] **重复发布只写增量** —— 第二次镜像 `objects` 数为 0（已存在的对象跳过）；
      改一轮再发只写那几个新对象。备份库不会随发布次数膨胀成 N 份全量
- [x] **闸门：不在生成中** —— `app.status === 'running'` 时 `APP_BUSY`。生成中途发布 = 发一份写了一半的代码
- [x] **闸门：工作区必须干净** —— `GIT_DIRTY_WORKTREE`，错误里点名具体文件（`message` 带文件名、
      `details.paths` 带前 50 个），不是一句"有未提交改动"
- [x] **闸门：仓库必须有提交** —— `RELEASE_NO_COMMITS`，且**不留下空备份库**（e2e 断言
      `backups/<id>.git/HEAD` 不存在）
- [x] **★ 推送失败时把 tag 删掉** —— 否则留下"有 tag、没记录"的半成品：下次发布直接跳到 `-2`，
      用户会以为少发了一版。集成测试用一个「备份库路径是个普通文件」的场景逼出这条
- [x] **UI**：顶栏「发布」→ 对话框显示这一版是哪条提交、可选发布说明（进 tag 正文）、
      成功后给出**备份库路径与 `git clone` 命令**（都能一键复制）+ 发布历史列表。
      错误就地显示在对话框里（"工作区还有没提交的改动"离开上下文就没意义）

**没做的**（写在这儿而不是含糊过去）：

- **推到真正的远端**（GitHub / GitLab / Gitea）：isomorphic-git 的 `push` 只走 HTTP 传输，
  要凭据也要真网络，本机无法验证。接的时候是加一个 transport，不是重写发布流程
- **Docker 产物 / 静态包导出**：前者阻塞在"本机无容器运行时"，后者要跑 `vite build` 再打包产物
- **质量门禁**（lint / typecheck / 测试）：现在只查"有提交"与"工作区干净"

> 备份库会累积：一个应用一个裸库，每次发布写增量对象。**单个应用内的历史没做清理** —— 生成应用是
> 几十个文本文件，几十轮也就几 MB，不值得为它写一套 GC。但**应用删除时备份库会一起删**（§4.36）：
> 应用不存在之后界面上没有任何入口能 clone 它，留着就是一个没人能访问、却占着完整历史的孤儿目录。

> 已知欠账：~~Docker compose 产物（M2 第 8 步）~~ → 已落地（§4.39）；
> ~~`pglite → 真 PG` 的迁移端到端~~ → 已落地（§4.40，`e2e:postgres` 31 项）；
> `pnpm e2e:fullstack` 未进 CI（要联网装 NestJS）。
>
> ~~`SelectionContext.screenshot` 字段留了没填~~ —— **这条是错的，已删**：协议里
> `SelectionContext` 根本没有 `screenshot` 字段（`kind` / `route` / `loc` / `selector` /
> `rect` / `text` / `styles` / `elements` / `viewport`）。当初大概是想过"截图给 Agent 看"，
> 但落地时选了**结构化描述**（定位 + 文本 + 差异样式）而不是像素 —— 这更省 token，也更准。
> 留着这句会让人去找一个不存在的缺口。
>
> **7b 的覆盖缺口（如实记）**：三条路径各自都验了 —— 库快照与还原用真 PGlite（`snapshot.test.ts`）,
> preflight 失败时"什么都不动"用真 HTTP（`e2e:diff` 第 10 节）,`skippedCommits` 的偏移用纯函数单测。
> **没验的是成功路径的完整串联**：`preview.stop → restoreDatabase → gitops.revert` 三者按序执行的
> 端到端（要真起预览装依赖，60s+，没进 CI）。手工验法：建一个全栈应用 → 让 Agent 加一列 →
> 录两行数据 → 在改动面板点那一版、勾上「连数据库一起回去」→ 确认新列消失、只留快照时那行。

### 4.9 M4 第 1 步验收（子 Agent 能派活）—— ✅ 已完成

- [x] **角色表是唯一事实来源** —— `role.tools` 全是全量表里的真名字（拼错会静默给空工具集），
      有单测逐角色比对；`builder` 不可被派活，五个子角色的 `tools` 里都没有 `subagent`
- [x] **白名单真的拦得住写工具** —— `explore` 拿到的只有 `read` / `ls` / `glob` / `grep`；
      就算有人手滑把 `subagent` 写进角色的 tools，`toolsForRole()` 也会剔掉它（有测试造了这个场景）
- [x] **★ 子 Agent 是真的另一个会话** —— 集成测试 `scanConversations` 数出两个会话，
      再从子会话的 `agent.tools` 读回工具名：只有四个只读工具，`cwd` 指向同一个 `repo/`，
      `instructions` 是角色自己的（不是父会话的）
- [x] **★ 派生一次 = 一个 task 作用域的会话** —— 同一轮派两次活得到两个不同的 `conversationId`
      （`ownerTaskId` 是这次工具调用的 task，不是根会话）；幂等复用只发生在崩溃重跑时
- [x] **递归派活在两层上断掉** —— `role` 是字面量枚举，`builder` 在 schema 层就被拒（模型看得到它错在哪）；
      工具自己还有一层"没有这个子角色"的兜底（重放老输入时会走到）
- [x] **没接好的角色明确回"还没接、缺什么"** —— `e2e` 的报错文本里带着要等的 `preview` 工具；
      不做这件事的话，模型会开始自己猜文件内容
- [x] **一轮一 commit 没被打破** —— 子 Agent 只读 → 这一轮没有文件变化 → **不产生空提交**（测试断言只有建应用那一个）；
      子 Agent 也无法改动工作区（测试前后比对 `package.json` 字节一致）
- [x] **子 Agent 的结论带子会话编号** —— `Explore 的结论（子会话 #13）：…`，出了问题能顺着编号去查 transcript
- [x] **faux 能演示完整链路** —— 剧本按角色分道（`script([{...} as 'explore'])`），
      父轮与子轮各走各的队列；不做这件事时子会话会把父轮收尾的台词吃掉
- [x] **只读检索是自己的实现** —— `ls` / `glob` / `grep` 走 `node:fs` + 进程内正则，
      有上限（100 条默认 / 单文件 512KB / 扫 4000 文件 / 单行 300 字符），跳过 `node_modules`、`dist`、`.git`，
      越界路径三个工具都拒（各有测试）

使用方式：主角色在需要"这个东西在哪"时调 `subagent({ role: 'explore', task: '…' })`。
**还没做的**（如实记）：用量/预算、`codeact` / `e2e` / `reviewer` 三个角色的工具。
（"看不到子会话在跑"这一条已在 §4.10 补上。）

### 4.10 M4 第 2 步验收（任务图）—— ✅ 已完成

- [x] **★ 派活那一轮里，图里真的出现子会话节点** —— 集成测试从 SSE 里挑出 `scope: 'delegated'`
      的 generation 节点：它跑在子会话 `#13` 上，`role` 是 `explore`，`kind` 是 `generation`
- [x] **角色是读出来的，不是猜的** —— `tasksNeedingRole()` 只挑「工具 task 且已拥有会话」的那些
      （那一瞬间 `checkpoint.arguments` 一定齐）。结果按 task id 缓存，**含"查过但没有"** ——
      否则每帧都去查一次数据库
- [x] **会话树接进任务树** —— 子会话里的 generation 在 pi 眼里没有 `owner`，显示上 `parentId`
      指回派它的那个工具 task（单测断言 `child.parentId === tool.id` 且 `tool.spawned` 含子会话 id）
- [x] **父在子前、同层按数值序** —— 字典序会把 `10` 排在 `9` 前面；有单测钉住这条
- [x] **★ 跑完就是空图** —— 事件流最后一帧是 `nodes: []`，`taskgraph.get` 也是空。
      这条是**刻意固化**的认知：不能拿它当派活历史，UI 也因此不攒快照
- [x] **空闲时不占地方** —— `TaskGraphPanel` 在图空时返回 `null`；截图验了折叠与展开两态
      （1440×900：三行缩进正确、`派 #13` 与 `#13` 对齐、无重叠无截断）
- [x] **没有派活的一轮也有帧** —— 主对话自己在跑也是任务（只有 generation 节点，全部 `scope: 'root'`）
- [x] **切应用不会串台** —— 归约里比对 `event.appId`：上一个应用的帧晚到时不会画到当前应用上
- [x] **`chat.submit` 之前就把 watch 挂上** —— 否则"没切过布局就直接提交"会漏掉这一轮的全部帧；
      `app.delete` 时先 `release` 任务图再关 harness（顺序反了会踩到已关闭的 session）

使用方式：Agent 一开始跑，预览下方就出现「任务 3 / 1 个子会话」；点开看谁在跑、跑到哪一步。

### 4.11 M4 第 3 步验收（用量与预算熔断）—— ✅ 已完成

- [x] **★ 账本是"会话级真值"，不是前端累加** —— 集成测试断言：跑完一轮 `totals.totalTokens > 0`，
      且 `models` 桶的键是 `provider/modelId`（`faux/faux-mini`）。前端一条 delta 都没在累加
- [x] **★ 跨重启不丢** —— 同一个 `TENON_HOME` 杀掉再起，`usage.get` 的数**一模一样**；
      "这一轮"归零（本轮是相对起点的差值）。只按内存计数器做的话这条必然挂
- [x] **钱和 token 两条线都能拦** —— `Budget = {maxCostUsd, maxTokens}`，任一条顶到就 `over`。
      集成测试一律用 token 验，因为 **`faux` 的 `cost.total` 恒为 0**（本地假模型不报价）——
      这也正是产品里两个维度都要的原因
- [x] **`>=` 而不是 `>`** —— "用满就是没有余额"；顺带钉住"上限设 0 = 这个应用不许再花"，
      写成 `>` 会让 0 变成"不设限"
- [x] **★ 开跑前就拦** —— 额度用完之后 `chat.submit` 抛 `BUDGET_EXCEEDED`（**402**），
      且应用状态没有被改成 `running`（测试断言 `app.list` 里还是 `idle`）
- [x] **★ 半路也能刹住** —— 给一个"刚好还差 1 token"的额度，再跑一轮四次模型调用的活：
      事件流里出现 `budget.exceeded`，而且**它必须在 `app.status: idle` 之前到**（先解释、再放开输入框）
- [x] **调高上限马上能用** —— 不需要重启，`budget.set` 之后同一个应用下一轮正常跑完
- [x] **没有额度时不会误触** —— 跑完整一轮也不出现 `budget.exceeded`
- [x] **横幅有两条来源** —— "跑到一半被掐"由 `budget.exceeded` 解释；而手动把上限调到低于已用量时
      没有任何人被掐，面板也得说一句（取 `stopped ?? snapshot.exceeded`）。只认事件的话，用户看到的
      只有一个红点，不知道自己现在发不出去（Electron 真截图验过这一态）
- [x] **额度跟着应用走** —— `app.delete` 之后 `budget.app.<id>` 这条设置也没了
- [x] **★ 删掉一个应用，别的应用还能跑** —— 这条钉住一个真 bug：`app.delete` 早先调的是
      `chat.close()`，那会把 `closed` 置上，之后**所有**应用的 `app.status` 都不再落库也不再推事件
      （界面永远转圈，日志里一个字都没有）。现在是 `chat.detach(appId)`
- [x] **读坏额度不会把应用锁死** —— 负数 / NaN 一律当"没设"（`readBudget`）；读账本抛错时沿用上一次的值。

使用方式：顶栏那个小数字点开就是账；额度表单留空 = 这条不设限。

**还没做的**（如实记）：额度没有跨应用的**总闸**（N 个应用各有一份额度，"这个月最多 20 美元"要再叠一层按月的账）；
`usage()` 只给按模型/工具的聚合，**看不出"哪个子角色花了多少"**（子会话的账在它自己的桶里，
要按角色分摊得自己扫会话读 `pi.usage`，现在没做）。

### 4.12 M4 第 4 步验收（e2e 子 Agent 的预览工具 / DoD ①）—— ✅ 已完成

- [x] **★ 子 Agent 能驱动真实浏览器里的页面，并拿到失败证据** —— `pnpm e2e:e2e`：
      真 Electron 打开模板页面 → e2e 角色 `preview_read` → `preview_click` →
      `preview_assert '计数 1'` 失败，**"实测"里的数字来自真 DOM**（注入的 bug 是 `+2`）
- [x] **★ 修完之后同一条断言通过** —— 主角色改 `App.tsx` → 整页重载（`preview_open`）→
      再点一次 → 断言通过。这条就是 DoD ① 的判据
- [x] **断言失败不是工具错误** —— 返回 `isError: false` + "✗ 期望 X，实测 Y"。
      当错误返回会让模型去重试工具，而它该做的是回去改代码（`preview-tools.test.ts` 钉住）
- [x] **faux 的诚实边界** —— 假模型不会推理，"发现"是剧本安排的；判据仍然来自真 DOM
      （断言失败时的实测值、修复后同一条断言才通过）。接真模型后剧本换成一句话
- [x] **只有 e2e 角色拿得到这些工具** —— 主角色仍是那八个（`tools.test.ts` 断言
      `rootTools` 不含 `preview_*`），要验页面只能派活；`preview_*` 在 registry 里
- [x] **页面没起来时说人话** —— "这个应用还没有预览在跑，让用户点一下预览"，
      不是抛栈也不是空等（集成测试覆盖）
- [x] **命令超时后不会被补发** —— 超时的命令会从队列里摘掉。只删挂账的话，下一次轮询
      会把它交给页面**照样执行**（超时的 click 还会点出去）。单测钉住
- [x] **页面刷新时幂等命令会重投，click/type 不会** —— `sessionStorage` 里带 sessionId，
      整页重载仍是同一会话；重投只限 `read`/`assert`
- [x] **浏览器断开长轮询要被感知** —— 否则命令被投进一条已经断掉的连接，只能等超时
      （真机重载 100% 复现，假客户端永远不断开，所以只有 e2e 能抓到）
- [x] **页面里抛异常也必须回话** —— 找不到元素时回一句"没找到第 1 个「#buy」（一共 0 个）"，
      而不是让调用方等到 12 秒超时
- [x] **HTML 注入不破坏原有响应** —— 只改 `text/html`、只改未压缩的；`content-length`
      重算且**删掉 `transfer-encoding`**（两个同时在，响应会永远等不到结尾）。
      非 HTML 原样透传，没有 `page` 时行为与以前完全一致（各有单测）

使用方式：**没有 UI 入口** —— 它是给 Agent 用的。用户只需要把预览打开，
然后在对话里说"点一下加一看看对不对"，主角色会派活给 e2e。

**还没做的**（如实记）：没有"跑一条用户旅程"的能力（现只有单条命令 + 断言，
不会录制/回放一串操作）；`preview_*` 只覆盖鼠标点击与输入，没有 hover / 拖拽 / 滚动；
断言只能看文字、数量、值，没有截图对比；多标签页只有最后一个连上的页面会被驱动。

### 4.13 M4 第 5 步验收（Reviewer：git_diff + typecheck）—— ✅ 已完成

- [x] **★ 审的是工作区，不是提交** —— `git_diff` 默认 `HEAD ↔ 工作区`，因为 `commitAll` 在一轮
      收尾才跑，Reviewer 动手时改动还没提交；`commit:"HEAD"` 才看上一版。集成测试里主角色先 `write`
      再派活，断言 diff 里能看到那一行新文案
- [x] **★ 工作区差异不能走 `statusMatrix`** —— 同长度同毫秒的改动会被 stat 快路径判成"没变"。
      `worktreeDiff()` 按内容自算 blob oid；`git.test.ts` 有一条专门造 `v1\n → v2\n`
- [x] **★ 类型检查的判据是「跑完了 + 没诊断」** —— 只看诊断会把 `tsc` 崩了 / 超时 / 配置错报成通过。
      `formatTscReport` 的 `ok` 由调用方那个布尔决定，`core/typecheck.test.ts` 有一条专盯这个
- [x] **三种"没跑成"各有各的话** —— 没有 `tsconfig.json` / 缺 `node_modules` 里的 typescript /
      超时被杀，三种输出都不含 `✓`，且都写"这不等于通过"
- [x] **真跑 tsc，不是桩** —— 单测用本仓库装的 typescript 编一个临时项目：通过、`TS2322` 报错、
      从应用自己的 `node_modules` 里找 tsc（真实路径）、多 tsconfig（`nest-api` 两套）四条
- [x] **类型错误是信息不是工具错误** —— `isError: false`，理由与 `preview_assert` 一致：
      标成错误会让模型换个姿势重试工具，而它该把这一条写进清单
- [x] **没有任何写工具** —— reviewer 的工具集是 `read/ls/glob/grep/git_diff/typecheck`；
      `roles.test.ts` 与集成测试两处都断言它拿不到 `write/edit/bash/subagent`
- [x] **清单是格式约定** —— 提示词写死「最多五条、最严重在前、`[blocker|risk|nit] path:line — 问题 — 修法`」，
      最后一行交代"查了什么、什么没查成"
- [x] **工作区干净时它不编风险** —— `git_diff` 明说"干净"，并指路 `commit:"HEAD"`；
      集成测试断言这句话真的回去了
- [x] **桌面版里跑 tsc 要补回 `ELECTRON_RUN_AS_NODE`** —— `scrubEnv` 会删掉它，不补就会在 `.app` 里
      **弹出一个窗口**而 `tsc` 一行不跑。只在 `process.versions.electron` 存在时才补

**为什么没有单独的 e2e 脚本**：前四步的 e2e 验的都是"浏览器里那件事"，这一步不碰浏览器 ——
两个工具用的是真 git 与真 `tsc`，证据放在单测与一条服务端集成测试里（更接近真相，也更便宜）。

**还没做的**：`lint` 没接（模板没有 eslint 配置，硬塞会把真风险淹掉）；清单只有文本，
没有结构化事件 / 面板；`typecheck` 只看类型，不跑测试；评审结论不会自动变成"不许提交"
（发布质量门禁是 M4 第 7 步）。

### 4.14 M4 第 6 步验收（CodeAct：codemode 沙箱）—— ✅ 已完成

- [x] **★ 沙箱真在跑，而且真读到盘了** —— 集成测试里脚本 `tools.glob('src/*.ts*')` + `Promise.all`
      读八个源文件，统计 `useState` 出现次数；**产出的数字与测试自己用 `readdir`+`readFile` 算的一致**
      （沙箱没真读到盘不可能对上，比断言一句话可靠）
- [x] **★ 递给模型的只有 `codemode`** —— 子会话 `agent.tools` 严格等于 `['codemode']`；
      `read/ls/glob/grep` 在 `callable` 里（脚本调），不在 `tools` 里（模型调）。
      不设 `modelTools` 就会变成"模型绕过脚本一次次直读"
- [x] **★ 能力边界由注入决定，不由提示词决定** —— 脚本里 `write/edit/bash/subagent/codemode`
      五个名字都不存在；真去调 `tools.write` 抛 `tools.write does not exist. Available: read, ls, glob, grep`
      （报错本身有用：模型看得到自己错在哪）
- [x] **`codemode` 不能被脚本再调** —— 上游给它的 `callers` 是 `["model"]`，所以 `callable` 里没有它，
      "脚本起脚本"从工具集上断了
- [x] **脚本写错时说人话** —— 语法错误返回 `Script failed` + `Script error:` + 指向 `codemode.js:行`
      的栈，不是"工具坏了"
- [x] **四十次嵌套调用、父轮只看到一段收尾输出** —— 断言脚本结果文本 < 2000 字（这是 codemode
      存在的理由，写成大段输出就等于白用）
- [x] **`tenon.codeact` 只进子会话** —— `codeact` 的 `extensions` 列出它；主角色既不装这个扩展
      也拿不到 `codemode`，所以不会多出一段"你去写脚本"的说明
- [x] **沙箱随会话关** —— `HarnessSession.close()` 先关沙箱再关 harness（正在跑的脚本会回调进 harness）
- [x] **★ 打包之后真能跑** —— `build.mjs` 外部化 `pi-codemode` + `quickjs-wasi` 并整包拷进
      `dist/server/node_modules/`；`assertCodemodeLayout()` 按运行期那两条规则各解析一次（还要求落在
      `dist/` 内）。实测在 `dist/` 里真起了一次沙箱：`return 42` 拿到 42
- [x] **回归** —— `e2e:e2e` 9 项仍全绿（这一步动了 harness 装配，所以把真 Electron 那条链路也跑了一遍）

**三个只在打包时才现形的坑**（都记进 §5）：`require.resolve('@earendil-works/pi-codemode')` 直接报
`No "exports" main defined`（它的 `exports` 没有 `require`/`default` 条件）→ 用 `realpath` 拿软链目标；
`quickjs-wasi` 只拷 `quickjs.wasm` 不够（`vm.js` import 它的 JS 驱动层，`dist/` 要一起拷）；
过滤 `extensions/*.so` 时别把 `dist/extensions.js` 一起滤掉。

**还没做的**：脚本能用 `// @options: {"timeout_ms": …}` 放大沙箱默认超时（上游语义就是覆盖，我们没夹）；
没配 `ExecutionEnv`，输出超 token 预算时无法另存全文；嵌套调用不进父会话事件流，用量按工具归集；
脚本不能写文件（"批量改"仍由主角色一条条 `edit`）。

### 4.15 M4 第 7 步验收（发布门禁：typecheck / test）—— ✅ 已完成

- [x] **★ 判据是三态不是布尔** —— `pass` / `fail` / `skip`，只有 `fail` 拦。混成布尔会让
      「没配测试」和「测试挂了」同罪，而这个功能在两周内就会被关掉
- [x] **★「没跑成」算 `fail` 不算 `skip`** —— 有 tsconfig 却没装 typescript 是 `fail`。
      归到 `skip` 等于**删掉 `node_modules` 就能绕过门禁**，那是自欺；`checks.test.ts` 有一条专钉它
- [x] **★ 真的拦住了，而且不留半成品** —— 集成测试造一个有 `TS2322` 的应用：发布被拒
      （`RELEASE_CHECKS_FAILED`），`details.checks` 里 `typecheck: fail` 带错误码，而**仓库里既没有
      tag 也没有发布记录** —— 门禁排在版本号之前，被拒的发布不消耗 `-n`
- [x] **★ 修好之后真的能发** —— 同一应用改成正确代码：`gate.ok=true`、记录 `gateStatus='pass'`、
      摘要 `类型检查 ✓ · 测试 ⏭`（模板没有 test 脚本 → `skip`，不是「测试通过了」）
- [x] **★ `force` 能发，但留痕** —— `ok=false` + `gateStatus='forced'` + 摘要含 `类型检查 ✗`；
      历史列表里那个「带问题」标记读的就是这个字段。而且**仍然跑检查**：只影响拦不拦，不影响跑不跑
- [x] **★ 拦的是真问题，不是「反正都不让发」** —— `scripts.test` 换成 `process.exit(1)` 那一条：
      `test: fail`、`typecheck: pass`。两个检查各自独立判定
- [x] **★ 迁移不伪造历史** —— 迁移 2 给 `releases` 加的两列**都可空**；迁移测试从 v1 库升上来读
      老记录，`gateStatus` 必须是 `null`。给个 `'pass'` 默认值就把历史全改成「检查通过了」
- [x] **与 Reviewer 共用一份实现** —— `review.ts` 里的 `tsc` 跑法搬进 `checks.ts` 的 `runTypecheck`，
      工具与门禁都调它。共用顺带守住了 `ELECTRON_RUN_AS_NODE` 那个只在桌面版炸的坑
- [x] **`test` 只认 `scripts.test`，且带 `CI=1`** —— 不猜 `vitest`/`jest`；`vitest` 默认 watch 模式，
      不加 `CI=1` 会一直挂着直到被报成「测试超时」（那不是测试的问题）
- [x] **界面能把话说清** —— 没过时摊开三行（哪项、为什么、看输出），「仍然发布」要**再点一次确认**，
      确认后按钮变红并提示「历史里会标「带问题」」。藏起来会逼用户去翻命令行，一点就过等于门禁不存在
- [x] **回归** —— `e2e:release` 36 → 40 项（真 HTTP + 系统 git 当裁判，新增门禁拦截、`force` 留痕、
      两条记录都留痕）；`pnpm test` 409 → 429

**四个容易想歪的地方**（都记进 §5）：`skip` 与 `fail` 的分界（前者是配置性选择，后者是事故）；
`force` 只改「拦不拦」不改「跑不跑」；`gateStatus` 不能有默认值；`pass` 包含「全部 skip」的情况。

**后来补上的**：发布**预检**已经做了（见下一节）。还欠着的是：`lint` 没进闸门（模板没有 eslint 配置）；
检查结果只在发布对话框里出现，主界面没有「当前能不能发」的指示；发布的仍是本地备份库，
真远端 transport 未接。

### 4.16 发布预检验收（`release.check`）—— ✅ 已完成

门禁只在 `release.publish` 里跑的话，用户是"点了才知道过不过"，而这一步的全部价值恰恰是
**在发之前**知道。所以对话框一打开就跑预检。

- [x] **★ 只读** —— 查完**没有 tag、没有发布记录、备份库根本没建**，而且不消耗版本号
      （紧接着不带 `force` 发布，版本号仍是 `-1`）。`release.check` 只回答，不做任何事
- [x] **★ 与发布共用一份判据** —— 两者都调 `inspectRelease`。预检说能发、点下去却被拦，是这类
      功能最容易出的毛病；一旦出现用户就会绕开它。集成测试里两条路径的结论被逐项对齐
- [x] **★ 检查没过 ≠ 前提不满足** —— 前者 `blocked=null` + `gate.ok=false`（该改代码），
      后者 `gate=null` + `blocked.code`（该等这一轮跑完）。两个字段回答两个问题，
      界面上也长得不一样（一个是红清单，一个是黄条）
- [x] **★ 前提不满足时不跑门禁** —— 工作区脏却去跑一遍 `tsc` 和测试，既白等几十秒，
      又让人以为「测试修好就快能发了」。`gate` 是 `null` 而不是「跑了但没过」
- [x] **★ `stale`：检查期间又有提交** —— 前后各读一次 HEAD，不一致就标 `stale`，
      即使门禁通过 `ready` 也是 `false`。一份针对 A 版的「通过」拿去给 B 版用，
      **比不检查更糟** —— 它给的是虚假的安心。集成测试用 4 秒的慢测试造出这个窗口
- [x] **并发合并** —— 同一个应用的两次预检合并成一次（同一个 `elapsedMs` 为证）。两次预检
      等于同一目录里两套 `tsc` + 两套 `vitest`，后者会往 `node_modules/.vite` 写缓存，抢目录是真实故障源。
      这不叫缓存：结果一出就从表里删掉，下一次一定重新跑
- [x] **界面三态 + 一个旁支** —— 检查中（转圈 + 已等秒数）、前提不满足（黄条 + 按钮置灰）、
      没过（红清单）、过了（绿条）。`stale` 单独一条黄条：「重新检查一次」
- [x] **★ 主按钮是「重新检查」不是「仍然发布」** —— 检查没过时绝大多数人会去改代码再来一遍，
      把逃生舱摆成主按钮等于把它放在驾驶座旁边。逃生舱降成左侧 ghost，点了先变红、**再点一次才发**
- [x] **真机走过一遍** —— 用 Electron 加载真界面截了两态：门禁失败（红清单 + 三个按钮）、
      检查中（转圈 + `2s` + 置灰主按钮）。`0.0s` 那种显示改成 `<1s` —— 瞬时的检查让人怀疑它没跑
- [x] **回归** —— `pnpm test` 429 → 435（预检 6 项），`e2e:release` 40 → 44，`smoke` 9/9

**两个容易想歪的地方**（记进 §5）：`release.check` **不缓存**（缓存会让门禁看到过期答案，
而这个功能的全部价值是「答案是现在的」）；`ready` **不是**按钮的 disabled 依据（门禁没过但用户
坚持时仍能发，那时 `ready=false` 而按钮可点）。

### 4.17 M5 第 1 步验收（chord 宿主接入 spike）—— ✅ 已完成

M5 整套押在 chord 上（DESIGN §21「不要自研插件框架」），所以先 spike 再落实现。
`pnpm spike:chord`（`spikes/chord/`，10 项全绿，chord `1.4.0` + typebox `1.3.27` 锁精确版本）。

| # | 验证项 | 实测 |
|---|---|---|
| 1 | 契约 → `serve` → `get` → 方法 → 状态 | ✅ `append(2)` 返回 `rows=2`，root 结束 `rows=5`/`revision=2` |
| 2 | 状态订阅 | ✅ 收到 `[0, 2, 5]`（先 hydrate 再逐次变更）|
| 3 | 方法抛错的语义 | ✅ `invalid/script` 原样回到调用方 |
| 4 | **默认生命周期** | ⚠️ root 结束**对象销毁** → 新 root 读到 `rows=0` |
| 5 | `serve(…, { linger })` 跨 root 保 state | ✅ 读到 4 |
| 6 | `principal` + `variants` | ✅ guest = `viewer`（另一个对象，`rows=0`）；强调 `append` → `not_in_variant`；owner 不受影响 |
| 7 | 跨 host（`memoryLinkPair` + `kind:'client'`）| ✅ ui 写 7 → ui 重读 7 → server 读 7 |
| 8 | 断链语义 | ⚠️ `sever()` 后调用 **1.5s 内挂住**（不返回不抛）|
| 9 | 热重载 `host.reload` | ✅ `hits` 仍是 2、`stamp` `v1→v2`、`codeVersion` 1→2 |
| 10 | esbuild 单文件 | ✅ 726KB / 164ms / `BUNDLE_OK 2` |

**三条会改变实现方式的事实**（都写进 DESIGN 了）：① 组件 `serve` 必须显式 `linger`，否则 state 静默归零；
② 断链调用会挂住 → web facet 每个调用自带超时；③ chord 可与 server 同打包，**不需要**像 pi-codemode 那样外部化。
推翻的假设：`'ask' in ref` 恒为 `true`（Ref 代理），判权限只能真调一次认 `not_in_variant`；
无参方法的实现签名是 `(ctx)` 不是 `(args, ctx)`；`invalid(reason, message)` 是两个参数。

细节与逐项数字：`docs/SPIKES.md` §7。**下一步 = M5 第 3 步：把 probe 换成一个真组件**，
第 1 步只验了"能跑"、第 2 步验了"能装"，还没验"能挂到应用上并被 Agent 用起来"。

### 4.18 M5 第 2 步验收（bundled 组件加载器 + 装配声明）—— ✅ 已完成

新包 `@tenon/component-host`：**不加载 chord、不碰 React**，只回答「磁盘上有谁、这个应用装了谁、
按什么顺序加载、装不上的那几条为什么」。真正的 `host.load()` 留给壳生成器（第 3 步）。

| 交付 | 落在哪 | 验了什么（单测条数） |
|---|---|---|
| 严格 semver 子集 | `src/version.ts` | 15 项：`^0.x` 只放开补丁（与 `^1.x` 规则不同）、预发布版不放行 `*`、**认不出的写法抛错**（宽松实现会静默给 false/true） |
| 清单校验 | `src/manifest.ts` | 14 项：未知权限 / 绝对路径 / `../` 越界 / 未知插槽 / 重复项 / 收费缺 sku 全拒，且指出哪一行 |
| 装配声明 | `src/assembly.ts` | 10 项：文件不存在 = 空装配（不是错误）、坏 JSON = invalid、**原子写**（tmp+rename）、增删幂等 |
| 覆盖层解析 | `src/resolve.ts` + `src/roots.ts` | 认两种布局（bundled 平铺 / hub `<id>/<version>/`），`hub > bundled` |
| 加载计划 | `src/plan.ts` | 30 项：problem code（现 21 个）、依赖拓扑排序、成环整组不加载、前缀冲突、**坏一个不影响别的** |
| RPC | `component.list` | 5 项：走真 HTTP；装不上带原因且**恒 200**（插件页不该看到 500）；appId 错是 404 |
| 打包 | `apps/desktop` | `TENON_PLUGINS_DIR` → `dist/plugins` → `extraResources`（与 `templates` 同一套约定） |

三个**会静默坏**的设计点（都进了 §5）：

1. **覆盖层按"根"选版本**，不是按全局最高版本 —— 否则 bundled 1.3 会盖掉 hub 1.2，官方热更新永远不生效。
2. **一条装配条目坏，只影响它自己**。整份拒会让用户以为所有组件都被卸载了。
3. **`minTenonVersion` 对 `0.0.0` 恒通过**（仓库构建代表"还没发版的开发树"，比任何发布版都新）。
   代价是开发态测不出写错，所以"真实分支"（host=1.2.0 / 组件要 1.4.0）单独有一条用例。

`plugins/bundled/README.md` 是第一个组件的目录约定（M5 第 3 步往里放 AI 小助手；现在目录是空的，
加载器返回空列表而不是报错）。全绿：typecheck **17** project / test **509**（53 文件）/ build:desktop。

### 4.19 M5 第 3 步（a）验收（第一个真组件：契约 + server facet + 宿主）—— ✅ 已完成

**这一步只做服务端的半边**，界面半边（web facet + 传输 + 插槽渲染）是 3b。
理由很实际：跨进程链路要改网关的 `upgrade`，和"组件能不能在服务端活起来"是两件独立的事，
混在一个提交里，出问题时说不清是谁坏了。

| 交付 | 落在哪 | 验了什么 |
|---|---|---|
| 插件工程与构建 | `plugins/bundled/tenon.official.ai-assistant/{contract,server}.ts`、`scripts/build-plugins.ts` | esbuild 把 facet 连 chord 一起打成单文件（**410KB**）；产物不进 git，`pretest` 先建 |
| 契约 | 同上 `contract.ts` | 类型名 `tenon.official.ai-assistant` v1；state = `phase` / `messages` / `turns`；方法 `ask` / `clear` |
| server facet | 同上 `server.ts` | `serve(..., { linger: 30min })`；回答失败写进对话而不是把调用打红；空问题/并发提问被 `invalid` 拒 |
| 组件的模型能力 | `packages/agent/src/assistant.ts` | `ownerless` + **空工具集**会话，一问一答；复用 `subagent` 验过的原语（createConversation → submit → wait → 读最后一条） |
| 宿主装载 | `packages/server/src/components.ts` | 按 `plan.targets` 动态 `import()` + `activate`；一个坏插件只落一条 `load-failed`；`preview.start` 之后异步激活（不拖慢预览） |
| 测试 | `packages/server/test/components.test.ts`（8 项） | 用 `memoryLinkPair` 当"浏览器那半边"，走 `createHost({kind:'client'})` 同一条路 |

三条实测出来的硬约束（都进了 §5 与 DESIGN §21.2）：

1. **状态字段不能叫 `status`**（`error`/`variant`/`ready`/`shape`/`release`/`then`/`contract` 同理）——
   那是 chord Ref 自己的成员，撞名在**定义契约那一刻**抛 `member name is reserved`。所以这里是 `phase`。
2. **host 的 `name` 必须等于契约里的 `hostNamed('server')`**，否则 `serve` 抛
   「declared for server, but <别的名字> serves it」。
3. **`linger` 是"聊到一半刷新一下记录还在"的唯一原因**。测试跨两个 `root` 断言：
   没给 `linger` 时第二次读到的是新对象（0 条消息、turns=0），而且**不报任何错**。

全绿：typecheck **18** project / test **518**（54 文件）/ build:plugins 410KB。
**下一步（3b）**：web facet（悬浮球 + 对话面板）+ 链路（网关拦 `/_tenon/component` 的
`upgrade` → `webSocketLink` → `host.accept`）+ 插槽注入，然后 `pnpm e2e` 里第一次看见它。

### 4.20 代码地图（只列已落地的）

```
packages/
├── protocol/            # ★ 契约：errors(ErrorCode) / domain / rpc(方法表) / events(SSE) / result(信封)
│   ├── src/rpc.ts       #   一张表三种用途：服务端校验、前端取类型、覆盖率测试断言
│   └── src/usage-format.ts # ★ formatTokens / formatCost / budgetMessage —— 服务端与浏览器共用同一套口径
│                        #   （走 `@tenon/protocol/browser`，core 带 node:sqlite 进不了前端产物）
├── component-host/      # ★ M5 组件体系地基：不加载 chord、不碰 React，只做判断
│   ├── src/version.ts   #   严格 semver 子集：**认不出的写法抛错**（宽松实现会静默 false/true）
│   ├── src/manifest.ts  #   清单校验：权限白名单 / facet 路径不许越界 / 未知插槽
│   ├── src/assembly.ts  #   app.components.json 读写（原子写 = tmp + rename）
│   ├── src/{roots,resolve}.ts # 覆盖层：hub > bundled，认平铺与 <id>/<version>/ 两种布局
│   └── src/plan.ts      #   ★ 加载计划：problem code（现 21 个） / 依赖拓扑 / 成环 / 前缀冲突 / targets(目录+facet)
├── core/                # 领域服务，不认识 HTTP
│   ├── src/paths.ts     #   TENON_HOME 布局（唯一算路径的地方）
│   ├── src/db.ts        #   node:sqlite + PRAGMA user_version 线性迁移
│   ├── src/git.ts       #   isomorphic-git：commitAll / log / diff / showCommit / planRevert / revert（回滚 = 新提交）
│   │                    #   + createReleaseTag（annotated）/ mirrorTo（对象+ref 搬到裸库）/ uncommittedChanges
│   │                    #   + worktreeDiff（★ 工作区 vs HEAD，评审用；同样自算 blob oid，40 文件上限）
│   ├── src/schema-change.ts # ★ 快照触发判据：migrations/ + *.entity.ts + shared/schema.ts（路径约定，7 项测试）
│   ├── src/release.ts   # ★ 版本号 v<yyyy.MM.dd>-<n>（纯函数，同日递增；记录与 tag 一起参考避免撞号）
│   ├── src/pnpm.ts      # ★ resolvePnpm：随包 pnpm.cjs → node 同目录 → PATH（装依赖与跑 test 共用）
│   │                    #   两份实现早晚漂移成"预览装得动、发布跑不了测试"
│   ├── src/taskgraph.ts # ★ 任务图归一化：kind 去 pi. 前缀 / 会话派生回挂父节点 / 角色继承 / 按树序压平
│   │                    #   + tasksNeedingRole（只挑"工具 task 且已拥有会话"的去查角色）
│   ├── src/usage.ts     # ★ 用量算术：账本求和、本轮差值（夹到 0）、breached（>= 语义）/ levelOf
│   ├── src/typecheck.ts # ★ tsc 输出解析与摘要：parseTscOutput（续行并入）/ formatTscReport
│   │                    #   —— "没跑成"与"通过"在函数签名上就是两回事（ok 由调用方给）
│   ├── src/setting-keys.ts # 额度键 `budget.app.<appId>` + readBudget（读坏 / 负数一律当"不设限"）
│   ├── src/secrets.ts   #   AES-256-GCM + 0600 密钥文件（桌面版换 safeStorage）
│   └── src/stores/      #   apps / releases / settings / providers
├── agent/               # pi 生态的唯一入口（铁律 3 的落地点）
│   ├── src/models.ts    #   faux / BYOK(openai-compatible, 自建 provider)；faux 剧本**按角色分道**
│   ├── src/roles.ts     # ★ 角色表：1 主 + 5 子的工具白名单/档位/提示词/可用状态（唯一事实来源）
│   │                    #   + modelTools（递给模型的子集；只有 codeact 用）/ extensions（额外要的扩展）
│   ├── src/context.ts   #   把 pi 的 BACKGROUND_CONTEXT 导出去，上层不必 import pi
│   ├── src/harness-pool.ts  # 每应用一个 harness.sqlite + resume() + 装工具扩展（含懒注入的 harness）
│   ├── src/chat.ts      #   submit/stop/history/plan + watchEvents → SSE（40ms 合帧）
│   ├── src/taskgraph.ts # ★ 每应用一个 watchTaskGraph（不轮询）→ 归一化 → taskgraph.update 推全量；
│   │                    #   角色从 tool task 的 checkpoint.arguments 读一次并缓存
│   ├── src/usage.ts     # ★ 每应用一份账：harness.usage() 读真值 → usage.update 推全量；
│   │                    #   startTurn() 顺手判额度；读失败沿用上一次（不把应用锁死）
│   ├── src/tools/coding.ts  # read/write/edit/bash ↔ pi-durable 的 adapter（DESIGN §4.3.1）
│   ├── src/tools/search.ts  # ★ ls / glob / grep：纯 node:fs + 进程内正则（不用 pi 的会下载 rg/fd 的版本）
│   ├── src/tools/subagent.ts # ★ 派活：真子会话 + 幂等复用 + 白名单；子会话里没有 subagent
│   ├── src/checks.ts    # ★ 发布门禁：runTypecheck / runTestScript / runQualityGate + 三态判据
│   │                    #   与 review 的 typecheck 共用一份 tsc 跑法（含 ELECTRON_RUN_AS_NODE 那个坑）
│   │                    #   "没跑成"算 fail 不算 skip；test 只认 scripts.test，带 CI=1
│   ├── src/tools/review.ts   # ★ git_diff（工作区 vs HEAD）/ typecheck（转调 checks.runTypecheck）
│   ├── src/tools/codeact.ts  # ★ QuickJS 沙箱（CodemodeSandbox 60s/128MB + 上游 codemode 扩展）
│   │                    #   —— 模型面只有 codemode，read/ls/glob/grep 是给脚本调的；models: false
│   └── src/docs.ts      #   tenon.app / tenon.plan（defineDoc）
├── generator/           # 模板铺进 repo（DESIGN §8.7）
│   ├── src/scaffold.ts  #   scaffoldApp：渲染模板 → 写文件；已有 package.json 就拒绝
│   ├── src/registry.ts  #   读 templates/<id>/template.json，递归收集文件
│   ├── src/render.ts    #   只做 {{ident}} 替换；渲染后残留占位符直接抛错
│   └── templates/
│       ├── react-vite/  #   纯前端（默认）：Vite + React 19，一条命令 dev
│       │   └── src/tenon-{log.ts,boundary.tsx}  # ★ 零依赖上报：onerror/unhandledrejection/ErrorBoundary → 同源 POST
│       ├── nest-api/    # ★ 全栈（M2）：Vite + NestJS 11 + TypeORM + zod 共享层
│       │   ├── api/     #   main / app.module / db(dataSourceOptions) / migrations / items
│       │   │            #   tenon-logger.ts（★ 从 runtime-sdk 同步，别手改）
│       │   ├── shared/  #   schema.ts：zod 契约，前后端同一份
│       │   ├── src/tenon-{log.ts,boundary.tsx}  # 同 react-vite（模板各自自包含，收编进 runtime-sdk 是 M2-3）
│       │   └── tsconfig.server.json  # ★ 必须 CommonJS + emitDecoratorMetadata（Nest DI 要）
│       └── blank/       #   空壳（entry=null，不自动起预览）
├── db-provisioner/      # ★ 应用数据库供给（M2，DESIGN §6.4）
│   ├── src/types.ts     #   DatabaseProvider 接口；文件头写明 poolMax 恒 1 与未就绪抛错
│   ├── src/pglite.ts    #   PgliteProvider：pg-gateway 起真 PG 协议端 + dumpDataDir 快照
│   ├── src/postgres.ts  #   PostgresProvider：只探活；dump/restore 走 pg_dump/pg_restore
│   ├── src/manager.ts   #   DatabaseManager：按 appId 缓存（只 stop 不丢 → 端口不变）+ migrate()
│   │                    #   + snapshot/findSnapshot/restoreSnapshot（按 commit sha 归档到 exports/db/<sha>/）
│   ├── src/migrate.ts   # ★ 跨档逻辑拷贝：外键拓扑排序 / 分批 insert / setval 对齐序列 / count 校验
│   └── src/index.ts
├── runtime-sdk/         # ★ 生成应用侧的运行时 SDK（DESIGN §6.4 注 / §17 DoD ⑤）
│   ├── src/browser/tenon-log.ts       #   window.onerror / unhandledrejection → 同源 POST（零依赖）
│   ├── src/browser/tenon-boundary.tsx #   ErrorBoundary：兜住渲染期错误 + 自包含降级 UI（inline style）
│   ├── src/nest/tenon-logger.ts       #   全局 @Catch()：5xx 摘要+堆栈、4xx 一行 warn、补回响应
│   ├── scripts/sync-templates.mjs     # ★ 源码分发：拷进模板（--check 只校验）
│   └── test/sync.test.ts              #   漂移闸门：副本与原件逐字节一致
├── gateway/             # 预览编排（DESIGN §9.1）
│   ├── src/proxy.ts     #   HTTP 转发 + upgrade 原样透传（两侧 socket 必须配对销毁）；
│   │                    #   POST /__tenon/log 在这里被拦下交给 onClientLog（不转发上游）
│   ├── src/preview.ts   #   PreviewManager：deps → 端口 → 网关 → db → vite → api → 并行探活
│   ├── src/logs.ts      # ★ LogStore（每应用隔离、1s 同句合并 repeat、上限截断、堆栈续行并入 detail）+
│   │                    #   stripAnsi / classifyLine / parseClientLog / isStackLine
│   ├── src/deps.ts      #   pnpm install（--prefer-offline，全有超时，失败带最后 20 行）
│   ├── src/vite.ts      #   spawn(process.execPath, [viteBin])：不依赖 PATH 里有 pnpm
│   ├── src/api.ts       # ★ 后端半边：resolveApiEntry + tsc --watch → 等产出 → node --watch
│   ├── src/child.ts     # ★ spawnLogged（200 行环形日志、SIGTERM→4s→SIGKILL）/ groupLaunched / nodeRunEnv
│   └── src/ports.ts     #   先定端口再 strictPort，绝不让 dev server 自己换端口
└── server/              # 只做「挂到 HTTP 上」
    ├── src/app.ts       #   Fastify 装配 / RPC 路由 / SSE / 错误处理
    ├── src/auth.ts      #   Bearer（/api/health 免 Token）
    ├── src/cors.ts      #   只放行回环 origin；预检必须排在鉴权**之前**
    ├── src/handlers.ts  #   `satisfies HandlerMap` → 漏实现编译期就报错；git.revert 的编排
    │                    #   「检查 → 还原数据 → 回滚代码」（覆盖库不可逆，回滚代码可逆）
    ├── src/revert-data.ts # ★ pickSnapshot：沿祖先链找最近一份库快照 + skippedCommits 语义（6 项测试）
    ├── src/release.ts   # ★ 发布编排：预检（生成中/有提交/工作区干净/门禁通过）→ 打 tag → 镜像 → 记账
│                    #   `inspectRelease` 同时服务 release.check（只读）与 release.publish（执行）
│                    #   预检前后各读一次 HEAD：不一致标 stale，别拿 A 版的通过去给 B 版背书
│                    #   门禁排在版本号之前（被拒不消耗 -n）；force 仍跑检查，记录标 forced
    ├── src/static.ts    #   同源托管 web 产物：页面免 Token + index.html 注入 __TENON__ 与 CSP
    ├── src/bin.ts       #   CLI 入口，打印 TENON_READY（TENON_WEB_DIR 可选）
    └── test/support.ts  #   集成测试夹具：boot / rpc / openSse（先连后发只此一份实现）

apps/web/                # 渲染器：server 的纯客户端（DESIGN §14.6）
├── src/lib/rpc.ts       #   唯一的 RPC 出口；入参返回值由 protocol 方法表推导
├── src/lib/stream.ts    #   SSE：先连后发 / since 续传 / stream.reset 重拉
├── src/lib/fences.ts    #   围栏切分（纯逻辑，独立可测：流式未闭合时的闪烁问题）
├── src/hooks/useWorkspace.ts  # ★ 事件 → 界面状态的唯一归约点（reducer 在这）
├── src/features/chat/   #   MessageList（乐观插入 + 粘底）/ Composer / ChatPanel
├── src/features/preview/PreviewPanel.tsx  # iframe + 四格进度（数据/服务/预览/api）
├── src/features/logs/LogPanel.tsx  # ★ 运行日志底栏：折叠/按来源筛选/错误高亮/详情展开/清空
├── src/features/release/ReleaseDialog.tsx  # ★ 发布：说明写进 tag、成功后给路径与 git clone 命令、历史列表
├── src/features/diff/DiffPanel.tsx  # ★ 改动面板：覆盖在预览上（iframe 不卸载）、逐行着色、两步确认回滚
├── src/features/tasks/TaskGraphPanel.tsx  # ★ 任务条：实时看谁在跑；空闲时整个不渲染（图空=没人跑）
├── src/features/usage/UsagePanel.tsx      # ★ 顶栏用量：账 + 额度表单；数字全来自服务端快照，前端不累加
└── src/features/apps/   #   AppMenu / NewAppDialog（默认选能跑的那个模板）

apps/desktop/            # Electron 壳：只做生命周期（DESIGN §2.2.1）
├── src/main.ts          #   窗口 / 导航守卫 / 关窗即退出 / SMOKE 探针
├── src/supervisor.ts    #   spawn server（ELECTRON_RUN_AS_NODE）+ 解析 TENON_READY + 退避重启（不 import electron，可单测）
├── src/paths.ts         #   打包前后资源路径的唯一算法（dist/ ↔ Contents/Resources/ 同构）
├── build.mjs            #   esbuild 打 server 单文件 + 拷模板/web/pglite/pnpm/pi-codemode + 扫原生模块（铁律 3 兜底）
├── scripts/launch.mjs   #   清掉 ELECTRON_RUN_AS_NODE 再起 electron
└── electron-builder.yml #   files: 主进程 / extraResources: server,web,templates + server/node_modules

scripts/
├── dev-web.ts           # 起 server → 读 TENON_READY → 把 url/token 注入 Vite
├── smoke.ts             # 端到端冒烟（真 spawn bin.ts）
├── smoke-desktop.ts     # 桌面冒烟：真起 Electron / Tenon.app，加载界面后退出并验证不留孤儿进程
├── e2e-preview.ts       # 16 项真机断言（含定位注入与 HMR 经网关的真实推送）
├── e2e-diff.ts          # 36 项：git.log / git.show / git.revert 的真 HTTP 行为（含 schemaChanged 判据与数据回滚的 preflight）
├── e2e-fullstack.ts     # ★ 全栈真机断言：库/迁移/双进程/CRUD 经网关/重启后数据还在
└── build-plugins.ts     # ★ 组件 facet → 单文件（esbuild，连 chord 一起打），产物不进 git

plugins/bundled/         # 官方内置组件（只读内容，随安装包发布）
└── tenon.official.ai-assistant/
    ├── contract.ts      #   chord 契约：state(phase/messages/turns) + ask/clear（唯一对外事实）
    ├── server.ts        #   server facet：activate({host, appId, brain, log}) + serve(..., {linger})
    ├── manifest.json    #   清单：能力声明 / agentHints / facets
    └── README.md        #   给 Agent 读的用法（安装时进应用 AGENTS.md）
```

依赖方向（DESIGN §3.2）**禁止反向**：`protocol ← 全部`；`server → {core, agent, generator, gateway}`；
`agent/gateway → core`；`generator → protocol`（只拿 `TenonError`）；`apps/web → protocol`（**只有类型 + 两个常量**）；
`apps/desktop` **不 import 任何 `@tenon/*`**（只 spawn 进程，DESIGN 铁律 1）。
`core` 不依赖 `generator`：铺模板走 `AppStore.create` 的 `scaffold` 钩子，由 `server` 注入（DESIGN §8.7）。

---

### 4.21 M5 第 3 步（b）验收（组件的界面半边与链路）—— ✅ 已完成

| 交付 | 落在哪 | 验了什么 |
|---|---|---|
| web facet | `plugins/bundled/tenon.official.ai-assistant/web.ts` | 悬浮球 + 对话面板，**纯 DOM**（不依赖应用框架）；每个调用自带超时、断线自愈、以服务端 `messages` 为准；打包 **736KB** |
| 网关 | `packages/gateway/src/components.ts` + `proxy.ts` | `/__tenon/component.js` 同源返回脚本；**取到脚本才往 HTML 插**那行 `<script type="module">`；`/__tenon/component` 的 upgrade 不转给 Vite，交给 bridge |
| 链路 | `packages/server/src/components-link.ts` | `wss.handleUpgrade` → `webSocketLink` → `host.accept({principal:{appId}})`；脚本按文件缓存；网关关时收干净 |
| 接线 | `packages/server/src/index.ts` | 每个应用一个桥；没配模型也能装（`ask` 回一条 system 消息提醒去设置） |

三条用例（`packages/server/test/component-link.test.ts`）走**真 HTTP + 真 WS**：
注入对、脚本可取且含契约名、无装配时不插且升级被拒、**升级被接住后能 `get` → `ask` → 读状态**。

**踩到的坑（写进 §5）**：链路必须**在 socket 建出来那一刻**挂上，不能等 `open` 再
`webSocketLink` —— 等的那几十毫秒里服务端已经在发帧，没人听就丢帧，之后序号错位报
`ack 2 outside 0..2`，调用永不返回。`web.ts` 本来就是这么写的，所以只有测试被咬。

**还没验的**：真浏览器里看见球并聊一句（需要真实应用 + 预览 + Electron），留给第 8 步的
端到端验收 —— 协议层这一层已经通了，剩下的风险在"注入时机"（页面已经在跑时注入）。

### 4.22 M5 第 4 步验收（`install_component`）—— ✅ 已完成

业务核心在 `packages/component-host/src/install.ts`（纯逻辑、可直接单测），
agent 那一层只负责把参数搬进来、把结论翻译成人话。

| 事 | 做法 | 为什么 |
|---|---|---|
| 先试算后落盘 | 用 `buildPlan({assemblyOverride})` 试算，通过了才写文件 | 先写再验、错了回滚，在并发下会留下半装状态 |
| 一次改三处 | 装配声明 + `docs/AGENTS.md` 的「已装组件」+ 通知宿主重新激活 | 手改声明只更新第一处，另两处漂移后表现是"装了没反应/Agent 又写一个球" |
| 幂等 | 同 id 整条替换；AGENTS.md 字节不变时不写 | 否则每装一次多一个无意义 commit |
| 卸载 | 删声明 + 重写 AGENTS.md（同一段变成「（无）」），不改组件本体 | 组件是随包的只读内容，动它没有意义 |

**一个被推翻的设计**：DESIGN §21.3 原写"生成 `src/components.generated.ts` 让应用 import 组件"。
实际实现是**网关注入 + 宿主激活**，应用代码零参与 —— 生成那份文件在今天的架构里没有任何消费者，
只会让人以为"应用引用了组件"。所以不生成；等将来做 React 内嵌插槽（`app.page.header` 之类）时再加，
那时它才有真实的 import 方。

测试（`packages/component-host/test/install.test.ts`，8 项）：默认挂载点、幂等（字节不变）、
插槽参数、**装不上时磁盘不变**、missing/version 报错可读、已有 AGENTS.md 只改标记区、卸载幂等。

### 4.23 M5 第 5 步验收（卸载即清理 / DoD ②）—— ✅ 已完成

DoD ② 的"清理"在这里被拆成**三条可验证的事实**，一条都不能少：

| 清什么 | 怎么验 |
|---|---|
| 装配声明里没有它 | `component.list` 的 `components` 变空、`available` 里 `installed: false` |
| `docs/AGENTS.md` 里没有它 | 那一段变成「（无）」，且全文不再出现组件 id |
| **仓库里没有任何指向它的引用** | 递归扫整个 repo（跳过 `node_modules`/`.git`/`.tenon`/`dist`），命中数必须是 **0** |

第三条是"代码也清了"的证据。组件是注入式的，正常情况下本来就不该有引用；
一旦有人手抄了一段调用，这条会当场抓到 —— 否则"卸载"只是把球藏起来，代码还在偷偷用。

两个实现细节：
- **卸一个没装过的组件不写任何文件**（包括不造 AGENTS.md）—— 否则"这个项目装过组件"会变成假话。
- **幂等**：再卸一次返回"本来就没装"，文件字节不变。

已知限制（不是 bug，已记在这里）：卸掉之后**当前页面上的球不会自己消失**，要等下次刷新 ——
网关按装配声明注入，页面已经加载过的脚本不会自己卸载。要做到"当场消失"，得让 web facet
订阅自己的装配状态，属于第 8 步（热重载/端到端）的范围。

### 4.24 M5 第 6 步验收（插件页 / DoD ④）—— ✅ 已完成

顶栏「插件」按钮 → 面板：**已装列表**（名称 / id / 版本 / **来源标识**：内置·Hub·本地 / 挂载点 /
启用开关）、**装不上的每一条原因**（code + message + hint，不折叠）、**还能装什么**、以及
「官方 Hub 筹备中」占位。

| 事 | 做法 | 为什么 |
|---|---|---|
| 开关 | 新 RPC `component.setEnabled` → 只改声明的 `enabled` + 同步 AGENTS.md + `runtime.reload` | **关掉 ≠ 卸载**：声明留着才能一键开回来；卸载走 `remove_component`（代价更大） |
| 关掉要写进 AGENTS.md | 那一条后面加「**已关闭**（界面不加载，但装配声明还在）」 | 否则 Agent 以为它还在界面上，可能去"修"一个根本没生效的东西 |
| 问题摊在列表上 | 直接渲 `problems`，不折叠 | 装不上的原因（版本、槽位）是用户唯一能据以行动的信息 |
| 来源可见 | 每个组件一个标签 | 用户有权知道这段代码从哪来（内置 / Hub / 本地） |

测试（`component-uninstall.test.ts` 第 4 项，真 server + 真 RPC）：关掉后 `loaded=false`、
**声明仍在**、AGENTS.md 出现「已关闭」；再打开 `loaded=true`。

**没在浏览器里看过**：这一步的界面只做了类型检查与 `pnpm build:web`（303KB）。
真正的"点开面板、拨开关、球消失"要在第 8 步的端到端里验。

### 4.25 M5 第 7 步验收（另两个官方插件 / 规范可复制）—— ✅ 已完成

| 组件 | 服务端能力 | 业务规则（写在方法里，不靠提示词） | web facet |
|---|---|---|---|
| 导出 CSV | 把表头 + 二维数组变成 CSV（**数据由页面给**，组件零权限） | 列数对不上 → 拒绝；BOM / CRLF / RFC4180 转义 | 抓 `table[data-tenon-export]` 或第一张表 → 下载 |
| 审批流 | 内存状态机（v1） | 空标题拒；已决的单子不能再审 | 右下角徽标 + 清单 + ✓/✕ |

**这一步真正要验的是"规范能不能复制"**：两个新组件的契约与 `activate` 形状跟 AI 小助手一模一样，
第二个、第三个基本是照抄。三个 web facet 也共享同一套"连链路 / 每次调用自带超时 / 断线重连"骨架。

暴露出来、记下来的问题：
1. ~~组件没有持久化能力~~ —— 已在 §4.34 解决（`db:*` 权限 + `(appId, componentId)` 命名空间）。
   当时的判断是对的：先把这个缺口写进清单与 AGENTS.md，而不是假装存下了。
2. **web facet 只能自己决定位置**（`position:fixed`）。真正的插槽渲染（`app.page.header` 跟着页面标题走）
   需要应用配合，属于第 8 步/后续 React 内嵌。现在三个组件都"浮在页面上"。
3. **三个 web bundle 各 ~735KB**（都打包了一份 chord）。三个组件同时装 = 2.2MB。
   M6 应该改成共享一份运行时（或者由网关提供 chord 的共享 chunk）。

测 7 项（都用 `memoryLinkPair`，只验组件自己）：CSV 转义/行对齐/文件名清洗、审批状态机/非法转移/跨 root 存活。

### 4.26 M5 第 8 步验收（端到端 / DoD ①③）—— ✅ 已完成

`pnpm e2e:component`：建应用 → 写装配声明 → 起预览（真装 React）→ **Electron + 真 Chromium** →
找球 → 点开 → 发一句 → 等两条气泡 → 改代码触 HMR → 整页刷新。每一项都是真跑，**5/5 通过**：

| 断言 | 说明 |
|---|---|
| 应用首屏 | 应用自己先渲染出来（否则"球在"没有意义） |
| 球存在且只有一个 | **注入时机对了**：页面已经在跑的时候插的脚本；HMR 重跑模块也不会重复挂 |
| 问答两条气泡 | DOM → chord(WS) → server facet → 注入的模型能力 → 回到 DOM，整条真的通了 |
| HMR 之后球还在 | DoD ③ 的一半：热更新不把组件弄丢 |
| **刷新整页对话还在** | DoD ③ 的另一半：状态在服务端对象上，不在 DOM 里 |

**卡住两轮的真因（都写在 §5 了）**：
1. Electron 必须 `--no-sandbox` 且**删掉** `ELECTRON_RUN_AS_NODE`（写成空串也算存在）；
2. **测试自己拼的选择器没转义**：`'document.querySelector("' + ball + '")'` 里 ball 自带双引号 →
   每次轮询都是一次语法错误，而 `.catch(() => false)` 把它吞了。80 多条"等不到"，真实原因在
   `executeJavaScript` 的字符串里。

顺带留下一个**产品级改进**：网关注入组件脚本时多插一行**错误捕手**（`window.__tenonComponentErrors`）。
组件是模块脚本，加载失败时浏览器只在控制台留一行、页面照常可用 —— "组件没出现"这个现象
没有任何别的线索。这一行就是这次能定位下去的原因，以后端到端与用户反馈都读它。

### 4.27 真模型验收（M5.5）—— 脚手架已就位，等一把真 key

**为什么先做这一步**：到此为止 540 个测试与 8 套端到端**全部跑在 faux 上**（按剧本回台词的假模型）。
faux 证明的是管线通，不是"模型按提示词把事做完"。而只在真模型下才被检验的，恰好是产品主张的全部：
系统提示词、工具描述、`docs/AGENTS.md`、组件 `agentHints`、以及"先说需求 → 页面真能用"这条闭环。

两个脚本，各自的职责分得很清：

| 脚本 | 验什么 | 要不要 key |
|---|---|---|
| `pnpm e2e:provider` | **BYOK 通路**：profile（加密存库）→ 启动时 resolveModel → `createProvider(openai-completions)` → 流式 SSE → 工具调用 → 落盘 → commit → 用量入库。配一个本地假 OpenAI 服务（`scripts/mock-openai.ts`）真跑一遍 | 否 |
| `pnpm e2e:real` | **真模型验收**：①一句话做待办清单 ②一句话让它自己装 AI 助手 ③真 Chromium 里输入→添加→删除→点球问一句 | 是 |
| `TENON_REAL_MOCK=1 pnpm e2e:real` | **排练模式**：同一脚本换成假 provider，先证明脚本自己是好的（真跑一次要花钱、要几分钟，不该拿它调断言） | 否 |

`e2e:real` 的判据刻意与实现解耦（不找特定 class，只找"能输入的地方 + 能点的按钮"）——
它要覆盖的是**模型自由发挥出来的界面**，我们并不知道它会写成什么样。

**结果：真模型（DeepSeek V4.1 Flash）12/12 通过**（2026-11-03）。排练模式同样 12/12。

| 阶段 | 耗时 | token | 它做了什么 |
|---|---|---|---|
| 一：一句话做待办清单 | 36.3s | 10 660 | 13 次工具调用（`ls` / `read` / `bash` / `write` / `subagent`），写了 `App.tsx` 与 `styles.css`，用 `useRef` 生成 id、加了失焦处理、注释写了取舍 |
| 二：一句话装 AI 助手 | 9.7s | 2 431 | `list_components` → `install_component` → `bash` 读回声明确认 → `subagent`（派活去验页面） |
| 三：真 Chromium | — | — | 输入 → 添加 → 删除 → 点球问一句拿到回答，**六条断言全绿** |
| 合计 | 46.0s（不含浏览器） | 13 340 | 3 个 commit |

**真模型下第一次被验证、之前全是"应该能行"的三件事**：
1. **工具描述与 `AGENTS.md` 够用** —— 模型自己去 `list_components` 看有什么、装完用 `bash` 读 `app.components.json` 确认，**没有手写一个悬浮球**（那是它最容易犯的错）。
2. **它真的会派活** —— 主 Agent 主动把"验页面"交给 e2e 子角色；子角色试了三次（`preview_read` / `preview_open`）后如实回「**无法验证 —— 预览未运行**」，还引用了工具原文。M4 的分工在真模型下成立，不是剧本安排的。
3. **"说完了"与"做完了"是两件事** —— 模型收尾时说得头头是道，而页面能不能加、能不能删，只有真 Chromium 说了算。这也是为什么判据必须落在页面上。

**新发现的一个摩擦（待修）**：模型在依赖装好之前就跑 `tsc`，撞上
`TS2688 Cannot find type definition file for 'node'` —— 应用的 `node_modules` 要等
`preview.start` 才装。表现是"代码看起来有错"，模型于是反复折腾类型错误。
→ 应该在**建应用时**（或首次 bash 前）就把依赖装上，或让类型检查明确说"依赖还没装"。

#### 这一步已经抓到的三个真问题（都已修）

1. **`install_component` 在真实运行时里从来没挂上过**（最严重）。
   `AgentRuntimeOptions.components` 声明了、server 也传了、`HarnessPool` 也用得上，
   **中间那一跳没人接**（`createAgentRuntime` 建 pool 时没往下传）。症状：模型一调就回
   `Tool install_component is not available`，而界面上那条还显示 ✓。
   类型检查抓不到（两侧类型都对，只是没连起来），原有测试也抓不到（它们直接构造 pool，绕过了这段）。
   → 已修 + 新增 `packages/server/test/component-wiring.test.ts`（**从 server 起步**只问
   "主会话的工具清单里有没有它"，并顺带钉住"组件工具不会把 preview_*/git_diff 漏给主角色"）。

2. **工具失败在消息流里显示成成功**。`normalize.ts` 给 tool part 的 `status` 写死了 `'ok'`，
   工具结果那条 entry 被整条丢弃（注释写着"挂在工具调用上渲染"，实际上从没挂）。
   于是路径越界、命令非零退出、组件装不上 —— 全都和成功长得一模一样。
   → 已改成两遍归一化：先收 `pi.tool-result`（按 `toolCallId`），再回填 `status` 与 `output`；
   前端本来就在读 `part.status`（`bg-bad`），所以修复直接生效。新增 `packages/agent/test/normalize.test.ts`（5 项）。

3. **工具不能抛异常**。`installComponent` 一抛，运行时把它压成一条 `<harness>` 诊断，
   消息甚至是空的 —— 模型看到四个字母，既不知道发生了什么也没法自救。
   → 工具层兜住并翻译成人话（"装 X 时出错了：…"）。

#### 这一跑之后补掉的两条

- ~~没有设置页~~ → §4.28 做了（顶栏「未配置模型」点开就能填）。
- ~~模型只在启动时解析~~ → §4.28 做了热切换（保存即生效，不用重启）。

**依赖时机**也补掉了（§4.29），**成本**也补掉了（§4.30：独立价格表 + 真账复算）。
§4.27 里那三条待定缺口到这里全部结清。

#### 真 key 的跑法（环境变量，key 不落日志）

```bash
TENON_REAL_KEY=sk-... TENON_REAL_MODEL=deepseek-chat \\
  TENON_REAL_BASE_URL=https://api.deepseek.com/v1 TENON_REAL_LABEL=DeepSeek \\
  pnpm e2e:real
```

可选：`TENON_REAL_HOME=/tmp/xxx` 复用已有 home（省掉每次装 React 的几十秒）、
`TENON_REAL_BUDGET_TOKENS=400000` 设额度（默认 40 万，超了当场熔断）。
脚本只会打印 key 的前 3 位与后 2 位。

### 4.28 模型设置页 + 热切换（M5.5 第二件）—— ✅ 已完成

做之前的状况：`provider.upsert` 有 RPC、**没有界面**，而且模型只在启动时解析一次。
也就是说这个产品的 BYOK 只对写脚本的人可用 —— 真用户拿到 API Key 也没处填。

| 交付 | 落在哪 | 关键决定 |
|---|---|---|
| 设置面板 | `apps/web/src/features/settings/ModelPanel.tsx` | 顶栏那个模型标签**本身就是按钮**（未配置时是黄字「未配置模型」，成功即是 `modelId`）；预设 DeepSeek / OpenAI / 本地 LM Studio 一键填端点 |
| 连接测试 | `provider.test`（protocol + server） | 发一次 16 token 的最小请求，**把提供商的原话交回来**（401 就是 401）。填错 key 的表现与"模型有点笨"几乎一样，用户会以为是产品不好用 |
| 热切换 | `AgentRuntime.applyModel()` | `createAgentRuntime` 改成**可变外壳**（getter 委托），`createHandlers` 解构的是这个对象，所以换模型对调用方完全透明 |
| 自动选中 | `provider.upsert` | 第一个提供商自动设为当前。填完 key 什么都没发生，是这类设置页最常见的挫败感 |
| 删除即回到无 | `provider.delete` | 删的正好是当前那个时，把 `activeProviderId` 也清掉，否则下次启动报"提供商已不存在" |

**"保存后不重启"是怎么做到的**：`applyModel()` 先算新 plan，与旧的一致就**什么都不做**
（每次保存都重建会把正在跑的一轮掐掉）；不一致才 teardown + 重新 build。
代价写在接口注释里：切换会关掉现有 harness 会话（会话数据在 sqlite，下次 `resume()` 接回来）。

**人眼验收**（`pnpm shot:settings`）：真 Chromium 里点开面板（未配置态）、打开表单、
填一个假端点、点「保存并启用」→ 顶栏标签变成 `shot-model`、面板出现
「已生效：shot-model（不用重启）」、列表里那一行带上「当前」标记。四张截图在 `/tmp/tenon-settings/`。

测试 4 项（`provider-hotswap.test.ts`，真 HTTP + 假 provider）：配完立刻生效 / `provider.test`
的 401 原文 / 删掉当前 provider 立刻回到 null / 设置没变时 `changed=false`（不重建）。

**踩到的一条**：`settings.get` 对**不存在的键返回 `undefined`**，不是 `null`。我按 `=== null`
判"还没选中"，于是自动选中从来没生效 —— 而 `planModel` 有"只有一家就用它"的兜底，
所以**模型能用、界面上的「当前」标记却是空的**。这种"能用但看着没配好"最容易让人反复保存。

### 4.29 依赖安装时机（M5.5 第三件）—— ✅ 已完成

**问题**：依赖原先只在 `preview.start` 时装。而 Agent 在第一轮对话里就会跑 `tsc` /
`pnpm test` —— 那时 `node_modules` 还不存在，模型看到一屋子
`TS2688 Cannot find type definition file for 'node'`，于是开始"修"一个不存在的类型错误。
真模型验收第一次跑时就抓到了这条（模型确实为此多绕了几步）。

**做法**（三处，各管一段）：

| 位置 | 做什么 | 为什么 |
|---|---|---|
| `app.create` | 建完**后台**开始装（不阻塞返回） | 装 React 十几秒，建应用不该卡这么久；而等用户点预览又太晚 |
| `chat.submit` | 提交前 `await ensureDeps` | 用户打字的时间通常够装完；装不完也只是"第一句慢一点"，而不是让模型对着空工作区瞎猜 |
| `preview.start` | 走**同一个**入口 | 两处各写一遍就会装两遍（或判定漂移） |

`PreviewManager.ensureDeps()` 只缓存**在飞**的那一个 promise，装完就删 —— 缓存结果的话，
用户在对话里让 Agent 加了包，预览重启时就不会再 install（表现："依赖加了却 import 不到"）。

**一个连带的坑（已修）**：`pnpm install` 会生成 `pnpm-lock.yaml`。如果不管它，它会掉进
**第一轮对话的 diff** —— 一千多行锁文件把真正的改动挤出评审视图（`git_diff` 有 48KB 上限），
而"这一轮改了什么"是评审唯一的输入。所以装完单独提交一次 `chore: 锁定依赖版本`。

**失败不挡路**：装不上（离线）不影响建应用、也不拦对话 —— 写代码不需要 `node_modules`，
只有类型检查需要。失败往日志面板推一条 warn，说明"型检查会不准"。

**实测**（`/tmp/tenon-real-dep`）：建应用后 4.6s 装完，第一轮开始时 `node_modules` 已就绪，
`TS2688` 出现 **0** 次（改动前一次真跑里出现过），`pnpm-lock.yaml` 在
`chore: 锁定依赖版本` 这个独立 commit 里（`a88ceff`），没有污染两轮对话的 diff。

**诚实的一条**：这次真跑反而**更贵**（95s / 14.3k token vs 上次 36.3s / 10.7k）——
因为模型这次计划更啰嗦（22 次工具调用 vs 13 次）。**单次对比不能证明省了多少**，
能证明的只有"依赖在建应用时就绪、TS2688 不再出现"。要量化得跑多次取中位数，那是另一件事。

测试 3 项（`deps-timing.test.ts`）：建完就装 / 装失败不挡建应用与对话且推 warn /
`installDeps:false` 时一次都不装。**测试夹具默认关掉安装**（联网 + 生成 lockfile 会让
"一轮一 commit""工作区是干净的"这类断言随装依赖的时机飘）。

### 4.30 模型价格表（M5.5 第四件）—— ✅ 已完成

**问题**：`usage.costUsd` 恒为 0。那不是"便宜"，是"没算" —— 而「按美元设额度」
对 BYOK 用户**完全失效**，界面上还显示 `$0.00`，用户会以为自己离上限很远。

**为什么单独一张表**（用户拍的板，当时的取舍也记在这里）：一个 provider 可以挂多个模型
（同家 flash / pro 差价好几倍）。塞进 `provider_profiles` 就只能记一个价，换个模型 id 就全错 ——
而"额度算错"用户不会发现，直到账单来。

| 层 | 落点 | 关键决定 |
|---|---|---|
| 表 | 迁移 3 `provider_prices` | 唯一键 `(profile_id, model_id)` + `ON CONFLICT DO UPDATE`（先查再写在并发下会插两条） |
| 存储 | `packages/core/src/stores/prices.ts` | `removeByProfile`：删 provider 时价格一起走，否则同一家再建 provider 会张冠李戴 |
| 映射 | `packages/agent/src/models.ts` 的 `modelCost()` | **不做任何换算** —— 表与 pi 的 `model.cost` 都是「美元 / 百万 token」。抽成函数只为让单测守住"别顺手乘除" |
| RPC | `price.list` / `price.set` / `price.remove` | 改价必须**强制重新解析模型**：`model.cost` 是解析那一刻烤进 provider 的，不重解析的话填了价面板还是 $0.00 |
| 界面 | 设置页每行「价格」+ 用量面板 | 没配价格时标签写「**未定价**」，成本格显示"未定价"而不是 `$0.00` |

**一个必须分清的东西**：`UsageSnapshot` 新增 `priced`。它和 `costUsd` 是两个问题 ——
"算了多少钱"和"能不能算"。混成一个的话，界面只有两种选择：要么骗人（显示 $0），要么
永远不显示钱（有价也算不出来）。

**实测（真模型 + 真价格）**：给 `deepseek-flash` 填 0.5 / 1.5 美元每百万 token
（**测试值，不是官方报价**），跑完整验收：
`costUsd = $0.012429`，用 `(input*0.5 + output*1.5) / 1e6` 复算 `$0.012590`，
偏差 **1.28%**。差额来自缓存命中：我们没填缓存价（默认 0），pi 就按 0 收那段 —— 不是记账错。
判据进 `e2e:real`：给了 `TENON_REAL_PRICE_IN/_OUT` 就会复算并断言偏差 < 2%。

测试 8 项：一个 provider 多模型价 / 同模型改价不新增行 / `priced` 随增删翻转 /
删 provider 带走价格（server 4 项）；价格映射原样透传、缺失为 0、串 provider 不算数、
缓存价带过去（agent 4 项）。

### 4.31 M6 第 1 步：Hub 客户端（下载 / 验签 / 原子落盘）—— ✅ 已完成

**做了什么**：一条能真正跑通的发布链路 —— 官方组件打包签名 → 上传 → 客户端下载验签 →
原子落盘到加载器的 hub 根 → 装配时自动优先用 hub 版。

| 交付 | 落点 | 关键决定 |
|---|---|---|
| 包格式 | `bundle.json`（单文件 JSON） | 官方组件全是文本（esbuild 产物 / 清单 / README），不需要 tar/zip —— **引一个解压器就多一份"解析别人给的字节"的攻击面**。等真有二进制资源再换 |
| 签名 | Ed25519，签 **payload 的规范 JSON 字节** | 自己写 `canonicalJson`（键排序）：`JSON.stringify` 的输出依赖属性插入顺序，同一份内容从不同代码路径构造出来会签出不同结果 —— 而那种错只在某些机器上出现 |
| 验签顺序 | **先验签，再解析清单** | 反过来的话，一个没签名的包也能让 zod 去啃它。历史上"先解析再验证"出过太多解析器漏洞 |
| 落盘 | 写 `.tmp-xxx` → rename | 中途崩只会留一个临时目录，不会留"清单在、文件少一半"的版本 —— 那是最坏的情况：页面上什么都没有，日志里也没有 |
| 来源 | 落盘时把 `source` 改写成 `hub` | 来源标签是给用户看"这段代码从哪来"的，**不能由包自己说** |
| 装到哪 | `hubPluginsDir(env, home)` | 必须与**加载器的 hub 根**是同一个；不一致的表现是"装成功了却加载不到"，而装的时候一切正常 |

**安全边界（都有用例）**：路径穿越（`../../evil.sh`）→ 拒且磁盘不留痕；索引说 A、包里是 B → 拒；
改一个字节 → 验签失败；没有签名 → 拒（**没有"跳过验签"的开关**，能关掉的签名等于没有）；
URL 不在 `TENON_HUB_URL` 之下 → 拒（否则一个 RPC 就是"装任意代码"的入口）。

**配置**：`TENON_HUB_URL` + `TENON_HUB_PUBLIC_KEY`（两个都缺 = 未配置，这是**正常状态**）。
RPC：`hub.status`（界面据此显示"筹备中/已连接"）、`hub.install`（装完把**装了它的应用**重新激活，
否则用户点了更新界面上还是旧版）。

**发布脚本** `pnpm pack:plugin <id>`：读清单与 facet → 签名 → `dist/hub/<id>-<version>.json`。
没有 `TENON_HUB_PRIVATE_KEY` 就拒绝生成 —— 产出"没有签名的包"是最坏的一种友好（客户端一定拒）。

**实测**：用 openssl 生成 Ed25519 密钥，把**真的** AI 小助手（`server.js` 410KB + `web.js` 754KB）
打成 1.18MB 的签名包，起本地 HTTP 服务分发，客户端装完 `listAvailable` 看到
`tenon.official.ai-assistant@1.0.0(hub)` —— 打包、验签、落盘、装配四段都通。

测试 21 项：组件层 18（验签 6 / 落盘 6 / 下载 4 / 配置 2）+ 接线 3（未配置 / 覆盖层生效 / 篡改返回 422）。

**没做的（下一步）**：索引 `index.json`（列版本与地址）、"有更新"检查、界面上的「更新」按钮。
现在只能由调用方给一个 bundle 地址 —— 界面上没有入口，因为还没有索引可查。

### 4.32 M6 第 2 步：索引与更新检查 —— ✅ 已完成

**这一步之前，"从 Hub 装组件"只能由调用方给一个 bundle 地址** —— 界面上没有入口，
用户也不可能知道地址。补上三件：签名索引、更新检查、界面上的「检查更新 → 更新」。

| 交付 | 落点 | 关键决定 |
|---|---|---|
| 索引 | `hub.ts` 的 `HubIndex` | 单文件 `<hubUrl>/index.json`；**地址固定，不由调用方指定** —— 少一个可被利用的参数 |
| 索引签名 | `signHubIndex` / `verifyHubIndex` | 用**同一把** Ed25519 密钥。多一把就多一处要保护、轮换、对齐的地方，而这里没有"索引与包应分权"的理由 |
| 最新版本 | `latestVersion()` | **走比较，不取 `versions.at(-1)`**：合约没写"按版本升序"，而索引是别人生成的 |
| 更新计划 | `planHubUpdates()` | 降级不算更新；没装过不算更新；**区间不接受 → 进 `blockedBy`** |
| 接线 | `hub.check` / `hub.install` | check 连不上**不抛错**（离线不是故障）；install 只收 id + 版本，地址来自签名索引 |
| 发布 | `pnpm pack:plugin` | 包与索引**同一次**产出并签名（手工维护索引必然出现"包传了索引没更新"） |
| 界面 | 插件页底部 | 「检查更新」按钮 → 列出 `v1.1.0 → v1.2.0` + 说明 + 「更新」；点完刷新列表并给一句"已更新到…" |

**为什么索引必须签名**（这条最容易觉得"多余"）：包有签名，所以篡改索引装不进恶意代码。
但可以**降级** —— 把"最新"指向一个旧的、确实签过名的版本，用户点更新就退回有漏洞的那一版。
没有索引签名，这类攻击在客户端完全看不出来。

**`blockedBy` 是这一步真正的设计点**。组件装在本机是**全局**的，但用不用它由每个应用自己的
`app.components.json` 与版本区间决定：解析器只挑"满足区间的最高版本"。所以
"应用声明 `^1.0.0`、Hub 上最新是 2.0.0"这种情况下，把 2.0.0 装到磁盘上**等于没装**。
不判这一条的话，用户点完更新看到版本号没变，会以为更新功能坏了 —— 而这正好是我最怕的那种
"看起来成功、其实什么也没发生"。所以：`hub.check` 里点名是哪些应用挡住了，
`hub.install` 也**不重载**这些应用（重载了也不会有任何变化）。

**人眼验收 `pnpm shot:plugins`（9/9 通过）**：脚本用真的组件内容打两个签名包（1.1.0 / 1.2.0）、
起一个假 Hub、建应用装内置 1.0.0 → 从 Hub 装 1.1.0 → 在真 Chromium 里点开插件页、
点「检查更新」（界面出现 `AI 小助手 v1.1.0 → v1.2.0` 与说明）、点「更新」→
列表变成 v1.2.0、出现「已更新到 v1.2.0，1 个应用已重新加载」、再检查显示"都是最新的"。
三张截图在 `/tmp/tenon-plugins/`。

**发布侧也验了一遍**：`TENON_HUB_URL=… pnpm pack:plugin tenon.official.ai-assistant` 产出
1.18MB 包 + 签名索引；客户端按索引取回、验签、装包；把索引里的版本改一下 → `bad-signature`。

测试 26 项：索引层 22（验签 5 / 下载 4 / 最新版本 2 / 已装列表 3 / 更新计划 8）、
接线 4 个新增（未配置、覆盖层生效 + 装前后 check、有新版 → install 后版本真变、
区间不接受 → blockedBy + 不重载、索引被改 → 422、Hub 上没这个组件 → 说清楚）。

**一个部署上的硬约束**（写在这里免得踩）：索引里的地址是**绝对**的（发布时用 `TENON_HUB_URL`
烤进去），所以换域名/端口之后**必须重新发布索引**；否则客户端会以 `url-outside-hub` 拒装。
这个检查本身是对的（它挡掉了"索引指向别处"），只是换域名时容易忘。

### 4.33 M6 第 3 步：组件商店 —— ✅ 已完成

**这一步之前，插件页只能管"已经装进这个应用的组件"**：想装新的只能跟 Agent 说一句，
或者去手改 `app.components.json`。商店要回答的是另一个问题：**还能装什么**。

| 交付 | 落点 | 关键决定 |
|---|---|---|
| 两个页签 | `PluginsPanel` | 「已装 N」/「商店」；有更新时页签上标 `↑1`（否则用户根本不会点进去看） |
| 装进应用 | `component.install` RPC | 与 `install_component` 工具走**同一个** `installComponent`：写声明 + 同步 `AGENTS.md` + 重新激活 |
| 移除 | `component.remove` RPC | 有"装"就得有"移除"，否则用户只能靠 Agent 才能反悔 |
| 本机没有就去 Hub 拿 | `installComponentWithHub`（component-host 内） | 收纳了两处重复的"挑版本 + 下载 + 重试"；Agent 工具与界面**共用这一条** |
| 付费门禁 | `installComponent` 里的 `paid-not-available` | 唯一入口里一道门；Agent 与界面都绕不过 |
| 付费标记 | 索引的 `pricing` + 商店的「付费」标签 | **只是显示**，判据在包里的清单（见下） |

**为什么"装进应用"必须和 Agent 同一条路**：装配声明有三个下游（web 注入 / server 激活 /
`AGENTS.md` 索引）。界面自己写声明的话，第三个下游会漏 —— 表现是"界面上装了，对话里
Agent 还是不知道有这个组件，于是自己又写一个"。这条在 M5 第 4 步就定过，这次是复用。

**付费门禁为什么只做在"安装"这一步**：组件的文件是明文落盘的（esbuild 产物），
谁拿到目录都能读；在"加载"那一层再拦只是把可读的代码当成加密的，属于自我安慰。
所以门禁只拦安装，并且**在清单、错误文案、STATUS 里都明说这一点** —— 免得后来有人
以为这里有防护。索引里的 `pricing` 也说明是"显示用"：写成 free 也变不成免费，
装上那一刻会按**包里的清单**（带签名）拒绝。

**一个被顺手消掉的重复**：原本 `hub.install` 与 `component.install` 各写一遍
"读索引 → 挑版本 → 下载 → 校验 expect"，而 Agent 的 `install_component` 连这条路都没有
（所以"跟 Agent 说一句装一个 Hub 组件"是坏的）。现在收成两个函数：
`installFromHubIndex`（按 id 装到本机）与 `installComponentWithHub`（装进应用，缺了就下载），
三处入口全都走它们。

**人眼验收 `pnpm shot:plugins`（12/12 通过）**：脚本用真的组件内容打三个签名包
（AI 小助手 1.1.0 / 1.2.0、导出 CSV 1.0.0），起一个假 Hub，然后在真 Chromium 里
把整条路走一遍：开插件页 → 检查更新（`v1.1.0 → v1.2.0`）→ 更新 → 切「商店」
（列出导出 CSV 与审批流）→ 点"导出 CSV"那一行的「装到此应用」→ 回「已装」看到两个组件。
五张截图在 `/tmp/tenon-plugins/`。

顺带一个**测试自身的教训**：第一次跑，脚本按"页面上第一个装按钮"去点，结果装成了审批流
（本机 bundled 的那两个都在商店里）。改成**按行找按钮**（在含"导出 CSV"的那个 `li` 里找），
断言也改成"本机有就优先用本机那份"—— 这不是脚本的妥协，而是产品的真实顺序。

测试 8 项（`component-store.test.ts`，真 server + 真工具 + 真假 Hub）：
本机有包 → 装进应用且 AGENTS.md 同步 / 幂等 / 本机没有 → 下载再装（`downloaded=true`）/
本机没有且 Hub 未配置 → 说"找不到"不 500 / 付费组件装不上且磁盘不留痕 /
移除后回到"可安装"且重复卸幂等 / 装到别的应用不影响这个 / **Agent 的工具也能装 Hub 组件**。

### 4.34 M6 第 4 步：组件的持久化能力 —— ✅ 已完成

**这一步之前，`manifest.permissions` 只是一行声明**：清单可以写 `db:read` / `db:write`，
但宿主从来没给过任何能力，所以三个官方组件里两个的权限是空的、审批流的数据一重启就没。
这一步让那行声明第一次真的生效，也把"组件能不能碰数据"这个问题答清楚。

| 交付 | 落点 | 关键决定 |
|---|---|---|
| 表 | 迁移 4 `component_kv` | 主键 `(app_id, component_id, key)` —— **命名空间就是主键**，不是查询条件 |
| 存储 | `packages/core/src/stores/components.ts` | 配额 500 键 / 单值 64KB；**配额在 store 里判**，不在调用方（两个调用方只判一个等于没判） |
| 门面 | `packages/component-host/src/storage.ts` | 按清单权限开门；`update()` 把同一键的并发读改写排成队列 |
| 注入 | `packages/server/src/components.ts` | `activate({..., storage})`；**没权限时字段不存在**（不是给个一调就抛的对象） |
| 组件 | 审批流 | `items + nextId` 存成一个键 `state`（拆两个键会造出重复编号）；`pending` 初值从恢复的单子算 |

**为什么是 KV 而不是"给组件一个数据库连接"**：组件声明 `db:write` 的意思是"我要存点
自己的数据"，不是"我可以动用户业务表"。给一条 SQL 通道，一个写得不好的第三方组件就能
`DROP TABLE orders` —— 而组件是别人写的代码，这种风险不该由用户承担。KV 的边界清楚得多：
写入上限、键空间隔离、没有跨表查询，也就没有"顺手读一下订单表"。

**为什么没权限时是 `undefined` 而不是"一调就抛"**：给一个会抛的对象，组件作者只会写
一个 `try/catch` 包住，然后**静默降级**（数据悄悄只存在内存里，用户以为存下了）。
`undefined` 让它在类型层面就必须处理：要么自己降级并说清楚，要么干脆不提供这个功能。

**"重启"是怎么验的**（`component-storage.test.ts`，5 项）：关掉 chord host，用**新的**
host + **新的** storage 再 `activate()` 一次，中间只共享产品库（`openCore` 的 sqlite）。
对象、闭包、内存里的东西全部重建 —— 能读到的东西只能来自存储。验的内容：

1. 单据还在、待审计数也对（**这一条当场抓到一个 bug**：`pending` 初值写死 0，重启后
   徽标显示 0 而清单里有两张待审单 —— 用户会以为丢了然后重复提交。已改成从恢复的单子算）；
2. 重启后编号不重（继续是 `AP-3`）；
3. 同一个组件装进另一个应用 → 看不到这边的单子（命名空间）；
4. 两个组件在同一个应用里也互不可见；
5. 没有 `db:*` 权限 → 拿不到 storage，数据退回内存且**产品库里一个字节都没有**（降级是看得见的）。

`storage.ts` 另有 7 项单测（内存后端）：无权限 → undefined / 只读不能写且提示说"加 db:write" /
只写不能读 / 键不存在返回 null / **并发 10 次 `update` 得到 10**（不串行会丢）/
`update` 抛错后值不变且队列不带崩 / `keys` 前缀透传。

**一个测出来的顺序约束**：组件的 `activate` 可以是 async 的（审批流要先从存储恢复再
`serve`），所以宿主**必须 await**。生产代码本来就是 await 的；倒是 `official-plugins.test.ts`
里的夹具没等，撞出"contract 还没人 serve"——已改成 `await connect(...)`，注释写清了这不是
组件写错，是测试要跟上。

**一个故意没做的清理**：从应用里「移除」组件时**不删它的数据**。`remove_component` 是
"我不想在界面上看到它"，不是"把我的单据全删了"——数据丢失比磁盘占用严重得多。删应用时
才清理（`ComponentStore.removeApp`）。代价是移除再装回来的组件会看到旧数据，这在审批流
这种场景里恰好是对的（同一批单据）。

### 4.35 M6 第 5 步：M6 收口 —— ✅ 已完成

三件事：**订阅/授权模型定稿**、**Hub 配置随包分发**、**从零发布一个组件的可复跑链路**。
其中第二件改代码，另外两件一件是文档定稿、一件是把"发布"变成一条命令。

#### (a) 订阅/授权模型：定稿为「现在不做」

结论写进 DESIGN §21.5（含 Phase 3 的 `license.json` 结构、四个校验点、四个要改的文件）。
一句话：**Phase 2 全线免费；`pricing: paid` 保留在协议里，作用是"装不了"的安全阀，不是商业模式**。

`pricing.type === 'paid'` 现在的语义只有一个：这个组件**不属于官方免费范围**，安装端
一律拒绝并明说"购买流程还没做"。为什么不做半套：没有第三方上架就不存在"卖谁的组件"，
而半套 license 的典型死法是"付了钱装不上"或"装上了但界面不说已授权"，支持成本远高于收入。

#### (b) Hub 配置随包分发

**这是这一步真正的 bug 修复**：M6 前四步里，Hub 配置只能来自 `TENON_HUB_URL` /
`TENON_HUB_PUBLIC_KEY` 两个环境变量 —— 而**用户双击打开的 `.app` 里没有环境变量**。
于是打包版的组件商店永远显示"未配置"，而那不是错误、日志里一个字都没有。

| 交付 | 落点 | 关键决定 |
|---|---|---|
| 解析优先级 | `component-host/src/hub.ts` 的 `resolveHubConfig` | `env > 随包 hub.json > 未配置`，并返回 `origin`（`env`/`file`）与 `note` |
| 壳只指路径 | `apps/desktop/src/main.ts` | 设 `TENON_HUB_CONFIG_FILE`，**不读内容**（壳不认识 `@tenon/*`，铁律 1） |
| 构建产物 | `apps/desktop/build.mjs` + `electron-builder.yml` | 写 `dist/hub.json` → `Resources/hub.json`；`TENON_REQUIRE_HUB=1` 时缺配置直接失败 |
| 界面 | `PluginsPanel` + `hub.status` | 显示地址、指纹、**来源（随包内置/环境变量）**；配错了就把 `note` 显示出来 |

三个刻意的选择：

1. **壳指路径而不是壳塞值**。与 `TENON_PLUGINS_DIR` / `TENON_TEMPLATES_DIR` 同一个模式。
   好处是业务侧能分辨"包里的"和"用户设的"—— 塞进环境变量的话两者长得一模一样，
   而界面恰恰需要回答"我这个包连的是哪个源"。
2. **没配也写一份空 `hub.json`**。`extraResources` 的来源不存在会让整次打包失败，
   那等于"没配 Hub 就没法打包"。空值在 `resolveHubConfig` 里是"就是没配"
   （与"字段名拼错"分开报），所以商店显示「筹备中」而不是一句配置错误。
3. **只给一半环境变量时不回落到文件**。那是"我要换源"，而换源必须连公钥一起换
   （只换 URL 一定验不过签）。回落会让人以为自己的设置生效了。

#### (c) 从零发布一个组件：`pnpm e2e:hub`（32 项断言）

发布链路横跨四个环节，每一环都有"看起来成功、其实没生效"的错法。单测验的是
`fake-hub.ts` **手搓的索引**；这个脚本验的是 `pnpm pack:plugin` 的**真实产物**。

```
生成临时密钥 → startStaticHub(空目录) → packComponent(免费) → packComponent(付费变体)
→ 真 server（env 指向这个 Hub）→ hub.status / hub.check / hub.install
→ app.create + component.install（source=hub、loaded=true、AGENTS.md 同步）
→ 付费：HUB_PAID_NOT_AVAILABLE 且磁盘不留目录
→ 篡改索引：reachable=false、原因指向验签、目录为空；还原后立刻恢复
→ component.remove：回到可安装，本机的包还在
→ 换一把公钥：bad-signature
```

为了让 CLI 与脚本走**同一段代码**，打包逻辑抽到了 `scripts/lib/pack.ts`
（`packComponent`），`pack-plugin.ts` 变成薄壳。分成两份的话，验收验的是"另一套打包器"。

#### 这一步顺带抓到两个真问题

1. **付费组件能被下载到本机**。`installComponent` 拦付费，而那是"装进应用"的入口；
   `hub.install`（"装到本机"）不拦 —— 包会原样落到 `~/.tenon/plugins/`。
   于是"付费"变成"付不了但能下载"。已修：`installFromHubIndex` 在**下载前**看索引的
   `pricing`，直接返回 `paid-not-available`（新错误码 `HUB_PAID_NOT_AVAILABLE`，409）。
   用索引判是安全的 —— 这一层误拒的代价是"用户看到一句暂未开放"，漏判的代价是
   "付费内容已经在磁盘上"。真判据仍在包里，两层不冲突。
2. **`packComponent` 没把 `pricing` 写进索引**。不写的话上面那道门永远不会触发。
   这是"发布了付费组件但客户端不知道"的典型漏法 —— 只有真的发一次才会发现。

3. **Agent 装付费组件会说"找不到组件"**（`tools/components.ts` 只看了 `problems`，
   `downloadError` 被忽略 —— 而"本机没有这个包"正好是 `missing`）。已改成先报下载侧原因。

**一个测出来的指纹坑**：`hubKeyFingerprint` 原本直接哈希入参，而 PEM 从文件读出来带尾换行、
从环境变量读出来被 trim 过 —— 同一把 key 得到两个指纹，界面就会误报"发布方换过密钥"。
已改成先 trim 再哈希，并在 `parseHubPair` 里把顺序固定为「先还原字面量 `\n` 再 trim」
（反过来会留下一个尾换行）。

### 4.36 应用能删、能改名了，未发布版本数看得见（界面缺口三连）

做了一次"还剩什么没完善"的盘点，撞上的第一件事不是设计欠账，是**一段死代码**：

`app.delete` 的后端从 M1 就在（还专门踩过"不能调 `chat.close()`"那个坑，`budget.test` 里钉着），
`useWorkspace.deleteApp` 也写好了 —— 但**界面上没有任何入口**，那个函数没有任何调用点。
于是用户建了几个试验应用之后，一个都删不掉，只能去删 `~/.tenon/home/apps` 目录。

这类漏法**不会被任何测试报警**：单测都在验 RPC，e2e 都在走既有的界面路径，而"应该有个按钮"
不是任何断言的对象。所以补的不只是 UI，还有一个专门验界面的脚本。

| 交付 | 落点 |
|---|---|
| 菜单里的删除 | `AppMenu`：hover/聚焦时出现垃圾桶，**就地二次确认**（不弹模态） |
| 删的是当前应用就自动切换 | `useWorkspace.deleteApp` 走 `selectApp`，顺带清掉改动面板（旧 sha 留着像数据串了） |
| 备份裸库一起清 | `apps.delete` 删 `<home>/backups/<appId>.git` |
| **改名**（`app.rename`） | 后端新增；菜单里 hover 出现铅笔，**就地输入框**。只改 `name`，slug 与目录不动 |
| **未发布版本数** | 顶栏「发布」按钮上的小徽标（`lib/release-hint.ts` + 单测） |
| 真机验证 | `pnpm e2e:apps`（18 项） |

**为什么改名不动目录与 slug**：目录名是 `appPaths` 的一部分，改它要搬 git 仓库、搬整个
PGlite 数据目录、改所有在跑的子进程 cwd —— 一次改名换来一次全链路迁移，而用户要的只是
"列表里那行字换个说法"。代价是名字与 slug 会不一致（`我的应用` / `wo-de-ying-yong`），
而 slug 从来没有展示给用户看过（只在 `appPaths` 与备份库文件名里用），所以这个不一致看不见。

**发布徽标为什么不是"能不能发"**：那要跑 typecheck + 测试，一次几十秒，常驻跑不现实。
"上次发布之后又改了几版"是**免费**的信息（commits 与 releases 本来就在内存里），
它回答的是"值不值得点开对话框去跑一次预检"。三个边界都真会发生，算法里分开处理：
从没发布过（数字是版本数，文案说"还没发布过"）/ 刚发完（不显示，而不是显示 0）/
发布点在最近 20 条之外（只能显示 `20+`，不能编精确数 —— 窗口大小是参数，不是写死的 30，
因为 `git.log` 的 `limit` 是调用方定的）。

**为什么二次确认就地展开而不是弹模态**：删应用是"我知道我在删什么"的操作，一个居中的
模态框反而会让人下意识去点默认按钮。就地展开还省掉一次焦点搬迁。

**为什么连备份裸库一起删**：应用不存在之后，界面上没有任何入口能 `clone` 那个裸库 ——
留着就是一个没人能访问、却占着完整历史的孤儿目录，删几个试验应用之后 `backups/` 会变成
一堆看不懂名字的目录。这与"删除不可恢复"是同一件事，确认文案里已经写明"包括已发布的备份"。

**`pnpm e2e:apps` 验的是界面**（`scripts/e2e-apps.ts`）：菜单列得出来 / 改名（预填原名、
保存后菜单显示新名、RPC 层也变了）/ 删除先要确认 / 取消后什么都没变 / 确认后菜单少一条
**且当前应用自动切到剩下的** / 发布徽标等于提交数 / `app.list` 与磁盘同步 / 备份裸库也没了。
它顺带成了第一条"从建到删"的界面旅程 —— 之前连"从界面建应用"都没有 e2e。

**写这个脚本时踩的两个坑**（都值得记）：

1. 删除进行中，那一行渲染的是确认区，**不渲染 `data-tenon-app`**。所以
   `waitFor('[data-tenon-app].length === 1')` 在 RPC 还没回来时就成立了 —— 断言"菜单少了一条"
   通过得太早，于是"当前应用切换"看着像坏了。正确条件是**两个都要**：确认区消失 **且** 数量正确。
2. 徽标依赖 `git.log`，而 `header` 出现的那一帧提交数还是 0。等"界面上有『个版本』"等于没等
   （那句一开始就是 "0 个版本"）—— 要等**徽标本身**出现。

### 4.37 脚本的 `@options` 能把超时上限放大到任意长

这是我们自己写的上限，**上游语义把它作废了**：

```js
// pi-codemode 的 runtime/execution.js
timeoutMs: options.timeoutMs ?? this.timeoutMs     // 脚本给的值优先
```

也就是说 `// @options: {"timeout_ms": 3600000}` 会让"一次脚本最多 60 秒"变成一小时。
后果不是"慢"：主角色派活之后会**一直等在这条调用上**，而界面上"没反应"和"卡死"分不出来。

修法是在**工具入口**看一眼脚本头（`checkScriptOptions`）：

| 决定 | 理由 |
|---|---|
| 上限 180 秒（默认 60 的三倍） | 批量处理上万条记录确实要几分钟；再长就该拆任务而 `setTimeout` 的极限是 24 天 |
| 越界就**拒绝**，不是静默改成上限 | 悄悄改成 180000，模型会以为它要的超时生效了，再对"为什么还是超时"做错误推理 |
| 语法错误不在这里报 | 交给上游工具（它的消息带行号与支持的字段），这里只管"合法但过分" |
| 包**工具**而不是改沙箱 | 沙箱拿到的已经是算好的 `timeoutMs`；在工具入口能在**起 worker 之前**拒绝 |
| 顺手夹 `max_output_tokens`（8000） | 那是唯一回到父会话上下文的东西，调成 100000 等于用一次调用撑满上下文 |

`checkScriptOptions` 是纯函数（不起 VM，单测 11ms 跑完 10 项），`withScriptLimits` 用假工具
验了"越界时原 execute 一次都没被调用"与"正常脚本原样转发"。

### 4.38 导出静态包：产物真的能拷走就跑

「发布」以前只有一半：冻结版本 + 本地裸库（§13.3），那是给人看的**代码备份**。
用户真正要拿出去的是**能上线的东西**，而 DESIGN §13.1 的两种产物（Docker 上下文、静态包）
一行代码都没有。这一步补的是静态包 —— 也是 Docker 那一档的**上游**（Dockerfile 就是
`COPY 产物 + node:22-alpine`）。

产物（`<home>/apps/<appId>/exports/<时间戳>/`）：

| 文件 | 谁写的 |
|---|---|
| `dist/` `dist-server/` `package.json` `pnpm-lock.yaml` | 模板自己构建出来的 |
| `node_modules/`（只含 prod） | 导出时 `pnpm install --prod --frozen-lockfile` |
| `serve.mjs` | **导出时生成**：单端口启动器（`/api/*` 反代 + 其余静态文件 + SPA fallback） |
| `start.sh` | 生成：查 `DATABASE_URL` → `exec node serve.mjs`（可直接执行） |
| `.env.example` `README.md` | 生成：要配什么、怎么起、**里面没有什么** |

四个关键决定：

1. **产物里没有 pglite。** PGlite 是预览用的零安装数据库，生产产物只认 `DATABASE_URL`。
   把 wasm + `pg-gateway` 塞进去等于让产物自带一个数据库运行时 —— 那是另一个产品。
2. **单端口靠一个生成的 `serve.mjs`，不改应用源码。** 模板的后端只监听 `127.0.0.1` 的
   `/api`，前端是静态文件；"一个端口对外"必须有人在前面分流。放进模板会让所有应用都
   背着一段生产代码（铁律 2 的反面），所以它是**产物的一部分，不是源码**。
3. **跑模板自己的 `build` / `build:api`**，不在导出代码里拼 `vite build`。Agent 可能改过
   `build`（加 prebuild、换工具链），自己拼就会与它脱节。
4. **默认带 prod 依赖**（`installDeps: false` 可关）。这让产物真的"拷到服务器就能跑"，
   代价是体积（全栈应用 136MB、纯前端 16MB）与导出时要联网。

**一个实现时才发现的坑**：导出要跑 `pnpm run build`，而"从没起过预览就直接导出"完全可能
（用户建完应用先去点了导出）—— 那时 `node_modules` 还没有，`vite: not found`。
所以导出第一步复用 preview 的 `ensureDeps`（它已经处理了超时、日志尾、打包态下的随包 pnpm）。

**验证**（`pnpm e2e:export`，22 项）：建一个 nest-api 应用 → 真导出 → 用 `PgliteProvider`
起一个**真 TCP 的 PostgreSQL** 顶替"用户自备的库" → 在产物目录里跑 `./start.sh` →
`/api/health` 200、首页 HTML、`/api/items` 真转到后端、未知路径回 index.html（前端路由）、
**不配 `DATABASE_URL` 时退出码非零且报错说清**。PGlite 顶替是刻意的：它证明产物只认
`DATABASE_URL`、不知道对面是 WASM 还是真 PG（铁律 2 的验证方式）。

界面入口在发布对话框里（`pnpm shot:export` 人眼验收）：按钮 → 「导出中… Ns」→ 产物路径 +
复制 + 「136MB · 19 个文件 · 含后端」。**不做成顶栏按钮**：导入/导出是同一刻的决定。

**这一档还没有的**：Docker 上下文（从静态包派生，验证要容器运行时 → 留给 CI）、
Git push（要凭据）、`lint` 进闸门。

### 4.39 Docker 产物：那一档从七月底挂到今天，终于落了

M2 第 8 步（Docker compose 产物）的阻塞原因一直写着"本机无容器运行时"。这次把运行时装上了，
所以它不再是欠账 —— 但装的过程本身有四个坑，记在下面，换台机器还会撞。

**产物**（`export.docker`，与静态包共用同一份构建）：

| 文件 | 说明 |
|---|---|
| `Dockerfile` | `FROM node:22-alpine` + 装 prod 依赖 + `CMD ["node","serve.mjs"]` |
| `docker-compose.yml` | 有后端时自带 `postgres:18-alpine`（`condition: service_healthy`），只映射一个端口 |
| `.dockerignore` | 第一行就是 `node_modules` |

三个决定：

1. **不做多阶段构建**。静态包已经在 Tenon 那侧 `pnpm run build` 过了；在镜像里再跑一遍
   就是两套构建环境，而"两台机器构建结果不一致"正是导出要消灭的东西。
2. **但依赖必须在镜像里装**。产物里的 `node_modules`（如果有）来自 macOS，镜像是 linux ——
   只要有一个原生模块，容器起来就崩，而报错看起来像应用代码的问题。所以 Docker 导出
   **不带宿主依赖**（`target: 'docker'` 时跳过 `pnpm install --prod`）。
3. **三个 build-arg 都是可选网络适配，不传就是官方行为**：`NPM_REGISTRY`（国内/内网装依赖）、
   `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY`（企业网络出网）。

**踩的四个坑**（都是"看起来像代码坏了"的那种）：

| 坑 | 症状 | 原因与修法 |
|---|---|---|
| `corepack enable` 装的是**最新** pnpm | `pnpm install` 报 "relax the policy that flagged them"，像依赖有问题 | 模板 package.json 没有 `packageManager` 字段 → corepack 装 pnpm 12，而 lockfile 是 pnpm 9 生成的，12 的供应链策略直接拒绝。Dockerfile 里 `corepack prepare pnpm@9 --activate` |
| compose 的 `${HTTP_PROXY:-}` | 容器里 `pnpm install` 报 `tunnel error` | 它自动读到了**宿主**的 `127.0.0.1:PORT`，而容器里的 127.0.0.1 指向容器自己。改成不读宿主变量，只认显式的 `BUILD_HTTP_PROXY` |
| 容器直连 registry | `UND_ERR_CONNECT_TIMEOUT` | 这个网络下直连 4.3MB 要 2 分钟（35KB/s），pnpm 一定超时。国内镜像源 0.3 秒 |
| 模板字符串里的反引号 | `TS1005: ';' expected`，看着像别处坏了 | 注释里写 `` `corepack enable` `` 会提前结束模板。**这个坑我踩了第三次** |
| `postgres:18` 的卷挂载点 | db 容器 `unhealthy`，`app` 根本没启动，`compose up` 报 `dependency failed to start` | 18 起 `PGDATA` 挪到了 `/var/lib/postgresql/18/docker`，卷必须挂 `/var/lib/postgresql`（不是 `.../data`）。第一版按 17 的写法生成，只有真跑起来才会发现 |

**验证**（`pnpm e2e:docker`，**全栈 21 项 / 只有前端 12 项**）：建应用 → 导出 → 断言产物形状
（没有 `node_modules`、`dist-server` 在、compose 只映射一个端口、密码没有默认值）→
`docker compose up -d --build` → db 变 healthy → app 起来 → 首页返回 HTML →
`/api/health` 200（**迁移在容器里跑完了**）→ `/api` 真转到后端 → `down -v --rmi local` 干净拆掉。

**它按能力自动降级**：`postgres:18-alpine` 有 433MB，某些网络下拉不动；那种情况下跑纯前端应用
（构建 → 镜像 → 容器 → 静态服务），并打印"数据库那条没验，先 `docker pull postgres:18-alpine`"。
**跑能跑的那部分并说清缺什么，比一个笼统的失败有用。**

**本机 docker 环境的两个持久坑**（都在 §5，已经做成自愈）：虚拟机里 `/etc/resolv.conf` 是悬空的
systemd-resolved 链接，导致**根本没有 DNS**（之前 pull 能成是因为走代理，域名由代理解析 —— 所以这个
坏点被藏了很久）；colima 每次 `start` 都会重写 `/etc/docker/daemon.json`，把 `registry-mirrors`
吃掉。两件都挂在 `docker.service` 的 `ExecStartPre` 上（`/usr/local/bin/tenon-vm-fix.sh`），
所以**重启虚拟机之后仍然有效**（已实测：stop → start → `docker info` 仍有镜像加速、`resolv.conf`
仍是真文件、镜像都在）。修好之后 `postgres:18-alpine` 从"16 分钟拉不动"变成 **51 秒**。

### 4.40 真 PostgreSQL：迁移搬得过去，快照也退得回来

这一档以前一直写着"本机没有 Docker / 没有 PG，所以没实测"。装好 Docker 之后补上，
顺便把 `postgres` 档快照里那个 `pg_dump` 依赖彻底去掉 —— 因为一验就发现它不是"待补"，
而是"在用户机器上基本不会成立"。

**先说清楚原来缺什么**（不是缺测试，是缺两件事）：

| | 原来的状态 | 为什么不行 |
|---|---|---|
| 跨档迁移 | `pglite → pglite` 验过（真协议、真 SQL，但同一个引擎） | `information_schema.columns` 的 `is_identity` / `identity_generation`、`pg_get_serial_sequence()`、`setval()` 对 identity 序列的效果，三处都可能与真 PG 有差异；只要有一处不同，就是"迁移全绿、用户点新建 500" |
| 发布档快照 | `pg_dump --format=custom` + `pg_restore` | 用户有 PG **服务器**不等于本机装了 `pg_dump` **客户端**；而这个功能只在回滚那一刻才被用上 —— 那时报 `DB_UNSUPPORTED` 等于它不存在 |

**改法**：

1. `rows-snapshot.ts`（纯 JS）：逐表读出 → 自描述 gzip JSON（`format` / `version` / `tables[columns,rows]`）；
   还原 = **一个事务**里按外键逆序 `delete`、正序 `insert`、`setval` 对齐序列。
   不做 `TRUNCATE ... CASCADE`：那会连**不在快照里**的引用表一起清空，等于替用户删数据。
2. 迁移的校验语义改了：**`目标(后) == 目标(前) + 实写`**。原来是「源 == 目标」，
   在"目标库已有迁移之后新写的数据"时会把一次**正确**的重跑判成失败，
   提示还是"先清空目标表再迁"—— 那是在建议用户删数据。现在 `on conflict` 跳过的行数
   如实进报告的 `skipped`（`totalSkipped` 汇总）。
3. 内省（表 / 列 / 外键 / 行数）抽成 `introspect.ts` 一份，迁移与快照共用 ——
   否则迟早出现"迁移认得生成列、快照不认得"这种只修一半的偏差。

**验证**（`pnpm e2e:postgres`，31 项，真 `postgres:18-alpine` 容器）：
起真 PG → PGlite 建 4 张表（identity ALWAYS / 生成列 / serial / FK 父子 / 自引用树 /
jsonb / `text[]` / bytea / 中文与 emoji / NULL）→ 真 PG 建同构表 → 迁移 →
在**真库上**验生成列由库算、numeric 精度、数组与 jsonb 原样、bytea 十六进制一致、
timestamptz 是 Date、NULL 仍是 NULL、树搬得过去 → 新建记录 id 续号（serial 4 / identity 3）→
重跑幂等（写 0 行、跳过 11 行、行数不变）→ 缺表时明确报错并指名 →
快照 dump → 清空并重写 → restore → 值逐列一致、序列继续往后。

单测 7 项（PGlite 顶替真 PG，12s）：快照形状（生成列不进快照、bytea 打了标）、
还原后 jsonb/数组/bytea/时间戳逐列一致、序列对齐、缺表跳过、格式不认识时明确报错、
删了一列时**值不错位**。

**这轮抓到的一个真 bug**（最危险的那种，写在 §5）：删掉一列后，插入按"行数组前 N 个值"
取值，于是整行数值往前错一位 —— 类型相容就是**静默写进错误的列**，类型不容才报
`malformed array literal`。修法是按**列名取下标**（`indexes = columns.map(name => table.columns.indexOf(name))`）。

**还没覆盖的**：快照对超大库（百万行级）会把整库读进内存，没有流式 / 分片；
`bytea` 走 base64 会比原体积大 33%；这些在"生成应用"的量级（几十张表、几万行）不是问题，
但换到数据导入场景要重做。

### 4.41 跨应用用量：看得见"我一共花了多少"

在此之前，用量面板一次只看一个应用。真实场景是：5 个应用各设 $5 额度，跑三天忘了，
一共 $75 而你不自知 —— 因为**没有任何一处**把 N 个应用的账加起来。

**`usage.total`**（新 RPC）返回 `{ 合计, 每个应用一行, failed[], priced }`，
面板顶部多一行「全部应用」。三个实现要点：

| 决定 | 为什么 |
|---|---|
| **不 `acquire()` 每个应用**，开"最小 harness"读账本 | `acquire()` 会建 5 个扩展（`codeact` 起一个 worker 线程）、`configure` 根会话、还调 `resume()` —— 等于为了看一眼别人花了多少钱，把别人被中断的任务也接着跑了。最小 harness = 同 storage + 共享 models + 空 registry + **不 resume**，实测 **16ms 一个** |
| **`known` / `failed` / `priced` 三格必须都在** | 分别对应三种"看起来像数字、其实是假的"：还没账本被读成花了 0、读失败被读成 0、没配价格被读成 $0。少一格这个数就会骗人 |
| **15s 缓存，任何一次 `refresh()` 立刻作废** | 面板上"本应用"动了、"全部应用"没动会看着像 bug；但每次开关面板都扫 N 个库也没必要 |

**顺手改了数字口径**：`formatTokens` 原来 `>= 10k` 就取整，于是截图里出现
`6.3k + 4.2k = 10k` —— 汇总功能的存在意义就是"把几行加起来看"，这种不自洽会先被质疑。
改成 10k~99.9k 保留一位小数（`10.4k`），误差从 5% 降到 ±0.1，代价是表头 chip 宽一个字符。

**验证**（`usage-total.test.ts`，5 项，起真 server + faux 模型跑真对话）：
合计 = 各应用 `usage.get` 之和且逐项相等 / **重启后不先打开应用也能汇总**
（这一条才真正走到"只读账本"那条路 —— 一旦调过 `usage.get`，服务就把会话缓存了）/
没跑过的应用 `known: false` 且不计入 / **账本读不到进 `failed` 且不加进合计**
（用 `chmod 000` 造真失败）/ 应用被删后从汇总里消失。

**人眼验收**（`pnpm shot:usage`，真 Chromium）：三个应用（跑两轮 / 跑一轮 / 一轮没跑），
截图看 288px 宽的面板里长应用名会不会挤爆、数字对不对得上、"还没跑过"和"花了 0"是否真不一样。

**仍然没有的：全局上限。** 现在有"看得见"，没有"拦得住"。要"这个月最多 20 美元"，
得先解决"按月"—— 账本是累计值，没有时间维度。先不做，比做一个看起来像上限、
实际不拦的开关好。

### 4.42 质量门禁进了 CI（第一次跑就抓到两个真问题）

之前一直没做，理由很实在：**仓库没有远端**，workflow 写了也不会跑，等于写一份不执行的配置。
接上 `github.com/jackzhujie/tenon` 之后它才有意义，第一次跑（4 分钟）就抓到了本地永远抓不到的东西。

**只做三步**，理由写在 workflow 文件头：

| 跑 | 不跑 | 为什么 |
|---|---|---|
| `typecheck` / `test` / `build:web` | `e2e:*`（docker、真 PG、Electron） | runner 未必有容器运行时，而且那些脚本本来就是"手动在真机上跑"的；塞进来会得到一堆需要 sudo / GUI / 大镜像的步骤，失效时没人愿意修 |
| — | 三平台打包 | mac 不签名会被 Gatekeeper 拦，要 Apple 账号（$99/年）。单独做，别和质量门禁混在一起 —— 门禁要快、要稳、要能天天绿 |

两个细节：pnpm 版本不写在 workflow 里（交给 `pnpm/action-setup` 读 `packageManager`，
写两遍就会出现"CI 用 9、本机用 10"）；`--frozen-lockfile` 让 lock 与 `package.json`
不一致时**当场失败**，而不是在 CI 里悄悄装出另一套依赖。

**第一次跑就抓到的两个真问题**（同一个病）：

| 报错 | 真因 |
|---|---|
| `Cannot find module 'isomorphic-git'`（`release.test.ts`） | 该包只声明在 `@tenon/core` 里，server 的测试直接 import 了它 |
| `Cannot find module '@babel/types'` + `Parameter 'a' implicitly has an 'any' type`（`babel-plugin-tenon-loc.ts`） | 只声明了 `@babel/core`（那是传递依赖），直接 import 的类型没声明。后面那个 any 是它的并发症 |

**为什么本地一直通过**：`/Users/mac/node_modules/` 里恰好有一份（家目录里不知什么时候装的，
160 个包）。Node 解析会一路往上找，找到了就"通过"；CI 在 `/home/runner/...`，没有这个目录。
**这类问题本地永远自测不出来 —— 这就是要有 CI 的理由。** 两处都补成了显式 devDependency
（版本与已有的一致：`isomorphic-git` 1.44.8、`@babel/types` 8.0.10，避免同仓两份）。

排查手法值得记：**逐个 import 做真实解析，只看结果落在哪**（落在 `~/node_modules` 就是未声明）。
比"看 package.json 里有没有"可靠 —— 传递依赖、模板目录、ESM-only 包都会误报，必须看解析结果。

**现在的基线**：GitHub Actions `ubuntu-latest` + Node 22，4 分钟绿（`Test Files 77 / Tests 700`）。

### 4.43 协议落地：把建仓时的默认 MIT 换成分区授权

DESIGN §16 早就定了「AGPL-3.0-only 主体 + Apache-2.0 运行时 SDK/模板 + CC BY 4.0 文档 +
商业双许可」，README 的 License 段也一直这么写。但**仓库里那份 `LICENSE` 是 GitHub 建仓时
默认塞的 MIT** —— 文档说一套、仓库是另一套，而真正有法律效力的是后者。

**这件事有时间窗**：MIT 是永久授权，谁拿到副本就永久可以用、可以再分发。
发现时仓库刚公开一个多小时、`forks=0 stars=0`，所以直接换掉；再晚就换不了了。

改了什么：

| 文件 | 内容 |
|---|---|
| `LICENSE` | AGPL-3.0-only 全文（34KB，取自 gnu.org，不手抄） |
| `packages/runtime-sdk/LICENSE`、`packages/generator/templates/LICENSE`、`plugins/LICENSE` | Apache-2.0 全文 |
| `docs/LICENSE` | CC BY 4.0 全文 + 一段署名说明 |
| `NOTICE` | 按目录的分区映射、为什么这么分、商业授权边界 |
| 17 个 `package.json` | `license` 字段（主体 AGPL-3.0-only，`runtime-sdk` 是 Apache-2.0） |
| `README` 的 License 段 | 从三行列表改成表格 + 「个人免费 / 公司内部多人部署要商业授权」+ 商标声明 |
| `CONTRIBUTING.md`、`SECURITY.md` | DESIGN §16.4 要求的治理件（DCO、clean-room 红线、私密披露） |

**一个原设计没写、这次补的判断**：`plugins/` 也归 Apache-2.0。组件是装进**用户应用**里跑的，
如果它是 AGPL，「生成物绝不传染」这句话就没法向用户解释；而组件不是护城河，Server 才是。

**没做的**：`DCO` 没有强制（本地无法校验，靠 `git commit -s` 自觉；真要强制得加 CI 检查
`Signed-off-by`，现在没加）。商标只做了声明，没有申请。

### 4.44 每次派活花了多少（不是"按角色累计"）

起因是一个问题："用量按角色归属好实现吗？必要吗？" 查下来两件事要分开答。

**能不能做**：能，而且比我原先以为的容易 —— 三条都是公开 API，不用改宿主：

| 事实 | 依据 |
|---|---|
| 账本本来就是按会话记的 | `harness.usage()` 内部就是 `scanConversations` 逐个读 `pi.usage` 再加起来，粒度一直在，只是被求和抹掉了 |
| 读单个会话的用量是公开 API | `UsageDoc` 从包入口导出，`harness.snapshot(UsageDoc, conversationId, ctx)` 是公开方法 |
| 会话列表要绕一层 | `harness` 上没有 `scanConversations`，得 `harness.commit(tx => tx.scanConversations(…))`；`harness.storage` 也是公开的 |

**该不该做**：**累计版不该做**。三条理由：

1. **会被历史稀释** —— "这个应用 explore 一共花了 12k"是十几个任务摊出来的平均数，
   指导不了"下次还该不该派 explore"。
2. **旧数据永远缺归属** —— 改动之前的所有会话都没有角色标记，面板上会长期挂一行"未标注"。
3. **不影响任何控制逻辑** —— 熔断按应用，角色归属纯解释性。

**做了的**：**单次派活的成本**。"这次 explore 花了 8.1k"直接告诉你"这个任务值不值得派给子角色"，
而且没有旧数据问题（只影响新派活）。实现是一条直链：

```
subagent 派活结束 → harness.snapshot(UsageDoc, child.id) 读子会话账本
                  → api.details({ …, spend })            （工具结果的结构化信息）
                  → normalize.ts 从 details 挑出 spend   （形状不对就当没有）
                  → MessagePart.tool.spend               （协议，前端可见）
                  → 对话里那条工具行右侧显示 "8.1k"
```

四个决定：

- **失败也记**。派出去但没给出结论的那次同样烧了钱，用户更需要看见。
- **读不到就不写**（返回 `null` 而不是 0）。工具结果不该因为一段统计而失败，
  而 `0 tokens` 会被读成"这次派活不要钱"。
- **成本为 0 时不显示金额**。`faux` 不报价，写 `$0` 会被读成"很便宜"（与面板同一条规矩）。
- **不进模型上下文**。只走 details，不拼进工具结果的文本 —— 模型看到 token 数会开始
  为省 token 而少读文件，那不是我们想要的行为。

**还没做的**：累计按角色。触发条件（任一）：按角色配额/计费、多人协作按人出账单、
出现"某个角色在烧钱"的真实事故需要长期趋势。

**验证**：`packages/server/test/subagent.test.ts` 加了三条断言 ——
details 里的 `spend.totalTokens > 0`（账本真读到）、`chat.history` 的工具 part 上也带着它
（界面能看到的那一层）、**别的工具不会凭空带这个字段**。

### 4.45 公开仓库的门面：README 说「规划中」、以及一份本该不在仓库里的文件

仓库接上远端之后做了一次"还剩什么"的盘点。**代码缺口之外，门面（第一个访客看到的东西）
的问题其实更急** —— 因为它影响的是"别人要不要往下看"，而代码缺口只影响"用起来顺不顺"。

#### 一、README 的顺序是反的

改动前的阅读顺序：`核心特性（**规划**）` → 平台 → 文档 → 状态（**120 行里程碑流水账**）
→ 第 125 行才出现 `pnpm install`。三处硬伤：

| 问题 | 事实 |
|---|---|
| 标题写「核心特性（**规划**）」 | 列的 11 条**全部已实现**，还多出静态导出、Docker 上下文、组件商店 |
| 「状态」段 120 行 | 写着「M1–M5 完成，M6 走到第 4 步」——实际 M6 全收口，之后又做了 §4.36–§4.44 |
| 「怎么跑」被埋在第 125 行 | 要先翻过一整段里程碑才能看到三条命令 |

改法：新增 **「快速开始」放第 3 节**（Node/pnpm 版本、三条命令、怎么接真模型、数据在哪）；
「状态」从 120 行压成**一张 10 行能力表**，细节全部指向 STATUS ——
**README 讲"能做什么"，STATUS 讲"怎么做的、坑在哪"，两边不再各抄一份**（正是这种双写
造成了"518 个测试" / "界面半边是下一步"这类过期句子）。
新增的「开发与验证」把 22 个脚本整理成表格（项数 + 验什么 + ★ 标真机全链路）。

**验证方式是真跑，不是读一遍**：`git clone` 到 `/tmp`（那里没有 `~/node_modules` 兜底，
是真实新访客环境）→ `pnpm install`（6.2s，store 命中）→ `TENON_HOME=/tmp/… pnpm dev:web`。
结果：server 起在随机端口 `50647`、**模型是 `faux · faux-mini`（确认"不需要 API Key"这句话成立）**、
Vite 在 **5173**（与 README 写的一致）、首页 `HTTP 200 / 570 字节`真的是页面、
全新建的 `TENON_HOME` 自动长出 `secret.key` + `tenon.db`（"删掉等于重装"成立）。

#### 二、`docs/REVERSE_ENGINEERING.md` 在公开仓库里

README 的文档表写着「内部研究用（**不随开源发布**）」，STATUS 的仓库清单写着「仅内部」——
**而文件一直是 tracked 的，GitHub 上直接能打开**。内容是妙搭的逆向操作手册
（采集路线、HAR 采集清单、rea 工具调用序、分析目标），54 行。

性质判断：它是**我方方法论**，不含被分析方的代码 / 文案 / 提示词（clean-room 红线没破），
所以不需要按侵权处理。但"声明与事实相反"本身必须修 —— 而且这份文件对开源用户没有任何价值
（里面的工具是本地 rea MCP，路径是本机 `~/project/miaoda/docs/reverse/`）。

做法：`git rm --cached`（**本地文件保留**，你还看得到）+ `.gitignore` 挡住，
README 删掉那一行（外部读者看不到它，列出来只会困惑），STATUS 改成"已移出版本库"。

**没做的（如实记）**：历史里仍然有。要彻底清除得重写历史（`git filter-repo`），
而那会让 STATUS / 记忆里引用的一堆真实 sha 全部失效 —— 代价高于收益，
因为内容本身不是侵权材料。这个取舍留给仓库主决定。

#### 顺手删掉的一条假欠账

`SelectionContext.screenshot` —— 协议里**根本没有这个字段**（只有 `kind` / `route` / `loc` /
`selector` / `rect` / `text` / `styles` / `elements` / `viewport`）。当初想过"截图给 Agent 看"，
落地时选了**结构化描述**而不是像素，更省 token 也更准。留着这句会让下一个人去找一个不存在的缺口。

### 4.46 `lint` 进模板与门禁（DESIGN §8.6 那条链第一次完整）

DESIGN §8.6 从 M1 就写着 `tsc → eslint → vitest → build`，但**模板里一直没有 eslint 配置** ——
所以门禁只有 `typecheck` 与 `test` 两项，`checks.ts` 的 `LABEL` 也只有两个键。这次补上。

**模板侧**（`react-vite` / `nest-api` 各一份 `eslint.config.mjs` + `scripts.lint` + 三个 devDependency）：

| 决定 | 理由 |
|---|---|
| **规则只有三条**：`no-unused-vars`（`_` 前缀豁免）、`rules-of-hooks`（error）、`exhaustive-deps`（**warn**） | 开 `recommended` 全家桶的话 Agent 生成一次红一次（`no-explicit-any`、风格规则全在里面）。**红的次数一多，用户会去关掉 lint —— 一个被关掉的检查等于不存在**，还不如不加 |
| **eslint 装在应用自己的 `devDependencies`** | 配置是**用户应用的资产**：跟着导出走、可以被用户改。代价是每个应用多约 12MB，换来的是"这份配置属于你，不是 Tenon 借给你的" |
| **`exhaustive-deps` 只 warn** | 生成代码里"我就要用一次当时的值"很常见，语义上未必是 bug。设成 error 会让它成为最常见的发布拦路石 |
| **不用 `tseslint.configs.recommended`** | 那套预设包含 `no-explicit-any`（error）等，对"Agent 生成的代码"这个场景等于必红。规则要按场景挑，不能按"推荐"抄 |

**门禁侧**（`runLintScript`，第三项，与另两项并行）：

- **只认 `scripts.lint`**，不猜 eslint / biome / oxlint —— 猜错的表现是"跑了个不存在的命令，退出码 1"。
- **没有 `scripts.lint` → `skip`**（配置性选择，照发不误但要说出来）。
- **"命令没装"与"代码有问题"必须是两句话**。前者让用户去 `pnpm install`，后者让用户去改代码。
- **截断取头部**（与 test 相反：测试的有用信息在尾部堆栈，lint 的在第一个文件的第一个错误），
  但把最后那行 `✖ N problems` 单独补回来 —— 那是"到底多少个"的唯一来源。

**Reviewer 有了第三个工具**（`git_diff` → `typecheck` → `lint`），提示词里加了第 3 步。
理由：lint 查的是 tsc 看不见的两类问题 —— 未用变量（**往往是改到一半的证据**：旧实现没删干净）
和条件调 hook（运行时才炸）。只给门禁不给 Reviewer，Agent 只会在发布那一刻才发现。

#### 这轮踩到的两个真问题（都不是测试写错）

**① `kill` 只杀了 pnpm，孙进程握着 stdout → 门禁会一直转圈。**
`runTestScript` 一直是 `child.kill('SIGKILL')` + 等 `close`。但我们 spawn 的是 `pnpm`，
它再 spawn `eslint` / `vitest`；**父进程死了管道没关，`close` 永远不来**，
`await` 就挂着 —— 用户看到"发布检查中…"永不结束。这个 bug 在 test 那半边**存在了很久**，
只是没有任何用例覆盖超时（我写 lint 超时用例时它才炸出 30s）。
修法：`detached: true` 进自己的进程组 + 超时用负 pid `killTree()` + **超时立刻 resolve，不等 close**。

**② `MISSING_COMMAND` 一开始把 `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 当判据 —— 那会把所有真失败误报成"没装依赖"。**
那行在**任何** pnpm 失败里都会出现（真跑模板时亲眼看到 `ELIFECYCLE  Command failed with exit code 1.`）。
只看 shell 的 `: command not found` / `is not recognized as an internal or external command` / `Cannot find module 'eslint`。

#### 顺手消掉一处重复定义

`ReleaseDialog.tsx` 有第二份标签表（`{ typecheck, test }`），与 `checks.ts` 的 `LABEL` 重复。
加第三项时只改一处就会出现"记录里是「Lint ✓」、界面上是 `lint ✓`"。收进 `protocol` 的
`CHECK_LABELS`，两边都引用它。

#### 验证

**模板是真装依赖真跑的**（不是"配置写对了就行"）：

| 模板 | 干净安装 → `pnpm run lint` | 故意插一个未用变量 |
|---|---|---|
| `react-vite` | 退出码 0 | 退出码 1，`src/App.tsx:48:7 error 'tenonUnusedProbe' is assigned a value but never used` |
| `nest-api` | 退出码 0（NestJS 的构造参数属性没被误报） | 退出码 1，`api/items/items.service.ts:32:7` 同样命中 |

**最后那一列是关键**：只验"退出码 0"的话，`files` 模式写错（一个文件都没匹配到）也会是 0 ——
那就是典型的假绿。插一个未用变量才算证明它真的在看文件。

单测：`checks.test.ts` 20 项（lint 7 项，含"命令没装不说成没过"、超时、截断取头部）、
`review-tools.test.ts` 15 项（lint 4 项，含"没跑成绝不带 ✓"）、
`release.test.ts` 加一条"lint 没过同样拒绝发布且不留 tag"。
端到端：`e2e:release` 45 项（含"清单里三项都在且逐个点名"）、`e2e:preview` 18 项（真建应用 +
装依赖 + 起预览，证明模板多那 12MB 没破坏安装链路）。

**没做的两件（如实记）**：

1. **Tenon 自己还没有 eslint**。只给**生成的应用**接了：它们从零开始、量小，规则一开就干净。
   本仓库几万行，同一套规则开下去是几千条历史问题 —— 那是一次专门的清理工程，
   不是"顺手加一下"。**现状是"我们要求生成的应用过 lint，自己的代码没过"**，
   这件事要么接受、要么排期清，不能装作不存在。
2. **发布对话框的第三行没截图验收**。但确认了它是**遍历 `checks` 渲染**的
   （`CHECK_LABEL[check.id] ?? check.id` + `summary`），所以第三行会自动出现 ——
   剩下的风险只是"三行会不会把对话框撑高"，不是"会不会不显示"。

## 5. 已知陷阱（都踩过，别重踩）

| 陷阱 | 说明 |
|---|---|
| **`PGlite` 的 `pool.max` 必须是 1** | 不是调优建议。`pool.max=2` 时两条连接的事务落在同一个 backend 会话上，一条 `ROLLBACK` 会抹掉另一条已写入的行（实测 `iso-A` 丢失）。收益只有 19% p95，不值得 |
| **`harness.resume()` 不能忘** | server 启动序列少了这句，崩溃恢复能力等于没有（spike 1 就是这么验证的）|
| **`ELECTRON_RUN_AS_NODE` 的正确用法** | `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`；不要额外打包 Node |
| **pi 依赖 `node:sqlite`** | Electron 内置 Node 有该模块（已验证），所以不能在 `node_modules` 里补 `better-sqlite3` 之类原生模块 |
| **安装包内原生模块：放开（v1.2.13）** | 原先要求"零原生模块"（v1.2 的收益），现已**撤销**为偏好 —— 安装包预编译分发，用户机器不需要 node-gyp。`build.mjs` 改为**审计**（列清单 + 体积 + 平台标签），不再失败；要卡住设 `TENON_STRICT_NATIVE=1`。**不变的边界：生成应用的依赖仍不引入需按平台编译的包**（用户在本地 `pnpm install`） |
| **PGlite 冷启动 2.4s / 每应用 38MB** | 建应用与快照都要算这笔账：`app.create` 要给分阶段进度，`dumpDataDir` 约 4.5MB、0.7s |
| **LISTEN/NOTIFY 不可用** | PGlite + pg-gateway 下监听端收不到通知（实测 0 条）。后端推前端只能走网关 SSE |
| **HMR 首帧会丢** | 客户端要在 WS 握手**之前**挂好 `message` 监听，否则丢掉 Vite 的 `connected` |
| **taskGraph 静止时为空** | 任务结束节点会被回收；状态面板要在跑动中采样，静止时展示"上次结果" |
| **端口探测跨平台** | Windows 无 `lsof`，用 `netstat` / `Get-NetTCPConnection` |
| **`gondolin` 在 Windows 无后端** | 不在 Windows 启用；L3 组件走「独立子进程 + 权限清单」（DESIGN §15.3 方案 B）|
| **不要用 `reset --hard` 做回滚** | 一律 `git revert`，保留历史 |
| **产品库与应用库是两件事** | 别把 `tenon.db`（SQLite）和用户业务库（PG）混为一谈 |
| **无 API Key 也能开发** | `pi-ai` 自带 `providers/faux`（`fauxProvider()` + `fauxAssistantMessage()`），CI 与本地都用它，别 mock harness |
| **`git.statusMatrix` 会漏改动** | isomorphic-git 的 stat 快路径把**同长度、同一毫秒**的改动判成"没变"（`v1\n`→`v2\n` 返回 `[1,1,1]`），`WORKDIR` walker 的 `oid()` 也返回旧值。`commitAll` 已改为自算 blob oid + `add({force:true})`，见 `packages/core/src/git.ts`。**别改回去** |
| **`pi.live` 没有 token 增量** | 它只有 `{run,generation:{attempt}}`。流式必须用 `watchEvents(...)` 的 `message_update.changes[].type==='text_delta'` |
| **`message_end` 对用户 entry 也触发** | 服务端只推 `role === 'assistant'` 的 `message.end`，否则前端会重绘自己刚发的气泡 |
| **SSE 必须先连上再提交** | 与 HMR 首帧同一个坑。`GET /events` 建连时立刻写 `: connected`，测试/前端要等它再发 `chat.submit` |
| **`defineDoc<T>` 的 T 必须用 `type` 不能是 `interface`** | 约束是 `T extends JsonObject`，而只有类型别名会拿到隐式索引签名；interface 会报「缺少索引签名」 |
| **模型密钥不能塞 `process.env`** | 生成应用的子进程会继承环境变量，那是真实泄漏面。`packages/agent/src/models.ts` 用 `createProvider` + `api/openai-completions` 现场拼 provider；bash 工具另有一道 `scrubEnv`（按名字洗掉 `*_KEY/TOKEN/SECRET` 与 `TENON_*`）|
| **`pi-coding-agent` 的工具签名 ≠ `pi-durable` 的** | 前者 `execute(toolCallId, params, signal, onUpdate, ctx) → AgentToolResult`，后者 `execute(args, api, context) → ToolExecutionResult`。必须过 adapter（`packages/agent/src/tools/coding.ts`），别试图直接塞进 registry |
| **`edit` 的入参是 `edits: [{ oldText, newText }]`** | 不是 `old_string`/`new_string`。照 `pi-coding-agent` 的 schema 写，自己另造一份会静默变成"工具报错 → 模型重试 → 死循环" |
| **`section()` 的 key 只能 `[a-z][a-z0-9_-]*`** | 写成 `tenon.workspace` 会让**每一轮 submit** 直接抛 `INTERNAL: Section key ... must match ...`。不是渲染问题，是整轮失败 |
| **upgrade 透传之后两侧 socket 必须成对销毁** | 客户端断开时 `upstream.destroy()`，反之亦然。漏了不报错只会漏水：Vite 每次整页刷新重连一次 HMR，几百次后 dev server 撞 FD 上限。**测试里表现为 `server.close()` 永远等不到回调、卡在 afterEach** |
| **`StartServerOptions.env` 是「覆盖对象」不是「完整环境」** | 直接拿它当子进程 env 会抹掉 `PATH`，`pnpm install` 以 `code=null` 失败、报错只说"退出码 null"。`PreviewManager.spawnEnv()` 先 `{...process.env, ...env}` 再 `scrubEnv` |
| **模板的 `{{x}}` 绝不能漏进应用** | `renderTemplate` 渲染后残留占位符直接抛 `TEMPLATE_VAR_LEFT`；`template.json.variables` 声明过的变量缺失抛 `TEMPLATE_VAR_MISSING`。有测试逐文件扫描占位符并核对声明 |
| **铺模板必须在 `initRepo` 之前** | 否则建应用会产生两个 commit（一条空提交 + 一条模板提交），历史看起来像改坏了 |
| **`@vitejs/plugin-react` 6.x 的 peer 是 `vite@^8`** | 模板用 vite 7 就必须配 5.x。装错只会得到一条 `unmet peer` 警告，然后在启动时以看不懂的方式失败 |
| **模板目录不是 workspace 包** | `packages/generator/templates/react-vite/package.json` 不能被 `pnpm install` 当成成员（glob 只到 `packages/*`）。发布时要 `extraResources` 带上整个 `templates/`，或用 `TENON_TEMPLATES_DIR` 指过去 |
| **状态只写库不推事件，前端永远不知道这一轮结束** | `chat.ts` 的 `setStatus()` 现在同时落库 + 推 `app.status`；而且**先提交 git 再发 idle**，否则前端看到"空闲"时版本列表还是旧的 |
| **submission 的 settle 回调可能晚于 `close()` 到达** | 那时 `tenon.db` 已关，写库抛 `database is not open` → unhandled rejection（表现为"33 项测试全过但有 2 个 error"）。`ChatService` 有 `closed` 门；写状态还要 try/catch |
| **测试闸门不能等 `git.commit`** | 这一轮没有文件改动就不会产生提交，等它会一直挂到超时。等 `app.status: idle`（它在提交之后发）|
| **`startGateway` 不传 `port` = HMR 永远不工作** | 端口是**先占后告诉**的：`findFreePorts` 占下 `gwPort` → 写进 `TENON_GATEWAY_PORT` → 模板用它做 `server.hmr.clientPort`。网关若自己再随机挑一个，浏览器就被指去那个没人监听的端口。**页面照常打开、日志干净、连 `url` 的探针也能连上**，只有热更新永远不来。断言要落在「`url` 的端口 === `gatewayPort`」 |
| **`.bin/<cli>` 是 shell 包装，不能用 `node` 跑** | `spawn(process.execPath, ['.bin/tsx'])` 会得到 `SyntaxError: missing ) after argument list`（那是 `sh` 脚本）。要读包自己的 `package.json.bin` 拿 `.js/.mjs` 入口再交给 node —— `scripts/dev-web.ts` 的 `resolvePackageBin()` |
| **`app.delete` 不能调 `chat.close()`** | `close()` 会把 `closed` 置上，那是**全局**开关 —— 之后所有应用的 `app.status` 都不再落库也不再推事件，界面永远转圈，日志里一个字都不报。删应用要用 `chat.detach(appId)`（只停这一个的 watcher / inflight / 合帧缓冲） |
| **`faux` 的 `cost.total` 恒为 0** | 本地假模型不报价，但它**会**报 token。所以"只按美元做预算"在本地一条测试都验不了；反过来只按 token 又对不上真模型的账单。两个维度都要，且测试用 token 验 |
| **用量不能在前端累加** | `pi.usage` 是**会话级**的：子 Agent 的花费记在它自己的会话里（父会话的事件流里根本没有），压缩摘要那次调用连 entry 都不产生。加上断线重连会按 `since` 重放事件，累加器还会把同一笔算两遍。真值只问 `harness.usage()` |
| **进程开始关之后别再碰 harness** | 这一轮 settle 晚于 `close()` 时去读 `harness.usage()`，会把 sqlite 拽住 —— 症状不是报错，而是测试清理临时目录时 `ENOTEMPTY: directory not empty`。所有"收尾再做点什么"的地方都要先 `if (this.closed) return`（`commitTurn` 早就是这么写的） |
| **`harness.usage()` 只给按模型/工具的聚合** | 想回答"哪个子角色花了多少"它答不了：子会话的账在它自己的桶里，聚合层看不见归属。要分摊只能自己扫会话读 `pi.usage` —— 现在没做，面板只报总数与按模型的账 |
| **浏览器别 import `@tenon/protocol` 主入口** | 主入口的 `z.object(...)` 全在模块顶层求值，rollup 无法 tree-shake。实测 356KB → 256KB（146 → 48 个模块）。前端只 import `@tenon/protocol/browser` |
| **flex 子项少了 `flex-1` 会静默塌成 0 高** | 两栏根节点是 `<section class="flex flex-col">` 的子项，不给增长就退回内容高度，里面的 `flex-1 overflow-y-auto` 连带塌掉。症状像"数据没回来"，DOM 里文字却都在 |
| **默认模板不能取 `templates[0]`** | `blank` 排在最前（最简单），但建完是空目录 → 预览必然以「没有 package.json」失败，用户第一眼是红字。默认取 `react-vite`；`entry === null` 的模板不自动起预览 |
| **`status` 不从列表里取就一直是「准备中」** | `select` / `booted` 两个归约都要 `apps.find(id)?.status`。只置 `null` 的话，界面要等到这个应用下次推 `app.status` 才正常 |
| **环境里的 `ELECTRON_RUN_AS_NODE` 会把 `electron .` 变成 node** | 表现是 `import { app } from 'electron'` 报 `does not provide an export named 'BrowserWindow'`，看着像"Electron 不支持 ESM"（其实 39 支持）。根因：带着这个变量，主进程按普通 node 跑，`'electron'` 解析到 npm 包里那个"返回可执行文件路径"的 shim。**从 IDE / 其他 Electron 应用里启动脚本时会自动带上它**。启动前必须删（`apps/desktop/scripts/launch.mjs` + `supervisor` 只对自己 spawn 的 server 设它） |
| **esbuild 打 ESM 单文件必须注入 `require`** | 依赖里有 CJS（isomorphic-git → shim → `sha.js`），产物以 `Dynamic require of "buffer" is not supported` 崩在启动第一行。`banner: { js: "createRequire(import.meta.url)" }`，见 `apps/desktop/build.mjs` |
| **打包后 `process.execPath` 不是 node** | 是 Tenon 自己。所以要 `ELECTRON_RUN_AS_NODE=1` 才能跑 `server.mjs`；好处是不用再塞一份 node（Electron 39 内置 22.22.1，`node:sqlite` 实测可用） |
| **`templates` 的目录位置是隐式契约** | `registry.ts` 按 `import.meta.url` 找 `../templates`。server 打成 `dist/server/server.mjs` 后，模板必须落 `dist/templates`（打包后是 `Contents/Resources/templates`）。改名就静默找不到模板 |
| **静态托管要分"页面公开"与"接口公开"** | 页面与 assets 免 Token（否则窗口里只有 401 的 JSON），但 `/rpc/*`、`/events`、`/api/*` 必须照旧要 Token。别写成"除接口外全放行"——下一个新增接口会默认裸奔 |
| **SPA 回落不能对 `/assets/*.js` 生效** | 回落成 HTML 时浏览器只报 `SyntaxError: Unexpected token '<'`，根本看不出是 404。`looksLikeFile()` 按扩展名区分 |
| **`index.html` 不能被缓存** | 它是注入 Token 的那一份，缓存住 = 上一个进程的 token（必然 401）。`no-cache`；只有带哈希的 `/assets/` 给 `immutable` |
| **Node ≥ 22.18 的原生 TypeScript 类型擦除会让 `ts-node/register` 彻底失效** | 症状：`node --require ts-node/register api/main.ts` 报 `ERR_UNKNOWN_FILE_EXTENSION` 或 `Cannot find module './app.module'`；即使 `require.extensions['.ts']` 确实注册了也没用 —— `.ts` 入口被 Node 自己的 ESM loader 抢走，CJS 的 require hook 不参与。**`node --no-experimental-strip-types` 也救不了**。全栈模板因此改用 `tsc --watch` 编译到 `dist-server/`，再用 `node --watch` 跑 `.js`（`packages/gateway/src/api.ts`）。顺带好处：Nest 的 DI 本来就需要 `emitDecoratorMetadata`，tsx/esbuild 不产出它 |
| **`node --watch` 只监听"已经加载过"的文件** | 入口文件还不存在时，它打印 `Failed running 'dist-server/api/main.js'. Waiting for file changes` 然后**永不重启**（它没监听任何东西，包括那个目录）。所以 `launchApi` 必须 `await waitForFile(outputPath, compiler, 90_000)`，等首次编译产出再起 runner；超时要把 tsc 最后几行塞进错误里，否则只有一句"没起来" |
| **子进程报错要带多行尾部，不能只取最后一行** | `node --watch` 会把真错误放在 `Failed running ...` 的**上一行**。`tailOf(launched, 6)` 而不是 `lastLine()` |
| **PGlite 必须 esbuild external 并整包拷进安装包** | 它按 `import.meta.url` 相对读 `wasm/`、`data/`、`extensions/`，打进单文件后这些路径全失效（表现为起库即崩）。`build.mjs` 里 external 掉再原样拷到 `dist/server/node_modules/` |
| **`CodemodeSandbox` 同理有两条 `import.meta.url`** | worker 用 `new URL('./worker.js', import.meta.url)`、wasm 用 `createRequire(...).resolve('quickjs-wasi/quickjs.wasm')`。打进 `server.mjs` 后两条全指向 `server.mjs` 旁边，而**构建一声不响地成功** —— 要派活给 codeact 才报 sandbox 错误。`build.mjs` 里 external + 整包拷，并留了 `assertCodemodeLayout()` 按运行期规则各解析一次 |
| **`require.resolve('@earendil-works/pi-codemode')` 会失败** | 它的 `exports` 只有 `types`/`source`/`import`，**没有 `require`/`default`**，CJS 解析报 `No "exports" main defined`；`./package.json` 也没导出。构建脚本里用 `realpath` 拿 pnpm 软链的目标（扁平布局下返回自身，同样对） |
| **`quickjs-wasi` 不是只拷 `quickjs.wasm` 就行** | `pi-codemode` 的 `vm.js` 会 `import { QuickJS } from "quickjs-wasi"` 拿它的 JS 驱动层，`dist/` 必须一起拷；但 `extensions/*.so` 不用（只有显式传 `QuickJS.create({ extensions })` 才加载）—— 过滤时别把 `dist/extensions.js` 一起滤掉 |
| **electron-builder 的 `extraResources` 会跳过相对路径含 `node_modules` 的文件** | 给 `from: dist/server` 写 `filter: ['**/*']` **也无效** —— 那一层目录直接被忽略，包能打出来、能启动，但 server 一跑就 `Cannot find module`/'server 在就绪前退出'。必须**单列一条** `from: dist/server/node_modules` → `to: server/node_modules` |
| **pnpm 自带 4 个平台的 `reflink.*.node`** | 打包时会触发"dist 里出现需要按平台编译的模块"的兜底断言。删掉后 `pnpm install` 实测照常工作（那是可选加速模块），`build.mjs` 拷贝时按扩展名过滤 |
| **`DATABASE_POOL_MAX` 是容量参数，不是环境判断** | 生成应用读它**只是**为了把 `extra.max` 传给驱动（默认 10），PGlite 档由 `db-provisioner` 注入 1。它**不许**被用来判断 desktop/docker/cloud —— 那是铁律 2 的红线。测试逐文件断言模板里搜不到 `NODE_ENV`/`TENON_*` |
| **`readiness` 从三格变四格（`deps`/`db`/`server`/`preview`）** | 新增的 `db` 格要同步到前端 `PreviewPanel` 的 `STAGES` / 进度宽度 / 四段文案，否则那一格永远灰着。改 `Readiness` 形状时 `scripts/e2e-preview.ts` 与 `scripts/e2e-fullstack.ts` 的断言都要跟（纯前端应用四格仍全 ready：`deps/db/server/preview`）；后端是否起来看 `apiPort`（纯前端应用必须 `null`，不该白起一个 Nest） |
| **日志端点 `/__tenon/log` 必须在网关层拦下，不转发上游** | 它是平台通道不是应用 API：转发给 Vite/Nest 只会得到 404（还污染应用自己的 4xx 统计）。`proxy.ts` 在路由分发**之前**匹配 `POST + LOG_PATH`，回 204。同理，新增这类"平台保留路径"时记得查一遍 `matches()` 的最长前缀逻辑 |
| **子进程输出必须先 `stripAnsi` 再进面板** | Vite/Nest 的输出带 `\u001B[32m` 这类颜色码，直接显示满屏 `[2m`。而且**同色相邻段**去掉码后可能产生首尾空格差异，去重（`repeat` 合并）要发生在剥离之后，否则同一句话被当两条 |
| **`LogStore` 合并后照样要推 SSE** | 去重容易顺手把"重复的那条"也吞了 —— 但合并是 `repeat++` 且 **id 不变**，前端按 id upsert 才能得到"一条 ×N"。吞掉的话界面上计数永远停在 1。`pushLog` = `store.add()` + 无条件 `publish` |
| **页面异常上报走同源相对路径，别加鉴权头** | 网关本身不校验 Token（它只在回环监听、生命周期跟预览走），上报用 `fetch('/__tenon/log', {keepalive:true})` 就够。想当然带上 `window.__TENON__.token` 反而把平台凭证引进了生成应用的代码 —— 违反"应用不感知平台"的方向 |
| **SSE 新增事件要过 `event-names.ts` 的穷尽闸门** | `SseEventNames` 是 `satisfies readonly SseEventType[]`，漏登记的类型检查直接红。但**别忘了** `apps/web` 的 `fences.test.ts` / reducer 的 switch 也要有对应 case —— TS 的 exhaustive 检查只覆盖有 discriminated union 的那几处 |
| **全局 `@Catch()` 过滤器接管了响应分发权** | 只记日志不写响应 = 请求永远挂着（前端只看到转圈，日志里一条异常，看起来"后端卡住"）。必须 `reply.status(status).send(body)` 把等价于 Nest 默认行为的响应补回去；单测断言 4xx/404/500 三种情况都要有响应 |
| **跨档迁移必须 `setval` 对齐序列** | 不做的后果最阴：迁移报告全绿、行数一致，用户第一次新建记录 → 主键冲突 500。`syncSequences()` 用 `max(col)` 推序列，用 TypeORM 真表跑一遍才能验到 |
| **`insert` 要排除生成列、`GENERATED ALWAYS AS IDENTITY` 要配 `OVERRIDING SYSTEM VALUE`** | 生成列写进去 → 报错；identity always 不给 overriding → 报"不能显式插入"。两者都按 `information_schema.columns` 的 `is_generated` / `identity_generation` 判断，别按列名猜 |
| **外键有环时不要"猜一个顺序"** | 猜错的代价是目标库留一半数据 + 中途报错，比一开始就失败难收拾。`orderTables()` 拓扑排序遇到环直接抛并列出环上的表；自引用（树形表）要显式跳过，否则每棵树都被判成环 |
| **迁移"只搬数据不搬结构"** | 结构由 migrations 在目标库生成（同一份 migration 两档同跑）。所以目标库缺表时**必须报错并指路**（"先让应用在目标档启动一次"），而不是悄悄把表建出来 —— 悄悄建表 = 两套 schema 事实来源 |
| **运行时 SDK 不能变成应用的 npm 依赖** | `@tenon/runtime` 没发布 npm，应用一旦 `import` 它，导出成 Docker 就装不上（铁律 2 的反面）。所以它是**源码分发**：`sync-templates.mjs` 拷贝 + `test/sync.test.ts` 逐字节拦截漂移。改源文件后别忘了跑同步脚本 |
| **跨模板共享的组件不能用模板的 css 类名** | 错误边界的降级 UI 一旦写 `className="card"`，两个模板就没法共用同一份代码（各自类名不同）。改成 inline style 才能字节级同步；错误态是兜底不是门面，朴素可接受 |
| **定位注入失效是"静默"的** | Babel 插件没挂上时页面照常打开、控制台干净、HMR 正常，只是点元素永远定位不到源码。所以 `pnpm e2e:preview` 里有一条硬断言：抓 `/src/App.tsx` 拿 Vite 吐的 JS，正则找 `data-tenon-loc": "src/App.tsx:行:列`。同理，这类"没生效但不报错"的机制必须有一条落在真实产物上的断言 |
| **Babel 的列号是 0 起，行号是 1 起** | `loc.start.column` 直接写进属性会整体左移一格（编辑器打开能看出来，代码里看不出来）。注入时 `column + 1`，测试里专门有一条盯这个 |
| **插件文件不能 import `@babel/core` 的类型** | 它要被拷进生成应用（源码分发），而模板刻意不装 `@babel/core`（`@vitejs/plugin-react` 自带 Babel），一 import 应用自己的 `tsc --noEmit` 就红。AST 形状在本地声明 + 运行时校验，一个 babel 包都不引；模板里传插件用 `as unknown as never[]` 过类型关 |
| **inspector 是动态 import 装上去的，比首屏晚几十毫秒** | `main.tsx` 用 `if (import.meta.env.DEV) void import('./tenon-inspector')`，生产构建才摇得掉。副作用：页面渲染出来之后还有一小段时间「按 Alt 没反应」。真实用户碰不到，**但 e2e 会** —— 所以 `e2e:inspector` 必须先轮询 overlay 节点数再点击，否则得到的是假失败（我第一次就栽在这儿，白查了半天） |
| **iframe 传 token 用 hash，不用 query** | query 会进网关与 dev server 的访问日志（等于把会话凭证写进日志）。hash 只在浏览器里存在。应用侧从 `location.hash` 读，`startsWith` 判断第一行即可 |
| **`postMessage` 的 targetOrigin 只能写 `*`** | 子页面在网关源、父窗口在平台源，子页面**不知道父窗口是谁**，写死就等于永远发不出去。所以防护全部落在父窗口侧：`event.origin` + `data.source` + `data.token` 三道，缺一不可（`apps/web/src/lib/selection.ts`，纯函数，16 项测试） |
| **`loc.file` 必须当成不可信输入** | 它会原样进 Agent 上下文。校验里明确拒掉绝对路径、`..`、盘符、反斜杠 —— 否则生成应用（用户和 Agent 都能改那份代码）发一条 `{loc:{file:"../../tenon.db"}}` 就等于给了一条"去读平台库"的指令注入 |
| **overlay 必须 `pointer-events: none`** | 否则鼠标永远命中高亮层，`event.target` 永远是 overlay，"什么都选不中"。同理，选中那一下要在 **capture 阶段** `preventDefault + stopPropagation`，否则生成应用自己的 onClick 会跟着触发（按钮提交表单、链接跳走） |
| **框选的元素上限要"先过滤再截断"** | `slice(0,50)` 写在过滤之前，塞几条垃圾进去就能把真元素挤掉。同理，框选只留**最内层**元素：把 `<main>` 这类容器交给 Agent 只会让它把改动面放大 |
| **`git.show` 不是 `git.diff`** | `git.diff(from)` 算的是"从 from 到 HEAD"的累积变化。版本列表里点第 3 条会显示第 3 条之后的所有改动，看起来像"这一轮改了 8 个文件"。看单条提交必须用 `showCommit`（内部取 `commit.parent[0]` 和它比）—— 有测试专门造了第三条提交来盯这件事 |
| **`''.split('\n')` 是 `['']`，不是空数组** | 新增/删除文件时缺失的那一侧不能传空串：会在全 `+` 的差异里混进一行 context，行号也整体错一格。传 `null`，内部换成 `[]` |
| **`git.resolveRef` 对 40 位 hex 不校验存在性** | 它原样返回，真正报错的是 `readCommit`（英文 "Could not find …"）。只 catch resolveRef 的话，用户传个瞎编的 sha 会拿到 `INTERNAL` 而不是 `GIT_DIFF_FAILED` |
| **改动面板必须覆盖，不能替换预览** | 替换 = iframe 卸载 = HMR 连接断开 + 预览回到空白，看完 diff 切回去等于重启一次。用 `absolute inset-0` 盖住，iframe 留在原地 |
| **Electron 的沙箱失败表现为"页面打不开"** | 被收窄的 shell 沙箱里 Chromium 报 `sandbox initialization failed: Operation not permitted` → network service 崩溃 → `loadURL` 直接 `ERR_FAILED (-2)`。文案里一个"沙箱"字都没有，第一反应会怀疑服务没起。e2e 里加 `--no-sandbox`（这条链路要验的东西全在渲染进程里，与进程隔离无关） |
| **`dumpDataDir()` 不是 `cp -r` 数据目录** | 前者是 PGlite 自己的 API，**运行中调用安全**（实测：库里开着未提交事务时打快照，还原后那行不在）；后者才是"必须先 stop 再拷"的那个坑 —— 热拷出来是半写状态，能起得来但表坏了。别把两条混成一条，否则会为了安全而白停一次库（2.4s） |
| **每轮都存库快照会塞满盘** | PGlite 一份 4~5MB，聊五十轮就是两百多兆，而只改样式的提交库里根本没变。判据是「这次提交改了 schema」（`api/migrations/**`、`*.entity.ts`、`shared/schema.ts`）。用**路径约定**，不要扫文件内容找 `CREATE TABLE` —— 要猜方言，还会被字符串字面量误伤 |
| **回滚的顺序必须是「检查 → 还原数据 → 回滚代码」** | 覆盖库**不可逆**，回滚代码**可逆**（再回滚一次就回来了）。顺序反了就会出现"库已被旧数据覆盖，然后发现这个提交根本没法回滚"。`e2e:diff` 有一条专门盯：带 `dbRestore` 但没有快照时，提交数不变、迁移文件还在 |
| **快照可能比目标更早，别假装精确** | 只有改过 schema 的提交才有快照。回滚第 N 版时父提交 N-1 若没改过 schema，只能往前退到最近一份 —— 中间那几轮写入的数据会一起丢。`skippedCommits` 就是量这个距离的，UI 必须如实说出来 |
| **快照按 commit sha 归档，不是时间戳** | `exports/db/<sha>/db.tar.gz`。时间戳命名就得再存一份"文件 ↔ 提交"的映射，两份迟早对不上，而错的那一次正好是用户最需要回滚的时候 |
| **`planRevert` 只往前看 200 条提交** | 沿祖先链找快照依赖 `git.log({depth:200})`。一个应用真到 200 轮以上时，更早的快照会"找不到"而不是"用错"（报 `DB_SNAPSHOT_MISSING`），这是有意选的方向：宁可说没有，不可悄悄退到一份对不上的状态 |
| **`git.writeObject` 传 string 会把对象写坏** | 传字符串进去，写出来的字节是乱的（实测 tag 对象解压后是一段二进制垃圾，`git fsck` 报 `object could not be parsed`），而且**没有报错**。内容一律 `Buffer.from(str, 'utf8')` 再传。commit / tree / blob 碰巧没炸，只有 tag 露了馅 —— 别因为"之前没事"就不转 |
| **isomorphic-git 的 `push` 只认 HTTP 传输** | 1.44 对本地路径（`/x/y.git` 或 `file://`）一样报 `requires a "http" parameter`。所以本地备份不能指望 `git.push`，`mirrorTo` 改成自己搬对象 + 写 ref（和真 push 传的东西一样，只是省了协商） |
| **裸库的 API 必须传 `gitdir`，不能传 `dir`** | `writeObject({dir: '/x/bare.git'})` 会去找 `/x/bare.git/.git/...`（不存在 → 静默什么都不写，`writeRef` 也一样）。裸库要 `gitdir: '/x/bare.git'`。这个坑不会报错，只会让你发现"写完了但啥也没有" |
| **备份库必须放在仓库外面** | 放进去会被 `commitAll` 一起提交，然后 `mirrorTo` 把备份库自己当内容搬进自己 —— 对象数会指数级膨胀（实测放了之后镜像一次写 16 个对象）。真实布局是 `~/.tenon/backups/<appId>.git` 与 `~/.tenon/apps/<appId>/repo` 平级，测试里也得照这个来 |
| **`app.create` 自带一个初始提交** | 「chore: 初始化应用」。所以"仓库里没有提交"这个分支没法用新建应用造出来，测试里要先删 `.git` 再 `initRepo` 造空仓库 —— 否则会以为那条闸门失效了 |
| **发布失败要把刚打的 tag 删掉** | 否则留下"有 tag、没记录"的半成品：下次 `nextVersion` 看到 tag 就算出 `-2`，用户会以为少发了一版。`publishRelease` 在 `mirrorTo` 失败时 `deleteTag` 再抛 `RELEASE_FAILED` |
| **`.gitignore` 里的 `release/` 会让 Tailwind 扫不到 `features/release/`** | Tailwind v4 的自动内容扫描**跳过 `.gitignore` 命中的路径**。`release/` 本意是 electron-builder 的产物目录，但它把 `apps/web/src/features/release/` 也一起盖住了 → 新写的类名（`max-w-lg`、`min-h-[76px]`、`bg-ok/5`）**不生成 CSS**，界面上只有"这一处新样式失效"，别处全正常，查起来像见鬼。已改成精确路径 `/apps/desktop/release/`。判断办法：`grep 类名 apps/web/dist/assets/*.css` |
| **`api.conversation(id)` 拿到的句柄没有 `configure()`** | 它只有 `submit` / `abort` / `waitForIdle`。想「先建子会话再配模型/工具/指令」会拿到一个**什么都没配**的会话（模型用默认工具集瞎猜），而且不报错。子会话的 `agent` 必须在 `harness.createConversation({ ownership, agent })` 那一刻给全 —— 工具因此要拿到 Harness，用闭包懒注入（`getHarness`） |
| **`ConversationRecord` 上的字段叫 `owner` 不是 `ownership`** | `{ conversationId, taskId }`，根会话没有它。查「这个应用有哪些子会话」按 `owner !== undefined` 过滤；写成 `record.ownership.kind` 会得到 `undefined is not an object` |
| **`faux` 的响应工厂只服务一次请求** | `stream()` 内部是 `pendingResponses.shift()`。用工厂当「万能应答」时必须**先把自己 `appendResponses([router])` 塞回队尾**，否则第二次请求（父轮收尾、或子会话要第二次生成）直接返回 `No more faux responses queued`，表现是「派了活但没干活」 |
| **父子会话的 faux 剧本必须分道** | 子 Agent 是**另一次 submit**，跟父会话抢同一条队列。父轮剧本 `[tool subagent, text]` 里那句 text 会被子会话先吃掉。现在按 `[TENON-SUBAGENT role=x]` 首行分道（`lanes`），`script([{...} as 'explore'])` 指定道 |
| **角色 id 里有数字（`e2e`）** | 匹配标记的正则写成 `[a-z]+` 时 `e2e` 永远认不出来 → 它的台词串到 builder 道上。用 `[a-z0-9]+`；这类「名字看着像字母」的枚举，正则要照最宽的那个写 |
| **pi 的 `owner` 是任务树，不是会话树** | 子会话里那个 generation task 的 `owner` 是**空的**（它是会话自己的任务，不挂在父生成任务下），而工具 task 的 `owner` 指向发起它的那次 generation。所以按 `owner` 画树，子会话会浮在最顶层。真正的"谁派了谁"在 `conversations` 字段：工具 task 派活时那里会出现子会话 id，用它回挂 |
| **角色不在任务图里** | 图里只有 `kind: 'pi.tool'`，看不出这是 `subagent` 还是 `bash`。角色在 `getTask(id).state.checkpoint.arguments.role`，而 `arguments` **只有 `phase: 'execute'` 之后才写进去**。判据用「工具 task 且已经拥有会话」（`conversations` 非空）—— 那个窗口里两者一定同时成立。查到的结果（包括"没有角色"）要缓存，否则每帧一次 DB 读 |
| **`watchTaskGraph` 必须早于 `chat.submit` 挂上** | 在 RPC handler 里"查一次"是不够的：一次派活 17 帧，等界面来问的时候前半段已经过去了。而 watch 只在有人 acquire 时才存在 —— 所以 `chat.submit` handler 里先 `taskGraph.ensure(appId)`。反过来 `app.delete` 要先 `release` 任务图再关 harness，顺序反了会踩到已关闭的 session |
| **本机 `npx electron` 直接 SIGTERM 137 且一个字都不输出** | `node_modules/.bin/electron` 是个**断掉的 symlink**（`no such file or directory`），`npx` 于是找不到可执行文件 —— 表现成"被杀了"而不是"没装"，很误导。真二进制在 `node_modules/.pnpm/electron@<ver>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`，截图/冒烟脚本一律直接用完整路径 + `--no-sandbox` |
| **`pi-coding-agent` 的 `grep` / `find` 会下载二进制** | 它们走 `ensureTool()`：首次调用从 GitHub 拉 `rg` / `fd` 到 `~/.pi/bin` 再 spawn。本地优先的产品不能这么干（没网即失败、桌面版偷偷落可执行文件、它还自己解析 cwd 之外的路径）。已改成自己的 `ls` / `glob` / `grep`（纯 `node:fs` + 进程内正则，有上限） |
| **`content-length` 与 `transfer-encoding` 不能并存** | 往 HTML 里注入脚本后要改长度，只重算 `content-length` 而把上游带来的 `transfer-encoding: chunked` 留着 —— 两个头同时在，客户端**永远等不到响应结束**：预览一直停在 `failed`（`expected 'failed' to be 'ready'`），日志里一个字都没有。两个都要删，只写新的 `content-length`。用显式长度的桩测不出来，得经真 upstream |
| **注入的脚本要插在 `</body>` 之前** | 放进 `<head>` 时 `document.title` 还是空的（脚本先跑、解析器才继续），上报的页面信息全是 `''`。而且脚本必须 ES5 风格：它跑在生成应用的页面里，不保证与平台的构建目标一致 |
| **扩展只 `registry.install()` 不够，必须也在会话的 `extensions` 里** | 表现极隐蔽：子会话里工具**"不存在"**，模型若无其事地继续讲，`execute` 一次都不进（打点才能发现"派了活但没调工具"）。`harness-pool.ts` 里 `extensions: [coding, subagent, preview]` 这一行漏掉就等于工具没接 |
| **"工具在会话里"与"工具递给模型"是两件事** | `AgentChange.tools` 是**可用集**，`modelTools` 才是**递给模型的那一份**；不写 `modelTools` 等于全给。CodeAct 的 `read/ls/glob/grep` 必须只在可用集里 —— 写进 `tools` 而不设 `modelTools`，模型就会绕过脚本一次次直读，"四十次 read 只回一行结论"当场失效 |
| **沙箱里访问不存在的工具会抛异常，不是 `undefined`** | `tools` 是个会抛的代理：`typeof tools.write` 直接抛 `tools.write does not exist. Available: read, ls, glob, grep`。所以脚本里 `if (tools.write)` 这种写法会炸，要 `try/catch`。好处是报错本身有用（把真有哪些工具列出来） |
| **整页导航会掐断挂在长轮询上的请求** | 网关侧那个 `await bridge.poll()` 还活着，命令被投进一条死连接 → 调用方等到 12 秒超时（`页面在 12 秒内没有回话`）。`poll(sessionId, signal)` 要接 `AbortSignal`，`res.on('close', () => abort.abort())` 里中止，让命令回到队列而不是消失 |
| **页内抛异常也必须回话** | `document.querySelector` 拿到 `null` 再读 `.textContent` 会抛 —— 如果只在 `try` 里回话，调用方只能等满超时，而真实信息（"没找到第 1 个「#buy」（一共 0 个）"）根本没送出去。`handle` 必须带 rejection 分支 |
| **断言失败不是工具错误** | `preview_assert` 失败要返回 `isError: false` + 「✗ 期望 X，实测 Y」。标成错误会让模型去**重试工具**（换个 selector 再试一次），而它真正该做的是回去改代码。同理，参数不合法（`value` 没配 `selector`）要在**发命令之前**拦住，那是真的工具错误 |
| **改完代码不能用"计数回到 0"当起点** | React Fast Refresh **保留 state**：HMR 之后计数器还是旧值，整页不重载就永远验不到干净起点。所以有 `preview_open`（显式整页重载）。另外整页重载会换 `document`，但 `sessionStorage` 还在 —— sessionId 存那儿才能跨 reload 延续同一条通道 |
| **刷新时只能重投幂等命令** | `read` / `assert` 重投是安全的（读两次没有副作用），`click` / `type` 重投就可能点出两个东西、输入两遍。`PageBridge.hello()` 按命令名分档，别一律重投 |
| **`poll` 遇到不认识的 sessionId 要回 `'reset'` 而不是 `null`** | 回 `null` 页面会立刻再问一遍 —— 空转打满 CPU，而且从日志上看不出任何异常。页面收到 `reset` 就换新会话 |
| **评审要看的是工作区，不是提交** | `commitAll` 在一轮**收尾**才跑，所以 Reviewer 被派活时改动还没提交。给它 `diff()`/`showCommit()` 等于让它永远审上一版。`worktreeDiff()` 比的是 `HEAD ↔ 工作盘`，且同样**自算 blob oid**（`statusMatrix` 会漏同长度同毫秒的改动 —— 对评审是"少看一个文件"，而"说没问题、其实没看到"是最坏的绿） |
| **`typecheck` 的判据是「跑完了 + 没诊断」，不是「没诊断」** | 只看输出会把 `tsc` 崩了、超时、tsconfig 写错全报成"通过"。`formatTscReport` 的 `ok` 由调用方给的那个布尔决定；`okRun = !timedOut && code === 0 && 诊断为空`，三者缺一不可 |
| **"没跑成"必须和"通过"长得不一样** | 没有 `tsconfig.json`、`node_modules` 里没有 typescript、超时被杀 —— 三种都明说"没跑成…这不等于通过"，且输出里**不出现 `✓`**。评审里的假绿比红贵得多：它会让人放心提交 |
| **`scrubEnv` 会删掉 `ELECTRON_RUN_AS_NODE`** | 那是为了防止生成应用的子进程"把 electron 当 node 跑"。但 `typecheck` 是**我们自己的**子进程：`.app` 里 `process.execPath` 是 Tenon 自己，不补这个变量就会**真弹出一个窗口**而 `tsc` 一行不跑。只在 `process.versions.electron` 存在时才补 |
| **评审工具要按应用自己的 `tsconfig` 跑** | 写死 `tsc --noEmit` 只覆盖根 `tsconfig.json`；`nest-api` 的后端在 `tsconfig.server.json` 里，漏掉等于"后端一行都没检查照样绿"。存在就跑，别猜 |
| **门禁的判据是三态，不是布尔** | `pass` / `fail` / `skip`。混成 `false` 会让「没配测试」和「测试挂了」同罪：要么所有没写测试的应用永远发不出去，要么测试红了也照发 —— 两种都会让这个功能在两周内被关掉。判据是「没有任何一项 `fail`」，`skip` 放行但要说出来 |
| **「没跑成」是 `fail`，不是 `skip`** | 有 `tsconfig.json` 却没装 typescript、`tsc` 崩了、超时被杀 —— 这些是"该检查的东西没检查成功"。归到 `skip` 等于**删掉 `node_modules` 就能绕过门禁**。真正没有 tsconfig 才是 `skip`（配置性选择） |
| **`force` 只改「拦不拦」，不改「跑不跑」** | 用户有权坚持发一个有类型错误的版本，但没权不知道自己在放过什么。`force` 时**仍然跑检查**，结果写进记录（`gateStatus: 'forced'`）—— 闸门能开，但开了要留痕 |
| **`gateStatus` 不能有默认值** | 迁移 2 之前发出去的版本没跑过门禁，读出来必须是 `null`。给个 `'pass'` 默认值会把历史全部伪造成"检查通过了"，而留痕的价值全在"它说的是真的"。反过来 `pass` 包含「全部 skip」的情况，不该标 `forced` |
| **门禁要排在版本号之前** | 否则被拒的发布会一路消耗 `-3`、`-4`、`-5`，用户看到版本号在涨、以为发过好几版，实际一版都没出去 |
| **`vitest` 默认是 watch 模式** | `pnpm run test` 起 `vitest` 不加 `CI=1` 会**一直挂着**直到超时，然后被报成"测试超时"—— 那不是测试的问题，是跑法的问题。门禁里一律带 `CI=1` |
| **`schemaVersion` 别在测试里写死数字** | 每加一条迁移就得改一次断言，那种测试会被人一路改成 `toBe(当前版本号)` 然后彻底失去意义。用 `MIGRATIONS[MIGRATIONS.length - 1].version` |
| **预检的结论只对那个 sha 有效** | 用户看清单、写说明、点发布，中间可能隔几分钟，代码随时会变。所以 `release.publish` 里必须自己再跑一遍（不能复用预检结果），而 `release.check` 的返回里必须带 `commitSha` + `stale`（前后各读一次 HEAD）—— 拿 A 版的「通过」给 B 版背书，比不检查更糟 |
| **`ready` 不是按钮的 disabled 依据** | `ready=false` 有两种：前提不满足（真不能发）和门禁没过（能发，但要 `force`）。把 `ready` 直接接到 disabled 上，等于把「仍然发布」这扇门焊死 —— 而它恰恰是用户比你更懂自己代码时的唯一出口 |
| **别在 JSX 里写 markdown 的 `**加粗**`** | 它会原样渲染成两个星号，而且不报任何错。要强调就用 `<span className="text-muted">`。同理，JSX 里的换行会变成空格：「标准裸库，\n<span>git clone…</span>」渲染出「裸库， git clone」多一个空格 |
| **chord 对象默认 `lifetime: "referenced"`：state 随 root 静默归零** | 最后一个引用释放，对象连同 state 一起销毁，**不报错、不告警**（实测：root 里把 `rows` 加到 5，新 root 再 `get` 同一个 input 读到 0）。组件的 `serve` 必须显式给 `linger`；`lifetime: "host"` 只适合无 input 的单例。这类"每次调用都正常返回、只是数据没了"的错，测试里极难发现 |
| **`'method' in ref` 判不出权限** | Ref 是代理，`in` 恒为 `true`。要知道 guest 有没有某个方法，只能**真调一次**并认 `not_in_variant` |
| **chord 断链时调用会挂住，不抛错** | `sever()`（双向静默丢帧、不发 close）之后调用方法，1.5s 内既不返回也不抛。所以 web facet 的每个调用都得自带超时 + 心跳，不能等"断了会告诉我" |
| **无参方法的实现签名是 `(ctx)`** | 有入参才是 `(args, ctx)`；写错会被类型检查拦住（不静默）。`invalid` 也是两个参数：`invalid(reason, message)` |
| **覆盖层要按"根"选版本，不是按全局最高版本** | 顺序是 `hub > bundled`：先看哪个根有满足区间的版本，再看该根里的最高版本。按全局最高选的话 bundled 1.3 会盖掉 hub 1.2 —— 官方修了 bug 推到 Hub 也装不上，而现象只是"更新没生效" |
| **一个组件坏不能连累别的组件** | 装配声明逐条独立判定：失败的落一条 problem，其余照常加载。整份拒（"有个字段不认识就全不装"）会让用户以为所有组件都被卸载了，比装不上更吓人 |
| **装不上要返回 problem，不要抛 500** | `component.list` 恒 200，原因在 `problems`（现 21 个稳定 code）。插件页要能说"它要求 Tenon ≥ 1.4.0，你是 1.2.0"；一个红叉加 Internal Server Error 什么也说明不了 |
| **`minTenonVersion` 对 `0.0.0` 恒通过** | 仓库构建就是 `0.0.0`，代表"还没发版的开发树"。不这么判所有清单都得写 `0.0.0`，字段当场失去意义。**代价：开发态测不出写错**，所以真实分支（host=1.2.0 / 组件要 1.4.0）单独有用例 |
| **组件目录名就是 id** | 清单 `id` 与目录名不一致 → `id-mismatch` 直接拦。否则放错一个目录就是"装配了 A、装上了 B"，而且两者都合法、都能跑 |
| **状态字段不能叫 `status` / `error` / `variant` / `ready` / `shape` / `release` / `then` / `contract`** | 那是 chord Ref 自己的成员，撞名在**定义契约那一刻**抛 `member name is reserved`。AI 小助手的状态因此叫 `phase` 而不是 `status` |
| **host 的 `name` 必须等于契约里的 `hostNamed(…)`** | 否则 `serve` 抛「declared for server, but <别的名字> serves it」。名字是路由名，不是实例 id：一个进程里多个应用的 host 都叫 `server`，靠链路区分 |
| **组件的 facet 是构建产物，不进 git** | `plugins/bundled/<id>/server.js` 由 `pnpm build:plugins` 生成（esbuild 连 chord 一起打，410KB）。忘了构建的表现是"组件加载失败：Cannot find module"，而源码看着完全正常 |
| **`executeJavaScript` 里拼选择器必须过 `JSON.stringify`** | `'document.querySelector("' + ball + '")` 这种写法在 ball 自带双引号时是语法错误；而外层 `.catch(() => false)` 会把它吞掉 —— 现象是"元素一直没出现"，排查方向全错（M5 第 8 步在这上面卡了两轮） |
| **一轮结束不能只看"最后一条是助手"** | 真模型会"先说一句、接着继续调工具"（"我先看看结构"），只看消息形状会在它干活中途判成结束 → 后面所有断言都在它还没写完时执行。判据必须是 **应用回到 idle + 末尾是 `settled` 助手消息** 两个条件同时成立 |
| **判"文件改了吗"要前后对比，别猜关键词** | 我用 `!content.includes('Tenon')` 当"没改"的标志，而模型正好把标题写成「Tenon · 待办」→ 把成功报成失败。猜关键词的断言迟早误判，两个方向都有害 |
| **组件的 `activate` 可以是 async** | 组件可能要先去存储里恢复数据再 `host.serve`。宿主必须 `await`（`activateComponents` 本来就是）；不等就会撞上"这个 contract 还没人 serve"。这类错在测试夹具里最容易出现 |
| **恢复数据时，"计数类状态"的初值不能写死 0** | 审批流重启后徽标显示 0 而清单里有两张待审单 → 用户以为丢了、重复提交。凡是能从主数据算出来的状态，初值都要从主数据算 |
| **"装进应用"与"装到本机"是两件事** | 前者写装配声明 + 同步 `AGENTS.md` + 重新激活（`component.install` / `install_component`），后者只是把包放到 `<home>/plugins`（`hub.install`）。混成一个的话，要么"下载了但没装上"，要么"装上了但 Agent 不知道" |
| **付费门禁只拦安装，不装 DRM** | 组件文件是明文落盘的，谁拿到目录都能读。在加载层再拦是自我安慰，还容易让人以为这里有防护。门禁放唯一入口（`installComponent`），并在文案与文档里说清 |
| **索引也要签名，否则可以降级** | 包签名拦得住"装恶意代码"，拦不住"把最新指向一个旧的、确实签过名的版本"。客户端看不出区别，用户点完更新就退回有漏洞的那一版。同一个密钥签索引与包就够 |
| **"付费"要在下载前拦，不能只拦装配** | M6 第 5 步才发现：`installComponent` 拦付费，但那是"装进应用"的入口；`hub.install`（装到本机）不拦 → 付费包原样落到 `~/.tenon/plugins/`，"付不了但能下载"。修法是 `installFromHubIndex` 在**请求包之前**看索引的 `pricing`。用索引判是安全的：这一层误拒只是"看到一句暂未开放"，漏判是"付费内容已经在本机磁盘上"。真判据仍在包里，两层不冲突 |
| **`packComponent` 必须把 `pricing` 写进索引** | 不写的话上面那道门永远不触发（索引里没有 paid 这个信息，客户端无从判）—— 而"发布了付费组件但客户端不知道"只有真的发一次才会暴露 |
| **PEM 的尾换行会造出第二个指纹** | 文件里读出来的 PEM 带尾换行、环境变量里读出来的被 trim 过。`hubKeyFingerprint` 不先 trim 的话，同一把 key 得到两个指纹，界面就会误报"发布方换过密钥"。同理 `resolveHubConfig` 的顺序必须是「先还原字面量 `\n` 再 trim」，反了会留下一个尾换行 |
| **打包版的配置不能只靠环境变量** | 双击打开的 `.app` 里没有 `TENON_*`。M6 前四步的 Hub 配置只能来自环境变量 → 打包版的组件商店**永远**显示"未配置"，而那不是错误、日志里一个字都没有。修法沿用既有模式：**壳指路径**（`TENON_HUB_CONFIG_FILE`），业务侧 `resolveHubConfig` 读内容并判定 `env > 文件 > 未配置`，界面显示来源 |
| **`extraResources` 的来源不存在会让整次打包失败** | 于是"没配 Hub 就没法打包"。`build.mjs` **总是**写 `dist/hub.json`（没配就写空值），空值在 `resolveHubConfig` 里是"就是没配"，与"字段名拼错"分开报 |
| **脚本的 `@options` 能放大超时** | 上游是 `options.timeoutMs ?? this.timeoutMs`，脚本写 `// @options: {"timeout_ms": 3600000}` 就绕过了我们设的 60 秒。**我们自己的上限必须自己夹**（在工具入口，起 worker 之前），否则"上限"只是一句注释 |
| **`electronMain()` 那段模板字符串里不能出现反引号** | 注释里顺手写 `` `git.log` `` 会让模板字符串提前结束，报的是 `TS1005: ';' expected`（看着像别的地方坏了）。同理 `${...}` 会被当成插值。写这类"代码生成代码"的脚本时，注释里只用引号 |
| **React 受控输入不能直接赋 `input.value`** | React 用内部的 value tracker 比对，直接赋值 + `dispatchEvent('input')` 会被判成"没变"。要用原型上的原生 setter（`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`）再派发事件。e2e 里填输入框都得这么写 |
| **导出的产物里不能有 pglite** | PGlite 是预览用的零安装数据库；把它（wasm + `pg-gateway`）打进产物，等于让产物自带一个数据库运行时 —— 那是另一个产品，也违背"应用只认 `DATABASE_URL`"。验证方式：`e2e:export` 断言产物里没有 `pgdata/`、`serve.mjs` 里不出现 `pglite` |
| **生成出来的代码要过 `node --check`** | `serve.mjs` / `start.sh` 是模板字符串拼的，转义错（`\.`、`$`、反引号）在源码里看不出来，症状要到用户服务器上才出现。单测里写盘再 `spawnSync(node, ['--check', file])`，两种变体都跑 |
| **组件的"装了"与"用上了"是两件事** | 装是本机全局的，用不用由每个应用的版本区间决定（解析器只挑满足区间的最高版本）。所以"装到 2.0.0 但应用声明 ^1.0.0"等于没装 —— 界面必须点名是哪个应用挡住了，也不要为此重载它（重载了也不会有任何变化） |
| **Hub 装到哪必须等于加载器的 hub 根** | 两处各算一次目录，不一致的表现是"装成功了却加载不到"——而装的时候一切正常（文件真的写下去了）。所以安装器与 `pluginRoots` 走同一个 `hubPluginsDir(env, home)` |
| **验签必须在解析之前** | 先 `parseManifest` 再验签，等于让未签名的内容进解析器；顺序反了还容易被误以为"反正验过了"。正确顺序：结构形状 → 验签 → 清单校验 → 路径检查 → 落盘 |
| **"算了多少钱"和"能不能算"是两个问题** | 没配价格时 `costUsd` 恒为 0，直接显示 `$0.00` 等于骗人（用户会以为离额度很远）。必须有独立的 `priced` 标记，界面才敢说「未定价」。同理：**改价格必须重新解析模型** —— `model.cost` 是解析那一刻烤进 provider 的，改完不重建，面板永远是旧价 |
| **`pnpm install` 会改仓库（生成 lockfile）** | 后台装依赖必须把 `pnpm-lock.yaml` **单独提交**：掉进某一轮对话就会用一千多行把真正的改动挤出评审视图（`git_diff` 上限 48KB）。测试里更麻烦 —— 工作区被弄脏，"一轮一 commit""工作区是干净的"会随机红，所以夹具默认不装 |
| **`settings.get` 对不存在的键返回 `undefined`，不是 `null`** | 用 `=== null` 判"还没设置"永远不成立。而 `planModel` 又有"只有一家就用它"的兜底 → 模型能用、界面上「当前」却是空的（能用但看着没配好，比不能用更让人困惑）。判空用 `== null` |
| **声明了选项 ≠ 传下去了** | `AgentRuntimeOptions.components` 声明、server 传、`HarnessPool` 用，中间的 `createAgentRuntime` 漏了一行 —— 结果 `install_component` 在真实运行时里**从来没挂上过**，模型一调回 "Tool ... is not available"。类型检查抓不到（两侧都对），单元测试也抓不到（直接构造 pool 绕过了那一跳）→ 这类"装配链断点"只能从**最外层**起步的用例才发现（`component-wiring.test.ts`） |
| **工具 part 的 `status` 不能写死** | 必须按 `toolCallId` 从 `pi.tool-result` 回填。写死 `'ok'` 的话，路径越界/命令非零退出/组件装不上在界面上与成功一模一样 —— 这是最坏的一种绿：用户不会查，模型也以为自己做成了 |
| **组件脚本加载失败是静默的** | 它是 `type="module"`：语法错/导入失败只在控制台留一行，页面照常可用。所以网关注入时**同时注入一行错误捕手**（`window.__tenonComponentErrors`），端到端与用户反馈都读它 |
| **链路要在 socket 建出来那一刻挂上，不能等 `open`** | `webSocketLink(socket)` 才挂 `message` 监听。等 `open` 再挂，那几十毫秒里服务端已经在发帧 —— 帧丢了、序号错位，报 `ack 2 outside 0..2`，之后调用**永不返回**（Spike 6 就是这么被咬的） |
| **链路两端的 `principal` 形状必须一致** | 组件契约的 principal 是 `{appId}`，宿主的 `accept({principal})` 与客户端的 `upstream.principal` 都必须是这个形状；给错不会报类型错，而是组件 factory 里抛 `invalid/principal`（消息里两个 appId 还长得一样，很容易看漏）|
| **`TENON_PLUGINS_DIR` 和 `TENON_TEMPLATES_DIR` 是同一个坑** | 加载器打进 `server.mjs` 后按 `import.meta.url` 找 `plugins/bundled` 必然找错，而表现是"插件页空空如也"、**没有任何报错**。壳必须显式指到 `<Resources>/plugins` |
| **`postgres:18` 的卷必须挂 `/var/lib/postgresql`** | 18 起 `PGDATA` 挪到 `/var/lib/postgresql/18/docker`，`VOLUME` 也改成 `/var/lib/postgresql`。挂成 17 及以前的 `.../data` 不会报"挂载点不对"，而是入口脚本认定"数据在 unused mount/volume 里"然后拒绝启动 → db 容器 `unhealthy`，而 `app` 因为 `depends_on: service_healthy` **连启动都没有**，看着像整个 compose 坏了 |
| **colima 的虚拟机会话 `resolv.conf` 是悬空符号链接** | 它是 `-> ../run/systemd/resolve/stub-resolv.conf`，而 `systemd-resolved` 在这个镜像里**没装**（`systemctl is-enabled` = `not-found`）→ 任何域名都解析不了。**而且坏得不明显**：只要 dockerd 配着 HTTP 代理，域名是代理那边解析的，`docker pull` 照样成功 —— 等代理失效（WorkBuddy 的代理每个会话端口都不同）才一起崩，症状是 `proxyconnect ... connection refused` 与 `could not resolve host` 混着出现。想修还得先 `rm` 掉那个链接（直接写会报 `Directory nonexistent`） |
| **colima 每次 `start` 都重写 `/etc/docker/daemon.json`** | 手工加的 `registry-mirrors` **活不过一次重启**（`exec-opts` / `features` 保留，自定义键不保留）。它还会从宿主环境读代理写进这个文件（`127.0.0.1:PORT` 会被换成虚拟机看得见的宿主地址），那个代理一停所有 pull 全挂。持久做法是挂 `docker.service` 的 `ExecStartPre`（本机是 `/usr/local/bin/tenon-vm-fix.sh` + `docker.service.d/10-tenon-vm-fix.conf`），别直接改文件 |
| **spawn 出来的 pnpm 被杀掉 ≠ 它的子进程死了** | `child.kill('SIGKILL')` 只杀直接子进程。我们 spawn 的是 `pnpm`，它再 spawn `eslint`/`vitest`，**孙进程握着 stdout** → 管道不关 → `close` 事件永远不来 → `await` 挂着，界面显示"检查中…"永不结束。修法：`detached: true` 进自己的进程组 + 负 pid 杀整组 + **超时立刻 resolve 不等 close** |
| **不能拿 `ELIFECYCLE` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 判断"命令没装"** | 这两行在**任何** pnpm 失败里都会出现（包括"lint 查到 3 个错误"）。拿它当判据会把所有真失败报成"没装依赖"，用户会去改一段本来没问题的代码。只看 shell 的 `: command not found` / `is not recognized as an internal or external command` |
| **"不随开源发布"写成注释不等于不在仓库里** | `docs/REVERSE_ENGINEERING.md` 被 README 与 STATUS 两处声明为"仅内部"，但它一直是 tracked 的，公开仓库上直接能打开。判定要看 `git ls-files`，不是看文档怎么写。用 `git rm --cached` + `.gitignore` 移出（本地文件保留），注意**历史里仍在**，彻底清除要重写历史 |
| **GitHub 建仓时选的 license 会直接变成 `LICENSE` 文件** | 它不会去读你的 README 或设计文档。于是很容易出现"文档写 AGPL、仓库实际是 MIT"，而真正有法律效力的是那份文件。建仓时就该按设计选，或者建完立刻核对一遍 |
| **本地通过、CI 失败：`~/node_modules` 在替仓库兜底** | 家目录里一份 `node_modules`（160 个包）会被 Node 一路往上解析到。未声明的依赖因此本地永远"能跑"，到干净的 runner 上才炸。判据不是"看 package.json 有没有声明"，而是**逐个 import 真解析、看结果落在哪**。本机解决了 `isomorphic-git`、`@babel/types` 两处 |
| **快照还原不能"按行数组前 N 个值"取值** | 快照之后如果 `drop column` 过，保留的列不再是行数组的前 N 个 —— 按位置取会让整行**往前错一位**。类型相容时是**静默写进错误的列**，类型不容才报 `malformed array literal: "12.50"`（score 被写进了 labels）。必须按**列名取下标** |
| **迁移的校验不能是"源行数 == 目标行数"** | 目标库里有迁移之后新写的数据时（或只是重跑），这个比较会把一次**正确**的迁移判成失败，提示还是"先清空目标表再迁" —— 等于建议用户删数据。正确判据是「目标(后) == 目标(前) + 实写」，`on conflict` 跳过的行数如实进报告 |


---

## 6. 环境

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node | `>= 22.19`（pi 硬要求，主因 `node:sqlite`）| v22.22.2 ✅ |
| pnpm | 9.x | 9.15.9 ✅ |
| git | 任意（isomorphic-git 是纯 JS，系统 git 可选）| 2.39.5 ✅ |

日常入口（在仓库根目录）：

```bash
pnpm dev:web               # ★ 日常开工：server + 前端一起起，浏览器开 127.0.0.1:5173
pnpm dev:desktop           # ★ 桌面版：build:web + 打 server 单文件 → 起 Electron（约 6s）
pnpm dev:faux              # 只起 server（TENON_FAUX=1），打印 TENON_READY {url,port,token,home,model}
pnpm dev:server            # 同上但用真实模型（需要先配 provider，否则 health 的 model 为 null）
pnpm test                  # vitest：58 个测试文件（540 项，含迁移、runtime-sdk、定位、点选校验、diff 折叠、快照触发判据、库快照还原、版本号与发布、发布门禁与预检、组件清单与加载计划）
pnpm smoke                 # 端到端：spawn bin.ts → health → 建应用 → SSE → 历史 → git
pnpm e2e:preview           # 真机预览链路（要联网装 React）：模板 → dev server → 网关 → HMR
pnpm pack:plugin <id>      # ★ 把官方组件打包并签名，同时合并签名索引（需要 TENON_HUB_PRIVATE_KEY 与 TENON_HUB_URL）
pnpm shot:plugins          # ★ 插件页的人眼验收：假 Hub + 真签名包 → 检查更新→更新 → 商店装组件（12 项）
pnpm shot:settings         # ★ 设置页的人眼验收：真 Chromium 里填表→保存→截图（4 张）
pnpm e2e:provider          # ★ BYOK 通路：本地假 OpenAI 服务，真跑流式 + 工具调用 + 落盘（不要 key）
TENON_REAL_MOCK=1 pnpm e2e:real  # ★ 真模型验收的排练：假 provider 走完三个阶段（不要 key）
TENON_REAL_KEY=… pnpm e2e:real   # ★ 真模型验收：生成 → 装组件 → 真 Chromium 里加/删/问（要 key）
pnpm e2e:component         # ★ 组件端到端：真 Chromium 里点球/聊天/HMR/整页刷新（5 项，要联网装 React）
pnpm e2e:fullstack         # ★ 真机全栈链路（要联网装 Nest）：PGlite → 迁移 → 双进程 → CRUD → 重启
pnpm e2e:diff              # ★ 改动/回滚：git.log / show / revert 全走真 HTTP
pnpm e2e:release           # ★ 发布：预检只读 → 门禁拦截 → force 留痕 → 打 tag + 推本地裸库，系统 git 验 fsck / clone
pnpm build:plugins         # 组件 facet → 单文件（server.js / web.js），test 与打包前自动跑
pnpm build:web             # 前端产物
pnpm build:desktop         # 桌面产物：dist/{main.mjs,server,web,templates,plugins} + server/node_modules
pnpm pack:desktop          # electron-builder --dir → apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop         # 桌面冒烟（开发态）：真起 Electron，8 项断言
pnpm smoke:desktop:packaged # 同上，但跑打包后的 Tenon.app
pnpm typecheck             # plugins + 9 个 packages + 2 个 apps + 5 个 spikes + scripts（18 个项目）

# 模板里的副本从 runtime-sdk 同步（改了 src/browser 或 src/nest 之后）
node packages/runtime-sdk/scripts/sync-templates.mjs          # 写入
node packages/runtime-sdk/scripts/sync-templates.mjs --check  # 只校验（测试也在验）
```

spike 复跑入口（历史证据，仍在）：

```bash
pnpm spike:db       # PGlite + TypeORM 压测（含正确性探针）→ spikes/db/results/spike-db.json
pnpm spike:agent    # pi-durable 闭环 + 崩溃续跑            → spikes/agent/results/spike-agent.json
pnpm spike:gateway  # 网关 HMR 代理
pnpm spike:loc      # 定位插件精度
pnpm spike:chord    # chord 宿主：契约/变体/跨 host/热重载/打包（10 项，也是 M5 的回归网）
```

服务端环境变量：`TENON_HOME`（数据目录，默认 `~/.tenon`；桌面版默认 `<userData>/home`）、
`TENON_PORT`（0=随机）、`TENON_HOST`、`TENON_TOKEN`、`TENON_FAUX=1`（假模型）、`TENON_LOG=1`（pino）、
`TENON_WEB_DIR`（给了就同源托管这份渲染器产物）、`TENON_TEMPLATES_DIR`（模板目录）、`TENON_PNPM`（装依赖用的包管理器）、
`TENON_DB_MODE=postgres` + `TENON_DATABASE_URL`（把应用库从 PGlite 切到真 PG；不设就是 `pglite`）。

注入给**生成应用**的只有两个：`DATABASE_URL`（唯一入口，铁律 2）与 `DATABASE_POOL_MAX`（容量参数，PGlite 档恒为 1）。

跨档迁移走 `DatabaseManager.migrate(appId, { mode: 'postgres', connectionString })`：
源是应用当前在用的库，目标是临时起的（迁完就关）。**目标库必须已经跑过 migrations**（先让应用在目标档启动一次），
迁移只搬数据不搬结构。

> 桌面版冒烟在**受限环境**（容器 / 无 GPU / 从 IDE 里跑）需要 `--no-sandbox --disable-gpu`，
> `scripts/smoke-desktop.ts` 已经代劳；产品本身不传这两个开关。

> **本机 shell 注入了 `NODE_OPTIONS=--require=…/node-language-shim.cjs`**（宿主的文件系统代理 + 安全删除守卫）。
> 它会让**写文件密集**的用例慢 10 倍以上：`packages/db-provisioner` 单独跑从 9.7s 变成 250s+，
> 4 个 PGlite 用例全部撞 30s 超时（看着像代码坏了，其实是环境）。
> 在本机跑测试/打包请用：
>
> ```bash
> env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE pnpm test    # 约 1 分钟；不带的话可能 8 分钟起且随机超时
> env -u NODE_OPTIONS pnpm pack:desktop                    # 否则 electron-builder 解压报 Brokered file token refused
> ```
>
> 这不是产品问题：干净环境下 `pnpm test` 就是 ~55s / 128 项全绿。

> `spikes/*/pgdata*`、`spikes/*/work/` 是运行产物，已 gitignore；`results/*.json` 保留入库作为证据。

---

## 7. 新会话开场提示词（可直接粘贴）

```
继续 Tenon（榫）项目，路径 /Users/mac/project/miaoda。

先读 docs/STATUS.md（现状、下一步、陷阱），再读 docs/SPIKES.md（五个 spike 的实测结论，
尤其 §1 的 pool.max=1 硬约束）。涉及架构再查 docs/DESIGN.md（唯一事实来源 v1.2.26），
写 pi 相关代码前必查 docs/PI-CHEATSHEET.md。

当前阶段：**M3 已收口**（源码定位注入 → Alt+Click 反查 → 框选 → Diff 视图 → 代码回滚 → 数据回滚 →
发布 push）；**M4 第 1–7 步已落地**（子 Agent 能派活 + 任务图面板 + 用量与预算熔断 +
e2e 子 Agent 的预览工具 + Reviewer 出风险清单 + CodeAct 的脚本沙箱 + 发布前质量门禁）
+ **发布预检**（`release.check`），**DoD ①②③ 已满足，五个子角色全部 ready**。
**M5 已开工**：第 1 步是 chord 宿主接入 spike（`pnpm spike:chord` 10/10），
撞出「对象默认 referenced → state 随 root 静默归零（必须 `linger`）」与「断链调用会挂住」两条硬约束；
第 2 步是组件加载器（`@tenon/component-host`：清单 / `app.components.json` / 覆盖层解析 /
加载计划 / `component.list`），撞出「覆盖层要按根选版本」与「装不上要 problem 不要 500」。
第 3 步 a/b 让**第一个真组件（AI 小助手）**活了起来：契约 + server facet + 宿主装载 +
注入的模型能力 + web facet（悬浮球）+ 网关 WS 链路（协议层三条用例走真 HTTP 与真 WS）。
第 4 步让 Agent 能**一个工具装组件**（写声明 + 同步 `AGENTS.md` + 装完立刻生效，见 §4.22）。
第 6 步把**插件页**做出来了（列表 / 开关 / 来源标识 / Hub 占位，见 §4.24）。
第 7 步补齐了**另外两个官方插件**（导出 CSV / 审批流）与 L1 积木清单，验证了"规范可复制"（见 §4.25）。
第 8 步把**端到端**跑通了：`pnpm e2e:component` 在真 Chromium 里点球、聊天、改代码触 HMR、
整页刷新 —— **DoD ①③ 已满足，M5 八步全部收口**。

**M5.5（真模型验收）四件全部收口**：`pnpm e2e:real` 12/12（DeepSeek V4.1 Flash，46s / 13.3k token：
一句话做待办 → 一句话让它自己装组件 → 真 Chromium 里加/删/问）；顺带抓出三个"静默变绿"的真 bug
（`install_component` 在真实运行时从没挂上过、工具失败显示成成功、工具抛异常被压成 `<harness>`）。
之后补了模型设置页与热切换、依赖安装时机（TS2688 摩擦）、模型价格表（真账复算偏差 1.28%）。

**M6 第 1–5 步完成（M6 收口）**：Hub 客户端（Ed25519 验签 + 原子落盘 + 来源改写）、签名索引 + 更新检查、
**组件商店**（两个页签 / 装到应用 / 移除 / 付费门禁；真 Chromium 12/12）、
**组件持久化**（`db:*` 权限 + `(appId, componentId)` 命名空间 + 配额；审批流数据活过重启）、
**收口三件**（授权模型定稿 DESIGN §21.5 / Hub 配置随包分发：`env > 随包 hub.json > 未配置` /
`pnpm e2e:hub` 32 项从零发布）。顺带修了两个真问题：付费组件能被下载到本机、Agent 装付费组件说"找不到"。

700 个测试 + smoke 9 + e2e:preview 16 + e2e:inspector 13 + e2e:diff 36 + e2e:release 44 + e2e:e2e 9
+ e2e:component 5 + e2e:provider 7 + e2e:real 12 + e2e:hub 32 + e2e:apps 18 + e2e:export 22 + e2e:docker 21 + e2e:postgres 31 + shot:usage + shot:settings 5 + shot:plugins 12 + shot:export
+ e2e:fullstack + spike:chord 10 + 桌面包全绿。
**收口后补的一批**（盘点"还剩什么没完善"时做的）：
§4.36 界面缺口三连 —— **应用能删了**（`app.delete` 的后端从 M1 就在，界面上一直没有入口，
`deleteApp` 是一段没人调用的死代码）、**能改名了**、**顶栏看得见未发布版本数**；
§4.37 脚本的 `@options` 曾被用来放大超时上限（"60 秒"其实不是 60 秒），现在在工具入口夹住；
§4.38 **导出静态包**（`export.static`）—— 产物拷走就能跑，`e2e:export` 22 项验到"真起 PG、真跑
`./start.sh`、`/api` 真分流"；
§4.39 **Docker 构建上下文**（`export.docker`）—— M2 第 8 步从七月底挂到这里，`e2e:docker` 21 项
在真容器里跑通（compose up → 容器 → 首页 HTML → 拆干净）。
**欠账**：① ~~静态包导出 / Docker 上下文~~ → **两档都已落地（§4.38 / §4.39）**；
② ~~`postgres` 档的库快照依赖 `pg_dump`~~ → **已改成纯 JS 行快照（§4.40）**，不再需要任何二进制；
③ 发布只推得动本地备份库，真远端（GitHub 等）要凭据 + 真网络，没验证所以没接；
④ ~~没有跨应用总闸~~ → **有汇总（§4.41），但仍没有全局上限**（看得见 ≠ 拦得住）；
⑤ 用量答不了“哪个角色花了多少”（聚合层看不见归属）；
⑥ ~~Reviewer 的 `lint` 未接~~ → **已接（§4.46）**，模板有 eslint 配置、门禁有第三项；清单仍只有文本、没有结构化事件/面板；
⑦ ~~脚本的 `// @options: timeout_ms` 能放大沙箱默认超时~~ → **已夹住（§4.37）**；
⑧ ~~门禁不看 `lint`~~ → **已接（§4.46）**；⑨ ~~主界面没有「这个应用现在能不能发」的指示~~
→ **改成了"上次发布之后又改了几版"**（预检太贵，不做常驻），仍缺"门禁结论常驻"；
⑩ **真 Hub 还没上线**：`pack:plugin` 与 `e2e:hub` 证明"包与索引生成得出来、客户端装得上"，
但静态托管、域名、CDN 缓存策略都还没有 —— 换域名必须重新发布（索引里是绝对地址）。
`pnpm test` / `pnpm smoke` 要一直保持绿；动到预览链路跑 `pnpm e2e:preview`，动到库/模板跑 `pnpm e2e:fullstack`，
动到 git / 回滚跑 `pnpm e2e:diff`，动到发布跑 `pnpm e2e:release`，动到 Agent 工具/角色跑 `pnpm e2e:e2e`，
动到组件发布 / Hub 客户端跑 `pnpm e2e:hub`。

三条铁律不要违反：Electron 只做壳 / 生成应用不感知运行环境 / 实验性依赖锁版本 + adapter 包装。
（「安装包零原生模块」**不在**这三条里 —— v1.2.13 起已降为偏好，别再拿它当硬约束挡需求。）
```
