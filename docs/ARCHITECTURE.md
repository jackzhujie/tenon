# ARCHITECTURE.md — 总体架构设计 v0.1

> 状态：已确认四项核心决策（2026-10-24）
> ① 逆向路线 A+B（CDP + HAR）② Tauri 2 桌面框架 ③ 自托管单二进制发布 ④ BYOK 多提供商 LLM

## 1. 项目定位

**一句话**：本地优先、开源、可自托管的对线式 AI 全栈应用搭建平台（桌面端）。

对标飞书妙搭，但把「云」全部下沉为「本地」：

| 能力 | 飞书妙搭 | 本项目 |
|---|---|---|
| 产品形态 | 云端 Web 平台 | Tauri 2 桌面应用（Win/mac/Linux） |
| 前端技术栈 | React | React + TS + Vite（复刻同栈） |
| 后端 | 云端 PostgreSQL + 独立容器 | 本地 SQLite + WebView 沙箱 |
| LLM | 豆包（内置） | BYOK：用户自配 Key（OpenAI 兼容 / Anthropic / DeepSeek，可扩展 Ollama） |
| 多 Agent | 需求分析 / 功能设计 / 数据管控 / 应用开发 / 问题修复 | 同范式，Rust 编排器实现 |
| 登录鉴权 | 飞书账号 / 手机号 | 无账号（本地），导出应用可选简单 Token |
| 发布 | 飞书服务器环境 + 范围发布 | **自托管单二进制导出**（Axum + SQLite + 静态资源） |
| 生态集成 | 妙搭机器人 / 云文档 / 飞书消息 | 开放 Webhook / Bot 插件化（飞书、钉钉、Slack 可选） |

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│                    Tauri 2 桌面应用                          │
│                                                            │
│  ┌──────────────────────────────────────────────────┐      │
│  │ 前端（React 19 + TS + Vite）                      │      │
│  │  对话流 · 开发计划面板 · 消息队列 · 主题布局面板    │      │
│  │  预览窗管理 · 版本时间线 · 选中元素/错误上下文      │      │
│  └───────────────▲──────────────────────────────────┘      │
│                  │ Tauri IPC (commands/events)              │
│  ┌───────────────┴──────────────────────────────────┐      │
│  │ Rust 核心（Cargo workspace）                     │      │
│  │  orchestrator  多 Agent 状态机 + 任务清单 + 消息队列 │   │
│  │  llm-gateway   BYOK 提供商抽象 + 流式 + 工具调用    │    │
│  │  appgen        代码生成器（React 项目模板 + SDK 注入）│  │
│  │  runtime       生成应用沙箱（WebView 隔离 + 数据 API）│  │
│  │  storage       SQLite：应用元数据/对话历史/业务数据   │  │
│  │  versioning    应用快照 / 回滚（内容寻址）            │  │
│  │  exporter      自托管单二进制打包                     │  │
│  │  protocol      DSL/搭建块 schema（serde）             │  │
│  └──────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
```

## 3. Cargo Workspace

```
miaoda-oss/
├── apps/
│   └── desktop/            # Tauri 壳 + React 前端（src/ 为前端，src-tauri/ 为壳）
├── crates/
│   ├── protocol/           # DSL/搭建块 schema，serde 序列化，纯数据定义
│   ├── orchestrator/       # 多 Agent 编排：状态机、任务清单、消息队列
│   ├── llm-gateway/        # Provider trait + OpenAI 兼容/Anthropic/DeepSeek 实现
│   ├── appgen/             # 生成器：模板化 React 项目 + client SDK 注入
│   ├── runtime/            # 沙箱运行时：dev 预览服务 + 数据 API
│   ├── storage/            # rusqlite 封装 + 迁移 + 应用隔离
│   ├── versioning/         # 快照（blake3 内容寻址）、diff、回滚
│   └── exporter/           # 单二进制打包：rust-embed + axum + 自动 CRUD
└── docs/
```

依赖方向（禁止反向）：`protocol` ← 所有；`orchestrator` → `llm-gateway`/`appgen`/`storage`/`versioning`；`exporter` → `runtime`/`storage`。

## 4. 生成应用的技术栈

- **React + Vite SPA**（与妙搭生成物同栈，降低 prompt 复杂度与学习成本）
- 注入 `@app/client` SDK，数据访问统一走 storage API，**双后端同构**：
  - 桌面开发态：Tauri command → rusqlite（进程内，零延迟）
  - 自托管导出态：HTTP `GET/POST/PATCH/DELETE /api/tables/:table` → axum → rusqlite
- 表结构由 DSL schema 驱动，自动生成迁移；业务数据独立 SQLite 文件，按应用隔离

## 5. 发布链路（替代飞书服务器）

```
导出产物 = 单个可执行文件
  ├── rust-embed 内嵌 React 静态构建产物
  ├── DSL schema → 自动生成 REST CRUD API（含分页/过滤/排序）
  ├── axum 静态服务 + /api/* + 可选简单 Token 鉴权
  └── SQLite 数据文件（首次运行自动初始化）

使用：./myapp --port 8080 --db ./data.sqlite
交叉编译：Windows/macOS/Linux × x64/arm64（GitHub Actions matrix）
```

后续可选扩展：导出静态站点（仅前端模式）、导出独立桌面应用。

## 6. 多 Agent 编排（对齐妙搭行为规格，细节以逆向产出为准）

阶段流水线：**需求分析 → 概要设计确认 → 开发计划（需求分析+技术方案+任务清单）→ 逐任务开发 → 检查/修复 → 预览 → 发布**

- 消息队列：用户消息排队串行处理，可调整顺序/删除
- 选中上下文：前端元素选择器 / 错误信息选中 → 注入对话上下文
- 版本快照：每次生成动作前自动快照，支持任意回滚
- Agent 角色（M1 先单体循环，M2 拆分专职）：Planner / Designer / DataKeeper / Developer / Fixer

## 7. 开源治理与合规

- **License**：Apache-2.0（含专利授权，利于生态采纳）
- **命名**：产品名严禁含「妙搭 / Miaoda / 飞书 / Feishu」（字节商标）；候选名待定：Fabrick / 搭坊 Dafang / OpenFab
- **Clean-room 原则**：逆向只产出行为规格（协议形状、交互范式、信息架构），**严禁**复制字节的代码、资源、文案、提示词原文
- **免责声明**：README 明示非官方项目、与字节跳动/飞书无关联
- CI：GitHub Actions（clippy + fmt + test + 三平台 Tauri 构建）

## 8. 里程碑

| 阶段 | 内容 | 依赖 |
|---|---|---|
| M0 | 逆向规格（CDP bundle 图 + HAR API surface + 行为规格文档） | 用户登录妙搭账号 |
| M1 | 桌面壳 + 对话式搭建 + 编排器 + BYOK 网关（仅前端应用） | M0 |
| M2 | 沙箱运行时 + SQLite 数据层 + 完整应用模式 | M1 |
| M3 | 自托管单二进制导出 + 版本管理 | M2 |
| M4 | 打磨、生态插件、开源发布 | M3 |
