#!/usr/bin/env node
/**
 * CLI 入口（`pnpm dev:server` / Electron 子进程 / Web 模式）。
 *
 * 约定：监听成功后**第一行**输出 `TENON_READY {json}`，供 Electron supervisor
 * 与开发脚本解析端口和 Token（不要靠猜端口或扫端口）。
 */
import { startServer } from './index.js'

function flag(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

async function main(): Promise<void> {
  const portRaw = flag('TENON_PORT')
  const port = portRaw === undefined ? 0 : Number(portRaw)
  if (Number.isNaN(port)) throw new Error(`TENON_PORT 不是数字：${portRaw}`)

  const running = await startServer({
    port,
    ...(flag('TENON_HOST') === undefined ? {} : { host: flag('TENON_HOST') }),
    ...(flag('TENON_TOKEN') === undefined ? {} : { token: flag('TENON_TOKEN') }),
    logger: flag('TENON_LOG') !== undefined,
  })

  const model = running.agent.plan
  process.stdout.write(
    `TENON_READY ${JSON.stringify({
      url: running.url,
      port: running.port,
      token: running.token,
      home: running.core.home.root,
      model: model === undefined ? null : { mode: model.mode, modelId: model.choice.modelId },
    })}\n`,
  )

  if (model === undefined) {
    process.stderr.write(
      '[tenon] 还没有可用模型：设置 TENON_FAUX=1 用假模型调试，或在设置里配置提供商。\n',
    )
  } else if (model.mode === 'faux') {
    process.stderr.write('[tenon] 模型为 faux（开发模式），回复内容是假的，仅用于验证链路。\n')
  }

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[tenon] 收到 ${signal}，正在关闭…\n`)
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  process.stderr.write(`[tenon] 启动失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
