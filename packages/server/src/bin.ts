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
  if (Number.isNaN(port)) throw new Error(`TENON_PORT is not a number: ${portRaw}`)

  const running = await startServer({
    port,
    ...(flag('TENON_HOST') === undefined ? {} : { host: flag('TENON_HOST') }),
    ...(flag('TENON_TOKEN') === undefined ? {} : { token: flag('TENON_TOKEN') }),
    ...(flag('TENON_WEB_DIR') === undefined ? {} : { webDir: flag('TENON_WEB_DIR') }),
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
      '[tenon] no model available: set TENON_FAUX=1 to debug with the faux model, or configure a provider in settings.\n',
    )
  } else if (model.mode === 'faux') {
    process.stderr.write('[tenon] using the faux model (dev mode): replies are fake, only for exercising the pipeline.\n')
  }

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[tenon] received ${signal}, shutting down…\n`)
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  /*
   * **stdin 关掉**也是一条关停通道，只在被 supervisor 拉起时开启（`TENON_STDIN_SHUTDOWN=1`）。
   *
   * 为什么要多这一条：**Windows 上没有可捕获的 SIGTERM**。那边 `kill('SIGTERM')` 实际是
   * `TerminateProcess` —— 进程当场消失，上面的 handler 一行都不会跑。于是关掉桌面窗口时，
   * sqlite / PGlite / git 锁都来不及收尾。关掉 stdin 在三个平台上是同一件事，
   * 而且是**优雅**的：拿到 EOF 之后 `running.close()` 跑完再 `exit(0)`。
   *
   * 为什么用环境变量把它关起来：手工 `pnpm dev:web`、CI 里 `< /dev/null` 跑起来的 server，
   * stdin 一开始就是 EOF —— 无条件监听会让它启动即退出。只有明确知道"stdin 那头是
   * supervisor"时才启用。
   */
  if (process.env['TENON_STDIN_SHUTDOWN'] === '1') {
    process.stdin.on('end', () => void shutdown('stdin closed'))
    // 管道异常（对端被杀）也当关停：总比挂在那里当孤儿好
    process.stdin.on('error', () => void shutdown('stdin disconnected'))
    process.stdin.resume()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[tenon] failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
