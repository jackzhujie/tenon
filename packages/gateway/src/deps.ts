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
import { fileURLToPath } from 'node:url'
import { TenonError } from '@tenon/protocol'
import { nodeRunEnv } from './child.js'

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

/**
 * 找到一个能用的包管理器。
 *
 * 顺序是"越确定越靠前"：
 * 1. `TENON_PNPM` —— 用户/测试显式指定，最高优先级
 * 2. **随包自带的 pnpm**（桌面版 `Resources/server/node_modules/pnpm/bin/pnpm.cjs`）——
 *    这是"双击装完却起不来预览"的根治办法：用户机器上不该假设有 pnpm，
 *    从 Dock 启动的 GUI 进程 PATH 还很短
 * 3. 和 node 同目录的 pnpm —— nvm / 官方安装器常见布局
 * 4. `PATH` 里的 `pnpm` —— 最后兜底
 */
interface PackageManager {
  command: string
  /** 是 JS 入口就得用 node 跑（`.bin/pnpm` 那种 shell 包装不能直接 spawn） */
  isScript: boolean
}

function resolvePnpm(env: NodeJS.ProcessEnv): PackageManager {
  const explicit = env['TENON_PNPM']
  if (explicit !== undefined && explicit !== '') {
    return { command: explicit, isScript: /\.(?:c|m)?js$/.test(explicit) }
  }
  // `import.meta.url` 在打包后是 `<Resources>/server/server.mjs`，正好指向随包目录；
  // 开发态是 `packages/gateway/src/deps.ts`，那个路径不存在 → 自动落到下一档
  const bundled = fileURLToPath(new URL('./node_modules/pnpm/bin/pnpm.cjs', import.meta.url))
  if (existsSync(bundled)) return { command: bundled, isScript: true }

  // nvm / 官方安装器里 pnpm 通常和 node 同目录；GUI 启动时 PATH 常常没有它
  const sibling = join(dirname(process.execPath), 'pnpm')
  if (existsSync(sibling)) return { command: sibling, isScript: false }
  return { command: 'pnpm', isScript: false }
}

function tail(lines: string[]): string {
  return lines.slice(-LOG_TAIL).join('\n')
}

export async function ensureDeps(options: EnsureDepsOptions): Promise<DepsResult> {
  const env = options.env ?? process.env
  const started = Date.now()
  const pnpm = resolvePnpm(env)

  if (existsSync(join(options.repoDir, READY_MARKER))) {
    return { installed: false, command: `${pnpm.command} install (跳过)`, durationMs: 0 }
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
    // 随包的 pnpm 是 `.cjs`：必须用 node 跑，而且打包态下还要 ELECTRON_RUN_AS_NODE
    const command = pnpm.isScript ? process.execPath : pnpm.command
    const commandArgs = pnpm.isScript ? [pnpm.command, ...args] : args
    const child = spawn(command, commandArgs, {
      cwd: options.repoDir,
      env: pnpm.isScript ? nodeRunEnv(env) : env,
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
      `起不来依赖安装程序（${pnpm.command}）：${lines.at(-1) ?? '未知原因'}`,
      { repoDir: options.repoDir, pnpm: pnpm.command, output: tail(lines) },
    )
  }
  if (code !== 0) {
    throw new TenonError(
      'PREVIEW_DEPS_FAILED',
      `依赖安装失败（${pnpm.command} install 退出码 ${code ?? 'null'}）`,
      { repoDir: options.repoDir, output: tail(lines) },
    )
  }

  return { installed: true, command: `${pnpm.command} ${args.join(' ')}`, durationMs }
}
