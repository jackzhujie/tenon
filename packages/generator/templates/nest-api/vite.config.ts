import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tenonLoc from './src/tenon-loc-plugin'

/**
 * Tenon 拉起预览时会注入这几个环境变量：
 * - TENON_VITE_PORT      dev server 自己的端口（Tenon 先占好，strictPort 保证不会悄悄换）
 * - TENON_GATEWAY_PORT   网关端口。**HMR 的 WebSocket 必须连这个**（iframe 的源是网关）
 * - TENON_API_PORT       后端端口。直接访问 vite 端口时靠它代理 /api；
 *                        走网关时由网关按路径分流，两条路都能用
 */
const vitePort = Number(process.env['TENON_VITE_PORT'] ?? 5173)
const gatewayPort = Number(process.env['TENON_GATEWAY_PORT'] ?? 0)
const apiPort = Number(process.env['TENON_API_PORT'] ?? 0)

/**
 * 编译期源码定位（DESIGN §10.1）：给 JSX 标上 `data-tenon-loc` / `data-tenon-callsite`，
 * 精调面板才能从「用户点中的那个元素」回到「源码第几行」。
 *
 * 两个注意点：
 * - **只在 dev 生效**：生产产物不需要这些属性，也不该把源码路径带出去
 * - `as unknown as never[]`：babel 的 `plugins` 类型来自 `@babel/core`，而模板刻意不装它
 *   （`@vitejs/plugin-react` 自带 Babel，运行时接受 `[[plugin, options]]` 元组）
 */
const locPlugins = [[tenonLoc, { appRoot: import.meta.dirname }]] as unknown as never[]

export default defineConfig(({ command }) => ({
  plugins: [command === 'serve' ? react({ babel: { plugins: locPlugins } }) : react()],
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
    ...(gatewayPort > 0
      ? { hmr: { host: '127.0.0.1', protocol: 'ws' as const, clientPort: gatewayPort } }
      : {}),
    ...(apiPort > 0
      ? { proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } }
      : {}),
  },
}))
