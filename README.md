# 妙搭开源复刻（工作名 miaoda-oss）

> 本地优先、开源、可自托管的对线式 AI 全栈应用搭建平台（桌面端）。
> 用自然语言对话生成 React 全栈应用，数据本地存储，一键导出自托管单二进制。

**非官方开源项目，与字节跳动 / 飞书无任何关联。** 「飞书」「妙搭」为字节跳动商标，仅用于产品对比说明。

## 核心特性（规划）

- 🖥️ 跨平台桌面端（Tauri 2 + Rust 核心 + React 前端）
- 💬 对话式搭建：需求 → 概要设计 → 开发计划 → 逐任务生成 → 精调修复
- 🤖 多 Agent 编排：需求分析 / 功能设计 / 数据管控 / 应用开发 / 问题修复
- 🔑 BYOK：自带 LLM API Key（OpenAI 兼容 / Anthropic / DeepSeek），本地加密存储
- 🗄️ 本地数据层：SQLite，应用间隔离，无云端依赖
- 📦 自托管发布：导出「静态资源 + REST API + SQLite」三合一单二进制，`./myapp --port 8080` 即上线
- ⏪ 版本管理：生成前自动快照，任意回滚

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [逆向工作手册](docs/REVERSE_ENGINEERING.md)（内部研究用，不随开源发布）
- [行为规格](docs/PROTOCOL.md)（逆向产出，持续更新）

## 状态

M0 逆向研究阶段。路线图见 [架构设计 §8](docs/ARCHITECTURE.md#8-里程碑)。

## License

Apache-2.0（规划）
