# Tenon（榫）

> 本地优先、开源、可自托管的**对话式 AI 全栈应用搭建平台**（桌面端 + Web 端同构）。
> 用自然语言把应用从 0 做到上线：React + NestJS + PostgreSQL 全栈 + Git 版本 + Docker 部署，且这个应用能被 Agent 持续迭代。

**非官方开源项目，与字节跳动 / 飞书无任何关联。** 「飞书」「妙搭」为字节跳动商标，仅用于产品对比说明。

> **为什么叫「榫」**：榫卯不用一根钉子，靠构件咬合承重 —— 正如应用由标准化组件咬合而成，Agent 只负责设计与搭接。详见 [DESIGN.md §1.5](docs/DESIGN.md)。

## 核心特性（规划）

- 🖥️ **桌面 + Web 同构**：Electron 39 只做壳，业务全在本地 HTTP 服务 → 浏览器也能打开，Agent 可直接调试
- 💬 **对话式搭建**：需求 → 概要设计 → 开发计划 → 逐任务生成 → 精调修复
- 🤖 **多 Agent 编排**：基于 `pi-durable` 的 1 主 + 5 子 Agent（调度 / 检索 / 脚本 / 调研 / E2E 验收 / 审查），崩溃后断点续跑
- 🧩 **组件化应用**：基于 `chord` 的插件体系，一句话给应用装「AI 小助手 / Excel 导出 / 审批流」；免费与收费组件同一套协议
- 🔑 **BYOK**：自带 Key（OpenAI / Anthropic / DeepSeek / GLM / Kimi / Ollama…），三档模型路由（fast / comprehensive / thinking），本地加密存储 + 成本统计
- 🎯 **精调**：点选页面元素或框选区域 → 源码级定位 → 一句话改 UI / 修 Bug
- 🔍 **可观测**：运行时日志、异常聚合、应用状态（任务图）、用量面板，错误一键交给 Agent 修复
- 🌿 **Git 一等公民**：一轮对话一次 commit，发布 push + tag，任意回滚（可含数据快照）
- 🐘 **生产级数据层**：生成的应用统一用 **PostgreSQL 方言**；本地默认 PGlite（WASM 版 PG，零安装、零原生依赖），发布切真 PG，**切换不改一行代码**
- 📦 **Docker 部署**：生成标准 NestJS + React 全栈应用，导出多阶段构建的 Docker 产物，compose 自带数据库
- 🧠 **应用自带记忆**：`docs/AGENTS.md` + ADR + learnings，Agent 越用越懂这个项目

## 平台

| 平台 | 状态 |
|---|---|
| macOS（Apple Silicon / Intel） | 首发 |
| Windows x64 | 首发 |
| Linux | M7 后置 |

## 文档

| 文档 | 内容 |
|---|---|
| [**当前状态与下一步**](docs/STATUS.md) | **新会话/新成员从这里开始**：现状、进度表、下一步拆解、已知陷阱 |
| [**五个 spike 实测**](docs/SPIKES.md) | PGlite+TypeORM 压测、pi-durable 崩溃续跑、网关 HMR 代理、源码定位精度、chord 宿主接入的真实数字 |
| [详细方案设计](docs/DESIGN.md) | **唯一事实来源**（v1.2.26）：架构、技术栈、Agent 体系、数据层、组件生态、契约、UX、路线图 |
| [架构速览](docs/ARCHITECTURE.md) | 一分钟版本 + 不可动摇的四条原则 |
| [行为规格](docs/PROTOCOL.md) | 逆向产出的妙搭行为规格（clean-room，仅协议形状与交互范式） |
| [逆向工作手册](docs/REVERSE_ENGINEERING.md) | 内部研究用（不随开源发布） |

## 状态

M0 逆向研究完成；方案 **v1.2.26**；五个技术 spike 全部跑通。**M1–M5 全部完成（M5 八步收口），
M5.5 真模型验收 12/12，M6 走到第 4 步**：
九个包（`protocol` / `component-host` / `core` / `agent` / `generator` / `gateway` / `db-provisioner` / `runtime-sdk` / `server`）+ 两个 app
（渲染器 `apps/web`，浏览器与窗口共用一套代码；壳 `apps/desktop`，只做生命周期）。

能力边界（都已实测）：

- 服务能起、能对话、能落库、每轮自动 git 提交，崩溃重启后这一轮能续跑
- Agent 有 `read/write/edit/bash` + `ls/glob/grep` 与 `subagent`，**写完的文件进得了这一轮的 commit**
- 新建应用用模板铺出可跑工作区，`preview.start` 装依赖 + 起 dev server + 挂到 App Gateway
- **改 `repo/src/App.tsx` → iframe 里的标题当场变**（HMR 经网关的 WebSocket 透传，页面不整页刷新）
- **生成的应用有后端了**：`nest-api` 模板 = Vite + NestJS 11 + TypeORM + zod 共享层；
  库默认 **PGlite**（WASM 版 PG，零安装），`pool.max` 恒为 1；迁移只写一份，**切真 PG 只改 `DATABASE_URL`**
- **能打成桌面应用**：`pnpm pack:desktop` → `Tenon.app`，双击打开就是上面那套界面；
  主进程不 import 任何 `@tenon/*`（铁律：Electron 只当壳）；安装包**自带 pnpm**，不依赖系统装了什么

**能指着元素改界面了**：预览里按住 Alt 高亮描边、Alt+点一下就把元素反查回 `src/App.tsx:25:3`，
作为上下文 chip 交给 Agent；改动面板逐行显示某一版改了什么，回滚默认只退代码，
勾上「连数据库一起回去」才会连数据一起退（只对改过表结构的版本提供）。

**能发布了**：点「发布」把这个 commit 冻结成 `v2026.11.01-1` 这样的版本（annotated tag，
发布说明写进 tag 正文），并推到本地裸库 `~/.tenon/backups/<appId>.git` ——
那是个标准裸库，`git clone` 出来就是这一版的完整代码。发布前会挡三种状态：正在生成、
工作区有没提交的改动、仓库里一条提交都没有。

**能装组件了（地基）**：应用里装了什么写在它自己的仓库里（`app.components.json`，跟着 git 走），
加载器按 `hub > bundled` 覆盖层挑版本、逐条独立判定；装不上的原因有 21 个稳定 code，
`component.list` 恒 200 把「它要求 Tenon ≥ 1.4.0，你是 1.2.0」这种话说清楚。
**第一个真组件（AI 小助手）的服务端半边已跑起来**：契约 + server facet + 宿主装载 + 注入的模型能力；
界面半边（悬浮球）是下一步。

**能派活了**：主 Agent 可以把「这个东西在哪」「这个库怎么用」交给 `explore` / `librarian` 子角色 ——
那是**真的另一个会话**（独立 transcript、独立工具白名单、独立提示词）。只读角色的工具集里连 `write`
都没有，`subagent` 自己也不在里面（递归派活从工具集上就断了）；没接好的角色会明确回一句「还没接、缺什么」。

**也看得见它在跑**：Agent 一开始动，预览下方就出现一条「任务」—— 展开是任务树，
主对话在等模型、哪个工具任务在跑、子会话跑到哪一步（`Explore 执行中` / `派 #13`）。
它是 `harness.watchTaskGraph()` 逐帧推出来的，不是轮询；**跑完就消失**（pi 会回收任务节点，
所以那是"没人跑了"而不是"没数据"）。

**也看得见花了多少**：顶栏一个小数字，点开是这个应用的账 —— 累计多少 token / 多少钱、
这一轮多少、按模型分几档，以及额度表单。额度顶到线**发都发不出去**，跑在半路冲过线会被当场掐掉。
数字来自 `harness.usage()` 的会话账本（跨重启不丢，含子 Agent 与压缩摘要）——
前端自己累加是算不到的：子 Agent 的花费根本不经过父会话的事件流。

**Agent 会自己去验页面**：e2e 子 Agent 有 `preview_read/assert/click/type/open` 五个工具，
它**驱动的是用户眼前那个页面**（网关往 HTML 注一行脚本、页面反连长轮询领命令，
不新起浏览器、不加依赖）。改完的按钮点一下对不对，现在有 DOM 里的证据，而不是靠读源码猜 ——
`pnpm e2e:e2e` 的 9 项就是这条闭环：注入一个 `+2` 的 bug → 断言失败并报出实测值 →
改回 `+1` → 整页重载 → **同一条断言通过**。

**提交前能叫人来审了**：主角色改完代码能派活给 reviewer，它只拿只读工具加两个判据工具 ——
`git_diff`（**工作区**对 HEAD，不是已提交版本：评审发生在提交之前）与 `typecheck`（跑应用自己的
`tsc`，多个 tsconfig 一起跑）。回来是一份最多五条、带 `path:line` 与修法的风险清单，外加一句
“查了什么、什么没查成”。它**不会把没查成说成没问题**：缺依赖、缺 tsconfig、超时三种都明说“没跑成”。

**也会写脚本了**：CodeAct 拿到一个 QuickJS 沙箱，**一次工具调用**就能 fan-out 读四十个文件、过滤、
汇总，只有它 `text()` 出来的一行结论进上下文 —— 模型不会写循环，这是唯一能把它当循环用的地方。
边界靠三层而不是提示词：会话里有哪些工具、工具能被谁调、递给模型哪些（只给 `codemode`）。
所以脚本里 `tools.write` 调不动不是提示词拦的，是它根本没被注进沙箱。

**坏东西发不出去了**：打 tag 之前先跑应用自己的 `typecheck` 与 `test`，不过就拦下 —— 而且被拒的
发布连 tag 都不留、也不消耗版本号（否则你会看到版本号一路涨却一版都没发出去）。判断是三态：
「这个应用没有那项检查」（没有 test 脚本 / 没有 tsconfig）**放行但说出来**，「有 tsconfig 却没装
typescript」「测试红了」「超时了」必拦 —— 混成一个"不通过"会让没写测试的应用永远发不出去，
而这个功能会在两周内被人关掉。用户确实要发就点「仍然发布」（二次确认），记录里标成 `带问题`。

**而且打开对话框就知道**：不用点了才发现。预检（`release.check`）会真跑一遍 `tsc` 和 `pnpm run test`
（所以界面上有转圈和已等秒数），查完什么都不留下 —— 不打 tag、不写记录、不消耗版本号。
它把三种情况分开说：前提不满足（工作区脏 / 没提交 / 正在生成）连检查都不跑、只告诉你等一等；
检查没过直接把清单摊开、主按钮是「重新检查」；检查通过是绿的。还有一格 `stale`：检查的几十秒里
仓库又前进了，那份「通过」讲的是上一版代码 —— 界面会说「再查一次」，而不是「可以发」。

518 个测试 + 9 项端到端冒烟 + 16 项预览 e2e + 13 项精调 e2e + 36 项改动/回滚 e2e +
44 项发布 e2e（**用系统 git 当裁判**：`fsck --strict` + `clone`）+ 9 项自验收 e2e + 全栈 e2e
+ 8 项桌面冒烟全绿。
安装包默认路径上不带任何需按平台编译的原生模块（打包脚本会审计并打印清单）。

想先跑起来看（**不需要任何 API Key**，用的是 pi-ai 自带的 faux 模型）：

```bash
pnpm install
pnpm dev:web                # ★ server + 前端一起起，浏览器打开 http://127.0.0.1:5173
pnpm dev:desktop            # ★ 或者直接起桌面版
pnpm test                   # 678 项单测 / 集成测试（约 210s，含 PGlite 冷启动与真 QuickJS）
pnpm smoke                  # 9 项端到端（spawn 真进程，走 HTTP + SSE）
pnpm e2e:preview            # 16 项真机全链路（要联网装依赖）：建应用 → 起预览 → 经网关打开 → 改文件 → HMR
pnpm e2e:inspector          # 13 项精调链路：Electron 真 Chromium 里模拟 Alt+Click（要联网）
pnpm e2e:diff               # 36 项改动/回滚链路：git.log / show / revert 全走真 HTTP
pnpm e2e:release            # 44 项发布链路：预检只读 → 门禁拦截 → force 留痕 → 打 tag → 推本地裸库 → 系统 git 验 fsck / clone
pnpm e2e:e2e                # ★ 9 项自验收：真 Electron 里由 e2e 子 Agent 点页面，注入的 bug 被断言抓到、修好后同一条断言通过
pnpm e2e:fullstack          # ★ 全栈真机链路（要联网装 Nest）：起库 → 迁移 → 双进程 → CRUD → 重启后数据还在
pnpm spike:chord            # 10 项：chord 宿主（契约 / 变体 / 跨 host / 热重载 / 打包），M5 的回归网
pnpm e2e:hub                # 32 项：从零发布一个组件（现场生成密钥 → 真打包 → 静态 Hub → 真 server 装进应用）
pnpm e2e:apps               # 18 项：应用菜单（真 Chromium 里点：改名 → 删除 → 取消 → 确认 → 徽标 → 磁盘同步）
pnpm e2e:export             # 22 项：导出静态包并**真的跑起来**（起 PGlite 顶替用户自备的 PG → ./start.sh → /api/health）
pnpm pack:desktop           # 打成 apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop:packaged # 8 项：真的起 .app、加载界面、退出后不留孤儿进程
```

接真模型：`TENON_FAUX=0 pnpm dev:web`（或 `dev:desktop`），再去设置里加一个 OpenAI 兼容的提供商。

**真模型验收已通过**（DeepSeek V4.1 Flash，`pnpm e2e:real` 12/12：一句话做待办 → 一句话装组件 → 真 Chromium 里加/删/问，46s / 13.3k token）。见 STATUS §4.27。**设置页与模型热切换已落地**（顶栏「未配置模型」点开就能填 key，保存即生效、不用重启）。**依赖安装时机也修了**（建应用就装、第一轮前就绪），**模型价格表也有**（填了价才算得出钱，没填显示「未定价」而不是 $0.00）。**M6 第 1–5 步完成**（M6 收口）：Hub 客户端（Ed25519 验签 + 原子落盘）、打包签名脚本 `pnpm pack:plugin`
（同一次产出**签名索引**）、**更新检查**、**组件商店**（两个页签，装/卸 + 来源 + 付费标记），
以及**组件持久化** —— `manifest.permissions` 第一次真的生效：`db:read` / `db:write`
换到一个按 `(应用, 组件)` 命名的键值空间（配额 500 键 / 单值 64KB），审批流的数据现在活过重启。
「检查更新 → 更新」与「商店 → 装到此应用」都在真 Chromium 里跑通（12/12）。
界面会明确说"装了也用不上"：应用声明的版本区间不接受新版时点名是哪个应用挡住了。
收口三件：**授权模型定稿**（DESIGN §21.5：现在不做 license，`paid` 只是"装不了"的安全阀）、
**Hub 配置随包分发**（`env > 随包 hub.json > 未配置`，双击打开也有商店）、
**`pnpm e2e:hub` 32 项**（现场生成密钥 → 真打包 → 静态 Hub → 真 server 装进应用 → 篡改与付费两种拒绝）。
下一步：真 Hub 上线（静态托管 / 域名 / 缓存策略），以及 M7 的第三方上架。
另外补了一个死代码留下的洞：**应用现在能删了**（后端 `app.delete` 从 M1 就在，界面上一直没有入口），
删除会连同代码、数据库、日志和已发布的备份裸库一起清掉；改名只动显示名不动目录；
顶栏「发布」按钮带未发布版本数。`pnpm e2e:apps` 18 项在真 Chromium 里验过。
服务端半边已经落地：契约 + server facet + 插件构建（`pnpm build:plugins`，410KB 单文件）+ 宿主装载。
M3 已收口，欠账与「发布还差什么」见 [STATUS.md §4.8](docs/STATUS.md)，
M4 验收见 §4.9–§4.15；M5 第 1 步（chord spike）见 §4.17、第 2 步（组件加载器）见 §4.18、第 3 步 a（真组件）见 §4.19。
实测数据见 [SPIKES.md](docs/SPIKES.md)，路线图见 [DESIGN.md §17](docs/DESIGN.md)。

## License

- Tenon / Server：**AGPL-3.0-only**
- Runtime SDK、模板、生成物骨架：**Apache-2.0**（你生成的应用不受传染）
- 个人使用免费；商业版双许可（团队协作、SSO/RBAC/审计、私有组件市场、云端能力）

详见 [DESIGN.md §16](docs/DESIGN.md) 与 [§21 组件生态](docs/DESIGN.md)。
