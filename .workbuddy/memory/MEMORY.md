# 项目长期记忆 — 妙搭开源复刻（miaoda-oss）

## 项目定位
- 开源复刻飞书妙搭：本地优先、对话式 AI 全栈应用搭建平台，Rust（Tauri 2）桌面跨端
- 用户有妙搭账号，走 rea MCP 逆向路线 A（CDP analyze_web_bundle）+ B（HAR inspect_web_network_capture）

## 已确认决策（2026-10-24）
- 框架：Tauri 2，前端 React+TS+Vite（复刻妙搭技术栈），核心逻辑全在 Rust crates
- 发布：自托管单二进制（rust-embed + Axum + SQLite + schema 自动 CRUD），不用飞书服务器
- LLM：BYOK 多提供商（OpenAI 兼容/Anthropic/DeepSeek），本地加密存 key
- License：Apache-2.0；命名规避「妙搭/Miaoda/飞书」商标；与字节无关联免责声明

## 关键约定
- Cargo workspace：protocol/orchestrator/llm-gateway/appgen/runtime/storage/versioning/exporter
- Clean-room 原则：rea Evidence 仅内部研究（docs/reverse/，已 gitignore），开源仓库只含重写规格
- 逆向环境：调试 Chrome CDP 127.0.0.1:9222，profile /tmp/miaoda-rea-profile（--no-sandbox 启动）
- 架构文档 docs/ARCHITECTURE.md 为单一事实来源；逆向问题清单在 docs/REVERSE_ENGINEERING.md §4
