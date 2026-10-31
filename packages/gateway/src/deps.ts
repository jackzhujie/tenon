/**
 * 依赖安装（DESIGN §9.2 的 `readiness.deps`）。
 *
 * 只在「确实缺东西」时装：判定条件是 `node_modules/vite/package.json` 存在 ——
 * 判 `node_modules` 目录存在不够（装到一半中断会留下空目录，然后永远起不来）。
 *
 * 网络差的时候这一步是全场最慢的（十几秒到几分钟）。所以：
 * - 用 `--prefer-offline`，命中本地 store 时几乎不碰网络
 * - 全程有超时，失败带最后 20 行输出 —— 只报「安装失败」对用户没有任何帮助
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TenonError } from '@tenon/protocol'

export interface EnsureDepsOptions {
  repoDir: string
  env?: NodeJS.ProcessEnv
  /** 默认 5 分钟。首次装 React + Vite 通常 10~30s，网络差会久很多 */
  timeoutMs?: number
  onLog?: (line: string) => void
}

export interface DepsResult {
  /** true = 这次真的跑了 install */
  installed: boolean
  command: string
  durationMs: number
}

const READY_MARKER = join('node_modules', 'vite', 'package.json')
const LOG_TAIL = 20

function resolvePnpm(env: NodeJS.ProcessEnv): string {
  const explicit = env['TENON_PNPM']
  if (explicit !== undefined && explicit !== '') return explicit
  // nvm / 官方安装器里 pnpm 通常和 node 同目录；GUI 启动时 PATH 常常没有它
  const sibling = join(dirname(process.execPath), 'pnpm')
  if (existsSync(sibling)) return sibling
  return 'pnpm'
}

function tail(lines: string[]): string {
  return lines.slice(-LOG_TAIL).join('\n')
}

export async function ensureDeps(options: EnsureDepsOptions): Promise<DepsResult> {
  const env = options.env ?? process.env
  const started = Date.now()
  const pnpm = resolvePnpm(env)

  if (existsSync(join(options.repoDir, READY_MARKER))) {
    return { installed: false, command: `${pnpm} install (跳过)`, durationMs: 0 }
  }
  if (!existsSync(join(options.repoDir, 'package.json'))) {
    throw new TenonError('PREVIEW_DEPS_FAILED', '这个工作区没有 package.json，没法装依赖', {
      repoDir: options.repoDir,
    })
  }

  const args = ['install', '--prefer-offline', '--reporter=append-only']
  const lines: string[] = []
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(pnpm, args, {
      cwd: options.repoDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      lines.push(`[tenon] 安装超时（${Math.round(timeoutMs / 1000)}s），已终止`)
      child.kill('SIGKILL')
    }, timeoutMs)

    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue
        lines.push(line)
        options.onLog?.(line)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => {
      clearTimeout(timer)
      lines.push(`[tenon] 起不来：${err.message}`)
      resolve(null)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })

  const durationMs = Date.now() - started
  if (code === null) {
    // 进程压根没起来（找不到 pnpm / 没有执行权限）。这种情况必须把原因写在 message 里：
    // 只说"退出码 null"等于什么都没说。
    throw new TenonError(
      'PREVIEW_DEPS_FAILED',
      `起不来依赖安装程序（${pnpm}）：${lines.at(-1) ?? '未知原因'}`,
      { repoDir: options.repoDir, pnpm, output: tail(lines) },
    )
  }
  if (code !== 0) {
    throw new TenonError(
      'PREVIEW_DEPS_FAILED',
      `依赖安装失败（${pnpm} install 退出码 ${code ?? 'null'}）`,
      { repoDir: options.repoDir, output: tail(lines) },
    )
  }

  return { installed: true, command: `${pnpm} ${args.join(' ')}`, durationMs }
}
