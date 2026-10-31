/**
 * Vite 配置（Tenon 渲染器）。
 *
 * 两个刻意的选择：
 *
 * 1. **`strictPort: true`** —— 端口被占就报错，不许 Vite 自己换一个。
 *    换了之后 `dev-web` 脚本打印的地址就是错的，打开是个白屏，而且没有任何报错。
 *    （和预览网关那条约束同一个理由，见 DESIGN §9.1）
 *
 * 2. **server 的地址与 Token 走编译期常量注入**，不走 Vite proxy。
 *    原因：SSE 经过 http-proxy 会多一层缓冲与断连语义，而它恰恰是这条链路里最容易出问题的地方。
 *    直连 server 需要一个 CORS 头 —— server 侧只为**回环 origin** 放行（`packages/server/src/cors.ts`）。
 *    生产形态注入的是空串：页面由 server 同源托管，或由 Electron preload 提供 `window.__TENON__`。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const serverUrl = process.env['TENON_SERVER_URL'] ?? ''
const serverToken = process.env['TENON_SERVER_TOKEN'] ?? ''
const port = Number(process.env['TENON_WEB_PORT'] ?? 5173)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __TENON_BASE__: JSON.stringify(serverUrl),
    __TENON_TOKEN__: JSON.stringify(serverToken),
  },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
