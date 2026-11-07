/**
 * 生成应用的子进程壳（Vite 与 Nest 共用）。
 *
 * 抽出来的直接原因：两个 launcher 的日志收集、退出回调、`SIGTERM → 4s → SIGKILL`
 * 三段逻辑要一模一样。复制一份的代价不是多 40 行，而是"某一侧忘了 kill 子进程"
 * 这种只在反复重启后才暴露的问题。
 *
 * 约定：**只收最后 40 行输出**。起不来的时候这几十行比任何猜测都有用
 * （端口占用、语法错、依赖版本不对都能一眼看出来），但全量日志会把错误响应撑爆。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { withNodeShim } from '@tenon/core'

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

export interface SpawnOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** 日志里标是谁的输出（`vite` / `api`），两个进程的日志混在一起时很有用 */
  label?: string
  /**
   * 每读到一行就回调一次（`stream` 用来判断级别）。
   *
   * 与 `output()` 并存而不是替代：`output()` 是**失败时的现场**（最后 40 行，随错误返回），
   * 这个回调是**活着的时候的流水**。两者用途不同，都得留。
   */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

const MAX_LOG_LINES = 200
const KILL_GRACE_MS = 4000

/**
 * 子进程的环境：打包态下必须显式要 `ELECTRON_RUN_AS_NODE=1`。
 *
 * 原因：桌面版里 `process.execPath` 是 **Tenon 自己**（Electron 可执行文件），不是 node。
 * 用它 spawn 一个 `.js` 时，没有这个变量就变成"又开了一个 Electron 应用、把 vite.js
 * 当成 app 路径"——不会报错，只会静默起来一个空窗口，而 dev server 永远不就绪。
 * 反过来 `scrubEnv` 会剥掉这个变量（防止把它泄给生成应用），所以这里必须补回来。
 *
 * 开发态（node 直接跑）没有 `process.versions.electron`，原样返回。
 */
export function nodeRunEnv(
  env: NodeJS.ProcessEnv,
  electronVersion: string | undefined = process.versions.electron,
): NodeJS.ProcessEnv {
  const withElectron = electronVersion === undefined ? env : { ...env, ELECTRON_RUN_AS_NODE: '1' }
  // 打包版没有 node：vite / nest / tsc 这些 `.bin` 脚本全靠这个薄壳（见 core/node-shim.ts）
  return withNodeShim(withElectron)
}

/**
 * 把多个子进程当成一个「逻辑进程」。
 *
 * 为什么需要：后端的 dev 循环天然是两段（`tsc --watch` 编译 + `node --watch` 跑产物），
 * 而预览编排只应该看到"后端起来了吗 / 后端挂了吗"。合成一个之后，
 * 上层不用关心编译器是不是独立进程，`stop()` 也不会漏掉其中一半。
 *
 * 语义：**任何一个 part 退出 = 整组退出**。编译器因为配置错而退出时必须报失败，
 * 否则会出现"进程都在、就是没有服务"的死等。
 */
export function groupLaunched(parts: Launched[]): Launched {
  const exitHandlers: Array<(info: ExitInfo) => void> = []
  let fired = false
  for (const part of parts) {
    part.onExit((info) => {
      if (fired) return
      fired = true
      for (const handler of exitHandlers) handler(info)
    })
  }
  return {
    pid: parts[0]?.pid,
    output: () =>
      parts
        .map((part) => part.output())
        .filter((text) => text !== '')
        .join('\n'),
    onExit(cb) {
      exitHandlers.push(cb)
    },
    async stop() {
      await Promise.all(parts.map((part) => part.stop().catch(() => undefined)))
    },
  }
}

export function spawnLogged(options: SpawnOptions): Launched {
  const lines: string[] = []
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefix = options.label === undefined ? '' : `[${options.label}] `
  const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
      if (raw.trim() === '') continue
      lines.push(`${prefix}${raw}`)
      if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
      options.onLine?.(raw, stream)
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
  child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))

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
      // Nest（ts-node）收到 SIGTERM 会优雅关连接，可能要几秒；超时就硬杀
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), KILL_GRACE_MS),
      )
      const result = await Promise.race([exited.then(() => 'exited' as const), timeout])
      if (result === 'timeout') child.kill('SIGKILL')
    },
  }
}
