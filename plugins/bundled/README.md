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

## 三个内置组件（M5 收口时）

| id | 一句话 | 挂载点 | 需要模型？ |
|---|---|---|---|
| `tenon.official.ai-assistant` | 悬浮球 + 对话（宿主注入模型能力，组件自己没有工具） | `app.shell.overlay` | 是 |
| `tenon.official.csv-export` | 抓页面上的 `<table>` 导成 CSV（Excel 直接打开） | `app.page.header` | 否 |
| `tenon.official.approval` | 提交 → 通过/驳回（数据存在组件自己的键值空间，**活过重启**） | `app.shell.overlay` | 否 |

三份契约形状完全一样（`remote()` + `variants.user.state/methods` + `export function activate({host, appId, brain, log})`），
第二个和第三个基本是照抄第一个 —— 这就是"组件规范能不能低成本复制"的证据。

## L1 内置积木（清单，M6 才实现）

L1 不是插件：它们随模板生成进应用源码，Agent 直接调用、用户可改。

表格（排序/筛选/分页）· 表单（校验/草稿）· 图表（折线/柱/饼）· 登录（邮箱+密码、会话）·
文件上传（本地/对象存储）· 权限（角色 + 路由守卫）· 空状态 / 骨架屏 / 错误边界

边界很清楚：**L1 是"应用自己的代码"**（用户能改、跟着 git 走）；**L2 是"平台注入的组件"**
（用户看不见源码、只能开关）。同一个功能放在哪一层，取决于"用户要不要改它"。
