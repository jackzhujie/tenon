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
| [**四个 spike 实测**](docs/SPIKES.md) | PGlite+TypeORM 压测、pi-durable 崩溃续跑、网关 HMR 代理、源码定位精度的真实数字 |
| [详细方案设计](docs/DESIGN.md) | **唯一事实来源**（v1.2.7）：架构、技术栈、Agent 体系、数据层、组件生态、契约、UX、路线图 |
| [架构速览](docs/ARCHITECTURE.md) | 一分钟版本 + 不可动摇的四条原则 |
| [行为规格](docs/PROTOCOL.md) | 逆向产出的妙搭行为规格（clean-room，仅协议形状与交互范式） |
| [逆向工作手册](docs/REVERSE_ENGINEERING.md) | 内部研究用（不随开源发布） |

## 状态

M0 逆向研究完成；方案 **v1.2.7**；四个技术 spike 全部跑通。**M1 全部完成 + M2 第 1 步完成**：
七个包（`protocol` / `core` / `agent` / `generator` / `gateway` / `db-provisioner` / `server`）+ 两个 app
（渲染器 `apps/web`，浏览器与窗口共用一套代码；壳 `apps/desktop`，只做生命周期）。

能力边界（都已实测）：

- 服务能起、能对话、能落库、每轮自动 git 提交，崩溃重启后这一轮能续跑
- Agent 有 `read/write/edit/bash` 四个工具，**写完的文件进得了这一轮的 commit**
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

277 个测试 + 9 项端到端冒烟 + 16 项预览 e2e + 13 项精调 e2e + 36 项改动/回滚 e2e +
32 项发布 e2e（**用系统 git 当裁判**：`fsck --strict` + `clone`）+ 全栈 e2e + 8 项桌面冒烟全绿。
安装包默认路径上不带任何需按平台编译的原生模块（打包脚本会审计并打印清单）。

想先跑起来看（**不需要任何 API Key**，用的是 pi-ai 自带的 faux 模型）：

```bash
pnpm install
pnpm dev:web                # ★ server + 前端一起起，浏览器打开 http://127.0.0.1:5173
pnpm dev:desktop            # ★ 或者直接起桌面版
pnpm test                   # 277 项单测 / 集成测试（约 100s，含 PGlite 冷启动）
pnpm smoke                  # 9 项端到端（spawn 真进程，走 HTTP + SSE）
pnpm e2e:preview            # 16 项真机全链路（要联网装依赖）：建应用 → 起预览 → 经网关打开 → 改文件 → HMR
pnpm e2e:inspector          # 13 项精调链路：Electron 真 Chromium 里模拟 Alt+Click（要联网）
pnpm e2e:diff               # 36 项改动/回滚链路：git.log / show / revert 全走真 HTTP
pnpm e2e:release            # 32 项发布链路：打 tag → 推本地裸库 → 系统 git 验 fsck / clone
pnpm e2e:fullstack          # ★ 全栈真机链路（要联网装 Nest）：起库 → 迁移 → 双进程 → CRUD → 重启后数据还在
pnpm pack:desktop           # 打成 apps/desktop/release/mac/Tenon.app
pnpm smoke:desktop:packaged # 8 项：真的起 .app、加载界面、退出后不留孤儿进程
```

接真模型：`TENON_FAUX=0 pnpm dev:web`（或 `dev:desktop`），再去设置里加一个 OpenAI 兼容的提供商。

**下一步**：M4。M3 已收口，欠账与「发布还差什么」见 [STATUS.md §4.8](docs/STATUS.md)。
实测数据见 [SPIKES.md](docs/SPIKES.md)，路线图见 [DESIGN.md §17](docs/DESIGN.md)。

## License

- Tenon / Server：**AGPL-3.0-only**
- Runtime SDK、模板、生成物骨架：**Apache-2.0**（你生成的应用不受传染）
- 个人使用免费；商业版双许可（团队协作、SSO/RBAC/审计、私有组件市场、云端能力）

详见 [DESIGN.md §16](docs/DESIGN.md) 与 [§21 组件生态](docs/DESIGN.md)。
