import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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

export default defineConfig({
  plugins: [react()],
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
})
