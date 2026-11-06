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
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TenonError } from '@tenon/protocol'
import { invokePnpm, resolvePnpm } from '@tenon/core'
import { nodeRunEnv } from './child.js'

export interface EnsureDepsOptions {
  repoDir: string
  env?: NodeJS.ProcessEnv
  /** 默认 5 分钟。首次装 React + Vite 通常 10~30s，网络差会久很多 */
  timeoutMs?: number
  onLog?: (line: string) => void
  /**
   * 取消信号（v1.2.24 加）。**应用被删掉时必须能掐掉正在跑的安装** ——
   * 它是以 `repo/` 为 CWD 的子进程，Windows 上那个目录就删不掉（EBUSY），
   * 而且安装还会继续往一个正在被删的目录里写东西。
   */
  signal?: AbortSignal
}

export interface DepsResult {
  /** true = 这次真的跑了 install */
  installed: boolean
  command: string
  durationMs: number
}

const READY_MARKER = join('node_modules', 'vite', 'package.json')
const LOG_TAIL = 20

// 「哪个 pnpm 能用」由一个实现回答：`@tenon/core` 的 `resolvePnpm`。
// 发布前跑 test 脚本（`packages/agent/src/checks.ts`）用的是同一份 —— 两份实现早晚会
// 漂移成两套规则，而这类漂移的表现是"预览装得动依赖、发布却跑不了测试"。

/**
 * 杀掉整棵进程树。
 *
 * POSIX 上先试负 pid（`detached` 时是进程组），Windows 上只能靠 `taskkill /T`：
 * 那边 `kill()` 只杀直接子进程，而我们是 `cmd.exe → pnpm → 子进程` 三层。
 * 失败都吞掉 —— 已经退出、没有权限都不是错误，尽力而为。
 */
function killTree(child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (child.pid !== undefined && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已经没了 */
  }
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

  let cancelled = false
  const code = await new Promise<number | null>((resolve) => {
    // 随包的 pnpm 是 `.cjs`（要用 node 跑，打包态还要 ELECTRON_RUN_AS_NODE）；
    // Windows 上 pnpm 是 `.cmd`，必须走 shell —— 判断在 `invokePnpm` 里
    const call = invokePnpm(pnpm, args)
    const child = spawn(call.command, call.args, {
      cwd: options.repoDir,
      env: pnpm.isScript ? nodeRunEnv(env) : env,
      shell: call.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      lines.push(`[tenon] 安装超时（${Math.round(timeoutMs / 1000)}s），已终止`)
      killTree(child)
    }, timeoutMs)

    /*
     * 取消：应用被删了就别再装了。
     *
     * 必须**杀整棵树**（Windows 上尤其）：走了 shell 之后直接子进程是 `cmd.exe`，
     * `child.kill()` 只杀它，pnpm 作为孙进程会继续跑并继续占着 `repo/`。
     */
    const onAbort = (): void => {
      cancelled = true
      lines.push('[tenon] 应用已被删除，安装已取消')
      killTree(child)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

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
  /*
   * 被取消时**不抛**：调用方（`preview.cancelDeps`）正等着它安静地结束。
   * 抛出去会变成一条"依赖安装失败"的报错，而用户做的是删除 —— 那不是失败。
   */
  if (cancelled || options.signal?.aborted === true) {
    return { installed: false, command: `${pnpm.command} install (已取消)`, durationMs }
  }
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
