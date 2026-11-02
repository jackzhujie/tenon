# AI 小助手（tenon.official.ai-assistant）

给**最终用户**用的对话组件，不是给 Agent 改页面的工具。

## 它是什么

一个只有两件事的组件：`ask(text)` 与 `clear()`。回答写进 `messages` 状态，界面订阅状态渲染 ——
所以浏览器刷新、重连之后对话还在（状态在服务端对象上）。

## 它不是什么

- **没有工具**：它不改代码、不提交、不跑命令。它的模型会话是 `ownerless` + 空工具集。
- **不自己调模型**：它拿的是宿主注入的 `brain.complete({appId, text})`。
  背后的模型、额度、计费全由宿主决定，组件清单里因此 `permissions` 为空 ——
  它没有任何直接的文件/网络/数据库能力。

## 目录

| 文件 | 作用 |
|---|---|
| `contract.ts` | chord 契约：类型名 `tenon.official.ai-assistant`、`version: 1`、state（`status`/`messages`/`turns`）、两个方法 |
| `server.ts` | server facet：`activate({ host, appId, brain })`，`serve(..., { linger })` |
| `manifest.json` | 清单：名称、版本、能力声明、给 Agent 的说明（安装时进应用 `AGENTS.md`） |

`server.js` 是 `pnpm build:plugins` 的产物（esbuild 打包，连 chord 一起打进单文件），
不进 git —— 打包与运行时都先跑构建。

## 装机形态（M5 第 3 步 b 收口）

装配声明里挂到 `app.shell.overlay`（右下角悬浮球）。在 web facet 落地之前，
`slots` 是空的：这时候装上它不会有界面，`component.list` 会如实说明它能挂哪儿。
