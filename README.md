# Tenon（榫）

[![CI](https://github.com/jackzhujie/tenon/actions/workflows/ci.yml/badge.svg)](https://github.com/jackzhujie/tenon/actions/workflows/ci.yml)

> 本地优先、开源、可自托管的**对话式 AI 全栈应用搭建平台**（桌面端 + Web 端同构）。
> 用自然语言把应用从 0 做到上线：React + NestJS + PostgreSQL 全栈 + Git 版本 + Docker 部署，且这个应用能被 Agent 持续迭代。

**非官方开源项目，与字节跳动 / 飞书无任何关联。** 「飞书」「妙搭」为字节跳动商标，仅用于产品对比说明。

> **为什么叫「榫」**：榫卯不用一根钉子，靠构件咬合承重 —— 正如应用由标准化组件咬合而成，Agent 只负责设计与搭接。详见 [DESIGN.md §1.5](docs/DESIGN.md)。

## 快速开始

要求 **Node ≥ 22.19** 与 **pnpm 9**（`corepack enable` 即可）。

```bash
pnpm install
pnpm dev:web      # server + 前端一起起，然后打开它打印的地址（默认 http://127.0.0.1:5173）
# 或者
pnpm dev:desktop  # 直接起桌面版
```

**不需要任何 API Key。** `dev:web` / `dev:desktop` 默认开 `TENON_FAUX=1`，
用 pi-ai 自带的假模型把「提交 → 流式 → 落库 → git 提交」这条链路完整跑一遍 ——
回复内容是假的，但流程是真的。想接真模型：

```bash
TENON_FAUX=0 pnpm dev:web
```

然后在顶栏「未配置模型」里填一个 OpenAI 兼容的提供商（OpenAI / Anthropic / DeepSeek /
GLM / Kimi / Ollama…），保存即生效，不用重启。Key 本地加密存储。

数据都在 `~/.tenon/`（可用 `TENON_HOME` 改），删掉就等于重装。

## 核心特性

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
| macOS（Apple Silicon / Intel） | 首发。有 `.app`（未签名公证） |
| Windows x64 | **核心 + Web 模式已在 CI 里跑通**（lint / 类型 / 803 项测试 / 前端构建）。桌面安装包还没产出 —— `electron-builder` 只在 macOS 上打过 `--dir` |
| Linux | 桌面端 M7 后置；**核心测试在 CI 的 ubuntu 里跑**（服务端本身没问题，缺的是桌面壳的打包与验证） |

CI 是**三平台矩阵**（ubuntu / macOS / Windows）。这不是为了好看：这套东西到处在
spawn 子进程、拼路径、判断退出码，差别全藏在"本地绿、CI 红"里 —— 铺开第一次就抓到
**四个只在 Windows 上出现的 bug**（其中 `pnpm build:plugins` 静默空跑、删应用永远失败
两个是产品级），见 [STATUS §4.50](docs/STATUS.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [**当前状态与下一步**](docs/STATUS.md) | **新会话/新成员从这里开始**：现状、进度表、下一步拆解、已知陷阱 |
| [**五个 spike 实测**](docs/SPIKES.md) | PGlite+TypeORM 压测、pi-durable 崩溃续跑、网关 HMR 代理、源码定位精度、chord 宿主接入的真实数字 |
| [详细方案设计](docs/DESIGN.md) | **唯一事实来源**（v1.2.26）：架构、技术栈、Agent 体系、数据层、组件生态、契约、UX、路线图 |
| [架构速览](docs/ARCHITECTURE.md) | 一分钟版本 + 不可动摇的四条原则 |
| [行为规格](docs/PROTOCOL.md) | 逆向产出的妙搭行为规格（clean-room，仅协议形状与交互范式） |

## 状态

**M1–M6 全部收口**，方案 v1.2.26，五个技术 spike 全跑通，**803 项单测 + 26 个端到端/验收脚本**绿（三个平台各跑一遍）。
九个包（`protocol` / `component-host` / `core` / `agent` / `generator` / `gateway` /
`db-provisioner` / `runtime-sdk` / `server`）+ 两个 app（渲染器 `apps/web`，浏览器与窗口共用一套代码；
壳 `apps/desktop`，只做生命周期）。

能用的（**都已实测**，坑怎么踩的见 [STATUS.md](docs/STATUS.md)）：

| 能力 | 一句话 |
|---|---|
| 对话建应用 | 建应用 → 模板铺出可跑工作区 → 装依赖 → 起 dev server → 挂到网关，不需要 key |
| 实时看改动 | 改 `repo/src/App.tsx` → iframe 里的标题当场变（HMR 经网关 WebSocket 透传，不整页刷新） |
| 指着元素改 | 预览里 Alt+点一下，把元素反查回 `src/App.tsx:25:3` 作为上下文交给 Agent |
| 全栈 | 需要后端时**在已有应用上加**（`app.addBackend` / Agent 的 `add_backend`）：补 `api/`（NestJS 11 + TypeORM）+ `shared/` zod 契约 + 迁移目录，前端代码一行不动。库默认 PGlite（WASM 版 PG，零安装），**切真 PG 只改 `DATABASE_URL`** |
| 技术栈 | 建应用只问「要做什么」，栈由 Agent 按需求决定（想自己选的话对话框里有「我要自己选」） |
| 读得下去 | 连续的只读探索（`cat` / `find` / `读取 x`）合成一行「查看代码 · N 项」，展开才是逐条；子 Agent 的步骤缩进在派它的那一步下面；回答里的标题/表格/代码块都真渲染 |
| Git 一等公民 | 一轮对话一次 commit；改动面板逐行看某一版改了什么，回滚默认只退代码，可勾「连数据库一起回去」 |
| 多 Agent | 1 主 + 5 子（调度 / 检索 / 脚本 / 调研 / E2E 验收 / 审查），**是真的另一个会话**（独立 transcript 与工具白名单）；能派活、能审代码、能自己点页面断言，崩溃后断点续跑 |
| 看得见 | 任务树逐帧推（不是轮询）、用量面板（含跨应用汇总与单次派活成本）、运行时日志、异常聚合 |
| 组件 | 一句话装「AI 小助手 / 导出 CSV / 审批流」；装什么写在应用自己的仓库里跟着 git 走，按 `hub > bundled` 覆盖层选版本；`db:*` 权限换到 `(应用, 组件)` 键值空间，数据活过重启 |
| 发布 | 打 annotated tag + 推本地裸库（标准裸库，`git clone` 出来就是这一版）；发布前门禁**并行**真跑 `tsc` / `test` / `lint`，三态判定，被拒的发布不留 tag、不消耗版本号；**同一版代码再打开对话框不重跑**（存档 + 三条判据） |
| 导得出 | 静态包（拷走就能跑）/ Docker 上下文（compose 自带 PG，迁移自动跑）/ 桌面 `.app`（自带 pnpm，不依赖系统装了什么） |

**还差什么**（完整清单与理由见 [STATUS.md](docs/STATUS.md) 的欠账段）：
真 Hub 未上线（静态托管 / 域名 / CDN 缓存）、真远端 push 要凭据、
**签名与公证**（安装包能打出来了，但未签名：mac 会被 Gatekeeper 拦、Windows 会弹
"未知发布者"，要 Apple $99/年 + Windows 代码签名证书）、
Windows / Linux 的产物还没被真启动过（CI 上没有 GUI）、
跨应用用量有汇总但**没有**全局上限（看得见 ≠ 拦得住）。

## 开发与验证

```bash
pnpm lint                   # eslint（约 3 秒）：0 error / 10 warning（那 10 条是 effect 里 setState 的性能建议）
pnpm typecheck              # 18 个 tsconfig（含 scripts 与 spikes）
pnpm test                   # 803 项单测/集成，约 210s（含 PGlite 冷启动与真 QuickJS）
pnpm build:web              # 前端产物（server 启动时把它读进内存）
```

端到端脚本按链路分组。**多数要联网装依赖**；标 ★ 的是真机全链路（真进程 / 真 Chromium / 真容器）。
下表 23 条；另有三个**人眼截图验收**脚本不在表内：`pnpm shot:settings` / `shot:export` / `shot:plugins`。

| 命令 | 项数 | 验什么 |
|---|---|---|
| `pnpm smoke` | 9 | 端到端冒烟：spawn 真进程，走 HTTP + SSE |
| `pnpm e2e:preview` ★ | 16 | 建应用 → 起预览 → 经网关打开 → 改文件 → HMR |
| `pnpm e2e:inspector` ★ | 13 | 精调链路：真 Chromium 里模拟 Alt+Click |
| `pnpm e2e:diff` | 36 | 改动/回滚：`git.log` / `show` / `revert` 全走真 HTTP |
| `pnpm e2e:release` | 44 | 发布：预检只读 → 门禁拦截 → `force` 留痕 → 打 tag → 推裸库 → **系统 git 当裁判**（`fsck --strict` + `clone`） |
| `pnpm e2e:e2e` ★ | 9 | 自验收：真 Electron 里由 e2e 子 Agent 点页面，注入的 bug 被断言抓到、修好后同一条断言通过 |
| `pnpm e2e:fullstack` ★ | — | 全栈：起库 → 迁移 → 双进程 → CRUD → 重启后数据还在 |
| `pnpm e2e:apps` ★ | 18 | 应用菜单：真 Chromium 里改名 → 删除 → 取消 → 确认 → 徽标 → 磁盘同步 |
| `pnpm e2e:component` ★ | 5 | 组件装卸全链路 |
| `pnpm e2e:hub` | 32 | 从零发布一个组件：现场生成密钥 → 真打包 → 静态 Hub → 真 server 装进应用 → 篡改与付费两种拒绝 |
| `pnpm e2e:export` ★ | 22 | 导出静态包并**真的跑起来**（起 PGlite 顶替用户自备的 PG → `./start.sh` → `/api/health`） |
| `pnpm e2e:docker` ★ | 21 | 导出 Docker 上下文并真跑 compose（带 PG、迁移自动跑；没有 docker 就 skip） |
| `pnpm e2e:postgres` ★ | 31 | 起真 `postgres:18-alpine`，验跨档迁移与纯 JS 快照（没有 docker 就 skip） |
| `pnpm e2e:real` ★ | 12 | 真模型验收（要真 key）：一句话做待办 → 一句话装组件 → 真 Chromium 里加/删/问 |
| `pnpm e2e:provider` | — | BYOK 接线（真模型验收的前置）：本地假 OpenAI 服务走完整条路 —— profile 加密存库 → resolveModel → 流式 SSE → 工具落盘 → 收尾 → commit。**它证明我们这一侧没坏**，于是接真 key 后若不对，问题只可能在模型或提示词 |
| `pnpm shot:chat` ★ | — | **对话界面的人眼验收**：faux 剧本真跑一轮（探索 + 派 explore 子 Agent）→ Electron 截四张图（合并后 / 子代理运行中 / 展开 / Markdown）。三件事都是"看着对不对"，单测答不了 |
| `pnpm e2e:backend` ★ | 14 | **加后端真跑一遍**：建纯前端应用（`type: module`）→ `app.addBackend` → 起预览 → 经网关 `/api/health` 200 / `poolMax=1` → 产物目录钉成 commonjs → 前端照常开 |
| `pnpm e2e:packaged` ★ | — | **打包版运行时**：用 Electron 二进制跑 `dist/server/server.mjs`，PATH 里没有 node → 建应用 → 门禁 lint 真跑 → 导出静态包。这条修的是"装上之后发布/导出全挂"那类只在包里出现的故障 |
| `pnpm spike:chord` | 10 | chord 宿主回归网（契约 / 变体 / 跨 host / 热重载 / 打包） |
| `pnpm smoke:desktop` | 8 | 桌面冒烟：`build:desktop` → 真起窗口 |
| `pnpm smoke:desktop:packaged` | 8 | 打包产物冒烟：真的起 `.app`、加载界面、退出后不留孤儿进程 |
| `pnpm shot:usage` | — | 人眼验收：用量面板三个应用 → 截图看「全部应用」那一行 |
| `pnpm shot:release` | — | 人眼验收：发布对话框（故意不装依赖 → 门禁真红）→ 截图看三项清单与"同一版代码"那句 |

打包有两个档位：

```bash
pnpm pack:desktop   # electron-builder --dir → apps/desktop/release/mac/Tenon.app（快，给冒烟用）
pnpm dist:desktop   # 同上 + dmg / zip（要分发给别人时用；macOS 上产出 .dmg 与 .zip）
```

**产物不自带签名与公证**（`identity: null`）。所以拷到别人 Mac 上会被 Gatekeeper 拦：
右键「打开」一次、或 `xattr -dr com.apple.quarantine /Applications/Tenon.app`。
要真正"双击就开"需要 Apple Developer 账号（$99/年）。

**不需要任何外部运行环境**：Node 不用装（用 Electron 二进制 + `ELECTRON_RUN_AS_NODE` 跑
`server.mjs`）、pnpm 随包（`Resources/server/node_modules/pnpm`）、数据库是 PGlite 的 WASM
（`pglite.wasm` 也在包里）。`pack:desktop` 会审计并按平台列出包内的 `.node` 文件。

**三个平台的安装包在 CI 上打**（[`.github/workflows/desktop.yml`](.github/workflows/desktop.yml)）：
推 `v*` tag 或手动 `workflow_dispatch`，产出四个 artifact ——

| artifact | 内容 |
|---|---|
| `tenon-mac-arm64` | `Tenon-<ver>-arm64.dmg` + `.zip` |
| `tenon-mac-x64` | `Tenon-<ver>.dmg` + `.zip`（交叉编译，给 Intel 机器） |
| `tenon-win-x64` | `Tenon Setup <ver>.exe`（NSIS） |
| `tenon-linux-x64` | `Tenon-<ver>.AppImage` |

macOS 那份会在 CI 里**真启动一次**（`smoke:desktop:packaged`）；Windows / Linux 的
runner 没有 GUI 会话，那边只验"打得出来"。

推 `v*` tag 时会把这些产物挂成一个 **GitHub Release**（含 `SHA256SUMS.txt`），
这样不用登录、链接也不会过期。最近的预览版：
**[v0.0.0-alpha.2](https://github.com/jackzhujie/tenon/releases/tag/v0.0.0-alpha.2)**。

> 未签名：mac 首次打开要右键 →「打开」（或 `xattr -dr com.apple.quarantine`），
> Windows 会弹 SmartScreen「未知发布者」→ 更多信息 → 仍要运行。

实测数据见 [SPIKES.md](docs/SPIKES.md)，路线图见 [DESIGN.md §17](docs/DESIGN.md)。

## License

**本仓库按目录分区授权**，不是单一协议（完整映射见 [NOTICE](NOTICE)）：

| 范围 | 协议 | 意味着 |
|---|---|---|
| `apps/*`、`packages/*`（除下面两项） | **AGPL-3.0-only** | 自用、改、分发都行；但把它**作为网络服务对外提供**时必须开源你的修改 |
| `packages/runtime-sdk`、`packages/generator/templates`、`plugins/` | **Apache-2.0** | **你生成的应用不受 AGPL 传染** —— 归你所有，可闭源、可商用、可再卖 |
| `docs/` | **CC BY 4.0** | 文档可自由引用改写，只要署名 |

**个人使用免费**（含个人承接的外包交付）。以下两种情况需要商业授权（双许可）：
以**公司身份在内部多人部署**，或需要**闭源集成**（含免除 AGPL 义务）的企业功能，
如团队协作、SSO/RBAC/审计、私有组件市场、云端同步。商业版另有组织级能力，
见 [DESIGN.md §16.2](docs/DESIGN.md)。

**商标**：「Tenon」「榫」与 Logo 不在上述协议授权范围内。基于本仓库做衍生分发必须改名、
并移除官方标识 —— 协议给的是代码，不是品牌。

详见 [DESIGN.md §16](docs/DESIGN.md) 与 [§21 组件生态](docs/DESIGN.md)。
