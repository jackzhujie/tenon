# 妙搭开源复刻（工作名 studio）

> 本地优先、开源、可自托管的**对话式 AI 全栈应用搭建平台**（桌面端 + Web 端同构）。
> 用自然语言把应用从 0 做到上线：React 全栈 + 本地数据 + Git 版本 + Docker 部署，且这个应用能被 Agent 持续迭代。

**非官方开源项目，与字节跳动 / 飞书无任何关联。** 「飞书」「妙搭」为字节跳动商标，仅用于产品对比说明。

## 核心特性（规划）

- 🖥️ **桌面 + Web 同构**：Electron 39 只做壳，业务全在本地 HTTP 服务 → 浏览器也能打开，Agent 可直接调试
- 💬 **对话式搭建**：需求 → 概要设计 → 开发计划 → 逐任务生成 → 精调修复
- 🤖 **多 Agent 编排**：基于 `pi-durable` 的 1 主 + 5 子 Agent（调度 / 检索 / 脚本 / 调研 / E2E 验收 / 审查），崩溃后断点续跑
- 🔑 **BYOK**：自带 Key（OpenAI / Anthropic / DeepSeek / GLM / Kimi / Ollama…），三档模型路由（fast / comprehensive / thinking），本地加密存储 + 成本统计
- 🎯 **精调**：点选页面元素或框选区域 → 源码级定位 → 一句话改 UI / 修 Bug
- 🔍 **可观测**：运行时日志、异常聚合、应用状态、用量面板，错误一键交给 Agent 修复
- 🌿 **Git 一等公民**：一轮对话一次 commit，发布 push + tag，任意回滚（可含数据快照）
- 📦 **Docker 部署**：生成标准 NestJS + React 全栈应用，导出多阶段构建的 Docker 产物，单容器单端口
- 🧠 **应用自带记忆**：`docs/AGENTS.md` + ADR + learnings，Agent 越用越懂这个项目

## 文档

| 文档 | 内容 |
|---|---|
| [详细方案设计](docs/DESIGN.md) | **唯一事实来源**：架构、技术栈、Agent 体系、契约、生成规范、UX、协议、路线图 |
| [架构速览](docs/ARCHITECTURE.md) | 一分钟版本 + 不可动摇的三条原则 |
| [行为规格](docs/PROTOCOL.md) | 逆向产出的妙搭行为规格（clean-room，仅协议形状与交互范式） |
| [逆向工作手册](docs/REVERSE_ENGINEERING.md) | 内部研究用（不随开源发布） |

## 状态

M0 逆向研究已完成，进入**详细方案设计评审**。路线图见 [DESIGN.md §17](docs/DESIGN.md#17-里程碑)。

## License

- Studio / Server：**AGPL-3.0-only**
- Runtime SDK、模板、生成物骨架：**Apache-2.0**（你生成的应用不受传染）
- 商业版：双许可（团队协作、SSO/RBAC/审计、私有市场、云端能力）

详见 [DESIGN.md §16](docs/DESIGN.md#16-开源协议与商业化)。
