# {{appName}}

由 [Tenon](https://github.com/) 生成的应用工作区。所有代码都在 `repo/` 里，
`.tenon/`、`pgdata/`、`exports/` 在 Git 之外（见 `.gitignore`）。

## 单独跑起来

```bash
pnpm install
pnpm dev          # http://127.0.0.1:5173
```

在 Tenon 里跑预览时不要用这条命令 —— Tenon 会把 dev server 挂在它自己的
App Gateway 后面（端口由它指定，`TENON_VITE_PORT` / `TENON_GATEWAY_PORT` 注入），
这样 iframe 的地址在重启后不变，HMR 也能穿过网关。

## 结构

```
index.html        入口 HTML
vite.config.ts    构建配置（端口与 HMR 由 Tenon 注入的环境变量决定）
src/main.tsx      挂载点
src/App.tsx       页面主体
src/styles.css    样式
```

## 约定

- 组合组件（放在 `src/components/` 里的自己写的组件）**必须把 props 透传给根元素**：
  `function Card({ children, ...props }) { return <div {...props}>{children}</div> }`。
  Tenon 的定位机制靠这条把「你在哪里用了它」记到 DOM 上。
- 没有引入 UI 框架，样式用普通 CSS + CSS 变量。要加依赖就在 `package.json` 里加，
  然后让 Tenon 重启预览（它会重跑 `pnpm install`）。
