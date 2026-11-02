# 官方内置组件（bundled）

一个子目录 = 一个组件。目录名就是组件 id（反向域名），必须与 `manifest.json` 里的 `id` 一致 ——
加载器用目录名认领组件，对不上会直接判 `id-mismatch`，宁可装不上也不装上错的。

```
plugins/bundled/
└── tenon.official.ai-assistant/
    ├── manifest.json     ← 必需。字段见 packages/component-host/src/manifest.ts
    ├── contract.ts       ← chord 契约（唯一对外的事实）
    ├── server.js         ← 宿主 facet：后端能力（清单 facets.server 指过来）
    ├── web.js            ← 宿主 facet：前端 UI（清单 facets.web 指过来）
    └── README.md         ← 给 Agent 读的用法，安装时进应用的 AGENTS.md
```

`manifest.json` 里三件最容易忘的事：

- `agentHints` **必填**：不写，Agent 就会绕过组件自己糊一个聊天框。
- `source` 必须与所在根一致（这里恒为 `bundled`）；Hub 目录里写 `bundled` 等于绕过签名校验，会被拦。
- `slots` 只写组件真能挂的插槽；`facets` 里没有的那一侧，挂上去会得到 `facet-missing`。

打包时这个目录整体进 `dist/plugins` → `<Resources>/plugins`（`TENON_PLUGINS_DIR` 指过去）。
M5 第 3 步放第一个组件（AI 小助手）；在那之前这里是空的，加载器返回空列表而不是报错。
