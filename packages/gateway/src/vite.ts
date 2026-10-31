/**
 * 拉起生成应用的 dev server。
 *
 * 用 `spawn(process.execPath, [viteBin, ...])` 而不是 `pnpm dev`：
 * - 不依赖用户 PATH 里有 pnpm（Electron 从 Dock 启动时 PATH 很短）
 * - 只多一层 node 进程，信号传递直观，日志里没有 pnpm 的包装噪声
 *
 * 端口一律由调用方指定 + `--strictPort`：被占了就直接失败，
 * 绝不能"悄悄换一个" —— 那样网关会指到空气上，表现为 iframe 白屏且没有报错。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scrubEnv } from '@tenon/core'
import { TenonError } from '@tenon/protocol'

export interface LaunchSpec {
  repoDir: string
  vitePort: number
  gatewayPort: number
  /** 后端端口（M2）。没有就传 0/undefined，模板不会配 /api 代理 */
  apiPort?: number
  env?: NodeJS.ProcessEnv
}

export interface ExitInfo {
  code: number | null
  signal: string | null
}

export interface Launched {
  readonly pid: number | undefined
  /** 最近的输出（排障用：起不来时把最后几行原样贴给用户） */
  output(): string
  onExit(cb: (info: ExitInfo) => void): void
  stop(): Promise<void>
}

export type Launcher = (spec: LaunchSpec) => Promise<Launched>

const MAX_LOG_LINES = 200

function viteBinOf(repoDir: string): string {
  const bin = join(repoDir, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(bin)) {
    throw new TenonError('PREVIEW_DEPS_FAILED', '找不到 vite：依赖没装完或装失败了', { bin })
  }
  return bin
}

export const launchVite: Launcher = async (spec) => {
  const bin = viteBinOf(spec.repoDir)
  const lines: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(spec.env ?? process.env),
    TENON_VITE_PORT: String(spec.vitePort),
    TENON_GATEWAY_PORT: String(spec.gatewayPort),
    TENON_API_PORT: String(spec.apiPort ?? 0),
    NODE_ENV: 'development',
    // 关掉颜色：日志要原样进错误提示，ANSI 码会让它变成一团乱码
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [bin, '--port', String(spec.vitePort), '--strictPort', '--host', '127.0.0.1'],
    { cwd: spec.repoDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue
      lines.push(line)
      if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
    }
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const exitHandlers: Array<(info: ExitInfo) => void> = []
  const exited = new Promise<ExitInfo>((resolve) => {
    child.on('close', (code, signal) => {
      const info: ExitInfo = { code, signal }
      for (const handler of exitHandlers) handler(info)
      resolve(info)
    })
  })

  return {
    pid: child.pid,
    output: () => lines.slice(-40).join('\n'),
    onExit(cb) {
      exitHandlers.push(cb)
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
      const result = await Promise.race([exited.then(() => 'exited' as const), timeout])
      if (result === 'timeout') child.kill('SIGKILL')
    },
  }
}
