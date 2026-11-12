import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * 后端入口。
 *
 * 三条约定（Tenon 的预览编排依赖它们）：
 * 1. **监听 `PORT`**：端口由平台先占好再传进来（`strictPort` 同理），不要自己挑
 * 2. **健康检查固定是 `GET /api/health`**：网关按 `/api/*` 分流，就绪判定也打这条
 * 3. **全局前缀 `api`**：前端永远用相对路径 `/api/xxx`，这样走网关、走 vite 代理、
 *    将来走同域反向代理都是同一个地址，应用代码不需要知道自己在哪
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')
  app.enableShutdownHooks()

  const port = Number(process.env['PORT'] ?? 3001)
  await app.listen(port, '127.0.0.1')
  // 这一行会被 Tenon 收进日志尾（起不来时原样贴给用户看）
  console.log(`[api] listening on http://127.0.0.1:${port}/api/health`)
}

bootstrap().catch((err: unknown) => {
  console.error('[api] failed to start:', err)
  process.exit(1)
})
