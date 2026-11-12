/**
 * 拉起生成应用的 dev server（Vite）。
 *
 * 用 `spawn(process.execPath, [viteBin, ...])` 而不是 `pnpm dev`：
 * - 不依赖用户 PATH 里有 pnpm（Electron 从 Dock 启动时 PATH 很短）
 * - 只多一层 node 进程，信号传递直观，日志里没有 pnpm 的包装噪声
 *
 * 端口一律由调用方指定 + `--strictPort`：被占了就直接失败，
 * 绝不能"悄悄换一个" —— 那样网关会指到空气上，表现为 iframe 白屏且没有报错。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scrubEnv } from '@tenon/core'
import { msg, TenonError } from '@tenon/protocol'
import { nodeRunEnv, spawnLogged, type Launched } from './child.js'

export type { ExitInfo, Launched } from './child.js'

export interface LaunchSpec {
  repoDir: string
  vitePort: number
  gatewayPort: number
  /** 后端端口。没有后端就传 undefined —— 模板不会配 /api 代理 */
  apiPort?: number
  env?: NodeJS.ProcessEnv
  /** 每行输出回调（错误面板用）。注入的假 launcher 可以直接忽略 */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

export type Launcher = (spec: LaunchSpec) => Promise<Launched>

function viteBinOf(repoDir: string): string {
  const bin = join(repoDir, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(bin)) {
    throw new TenonError('PREVIEW_DEPS_FAILED', msg('error.deps.viteMissing'), { bin })
  }
  return bin
}

export const launchVite: Launcher = async (spec) => {
  const bin = viteBinOf(spec.repoDir)
  const env: NodeJS.ProcessEnv = nodeRunEnv({
    ...scrubEnv(spec.env ?? process.env),
    TENON_VITE_PORT: String(spec.vitePort),
    TENON_GATEWAY_PORT: String(spec.gatewayPort),
    TENON_API_PORT: String(spec.apiPort ?? 0),
    NODE_ENV: 'development',
    // 关掉颜色：日志要原样进错误提示，ANSI 码会让它变成一团乱码
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  })

  return spawnLogged({
    command: process.execPath,
    args: [bin, '--port', String(spec.vitePort), '--strictPort', '--host', '127.0.0.1'],
    cwd: spec.repoDir,
    env,
    ...(spec.onLine === undefined ? {} : { onLine: spec.onLine }),
  })
}
