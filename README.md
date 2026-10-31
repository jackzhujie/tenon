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
| [**当前状态与下一步**](docs/STATUS.md) | **新会话/新成员从这里开始**：现状、M1 任务清单、已知陷阱 |
| [**四个 spike 实测**](docs/SPIKES.md) | PGlite+TypeORM 压测、pi-durable 崩溃续跑、网关 HMR 代理、源码定位精度的真实数字 |
| [详细方案设计](docs/DESIGN.md) | **唯一事实来源**（v1.2.4）：架构、技术栈、Agent 体系、数据层、组件生态、契约、UX、路线图 |
| [架构速览](docs/ARCHITECTURE.md) | 一分钟版本 + 不可动摇的四条原则 |
| [行为规格](docs/PROTOCOL.md) | 逆向产出的妙搭行为规格（clean-room，仅协议形状与交互范式） |
| [逆向工作手册](docs/REVERSE_ENGINEERING.md) | 内部研究用（不随开源发布） |

## 状态

M0 逆向研究完成；方案 **v1.2.4**；四个技术 spike 全部跑通。**M1 主干第 1~7 步已落地**：
六个包（`protocol` / `core` / `agent` / `generator` / `gateway` / `server`）能起服务、能对话、能落库、能自动提交，
Agent 有 `read/write/edit/bash` 四个工具、能真的改代码；新建应用会用 `react-vite` 模板铺出可跑的工作区，
`preview.start` 装依赖 + 起 Vite + 挂到 App Gateway 后面 —— **iframe 里打开的就是它**（实测 4.3s 就绪）。
62 个测试 + 9 项端到端冒烟 + 1 条真机 e2e 全绿。

想先跑起来看（**不需要任何 API Key**）：

```bash
pnpm install
pnpm dev:faux     # 起 server，打印 TENON_READY {url,port,token,home,model}
pnpm test         # 62 项单测 / 集成测试
pnpm smoke        # 9 项端到端（spawn 真进程，走 HTTP + SSE）
pnpm e2e:preview  # 真机全链路（要联网装依赖）：建应用 → 起预览 → 经网关打开 → 改文件
```

**还没做的**：Web 前端、Electron 壳 —— 见 [STATUS.md §4.2/§4.4](docs/STATUS.md)。实测数据见 [SPIKES.md](docs/SPIKES.md)，路线图见 [DESIGN.md §17](docs/DESIGN.md)。

## License

- Tenon / Server：**AGPL-3.0-only**
- Runtime SDK、模板、生成物骨架：**Apache-2.0**（你生成的应用不受传染）
- 个人使用免费；商业版双许可（团队协作、SSO/RBAC/审计、私有组件市场、云端能力）

详见 [DESIGN.md §16](docs/DESIGN.md) 与 [§21 组件生态](docs/DESIGN.md)。
