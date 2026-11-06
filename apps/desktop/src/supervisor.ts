/**
 * server 子进程的监护者（supervisor）。
 *
 * 这是 Electron 壳里唯一"有逻辑"的地方，也是最容易写成"只在开发机上能跑"的地方：
 *
 * - **只认 `TENON_READY` 那一行**。端口是 0（系统分配）、Token 每次随机，
 *   拼不出来也猜不出来；扫端口或自己造一个 Token 都会在打包后翻车。
 * - **必须用 `ELECTRON_RUN_AS_NODE` 跑**。`process.execPath` 在打包后是 Tenon 自己的
 *   可执行文件（不是 node）；带上这个环境变量它才当 node 用 —— 于是我们既不要求用户
 *   装 node，也不用把 node 二进制再塞一份进安装包。
 * - **崩溃要能自愈**。本地优先的产品不允许"服务挂了、窗口还在转圈"：
 *   没就绪就退出 → 报错；就绪之后退出 → 退避重启，并把**新的**地址交回窗口。
 *
 * 这个文件刻意不 import `electron`：`apps/desktop/test/supervisor.test.ts` 用 node 直接测它。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface ServerReady {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly home: string
  readonly model: { readonly mode: string; readonly modelId: string } | null
}

export interface SupervisorOptions {
  /** `dist/server/server.mjs` 的绝对路径 */
  readonly entry: string
  /** 完整环境（调用方负责合并；别把一个"覆盖对象"当子进程环境用） */
  readonly env: NodeJS.ProcessEnv
  /** 默认 `process.execPath`：生产里是 Electron 可执行文件，测试里是 node */
  readonly execPath?: string
  /** 子进程参数，默认 `[entry]` */
  readonly args?: readonly string[]
  /** 等 `TENON_READY` 的上限。冷启动要开 sqlite、装 harness，别给太紧 */
  readonly readyTimeoutMs?: number
  /** 就绪后允许重启几次；超过就放弃（反复崩说明是代码问题，重启只是刷日志） */
  readonly maxRestarts?: number
  readonly restartDelayMs?: number
  /**
   * 就绪回调。**首次启动与每次重启都会调**，且 url/token 每次都不同 ——
   * 窗口必须跟着它走，不能记住第一次的地址。
   */
  readonly onReady?: (ready: ServerReady) => void
  /** 子进程的 stdout/stderr 行 */
  readonly onLog?: (line: string) => void
  /** 就绪后彻底放弃 */
  readonly onGaveUp?: (error: Error) => void
}

export interface ServerSupervisor {
  /** 首次就绪；没就绪就退出 / 超时时 reject */
  readonly ready: Promise<ServerReady>
  /** 已经发生的重启次数 */
  readonly restarts: number
  stop(): Promise<void>
}

const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESTARTS = 3
const DEFAULT_RESTART_DELAY_MS = 500
/** 关不完就强杀：宁可丢最后几行日志，也不能留一个占着端口的孤儿进程 */
const KILL_GRACE_MS = 4_000

/** `TENON_READY {json}` —— 与 `packages/server/src/bin.ts` 的约定 */
export function parseReady(line: string): ServerReady | null {
  if (!line.startsWith('TENON_READY ')) return null
  let value: unknown
  try {
    value = JSON.parse(line.slice('TENON_READY '.length).trim())
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const { url, port, token, home, model } = record
  if (typeof url !== 'string' || typeof port !== 'number' || typeof token !== 'string') return null
  const parsedModel =
    typeof model === 'object' && model !== null
      ? {
          mode: String((model as Record<string, unknown>)['mode'] ?? ''),
          modelId: String((model as Record<string, unknown>)['modelId'] ?? ''),
        }
      : null
  return { url, port, token, home: typeof home === 'string' ? home : '', model: parsedModel }
}

export function startSupervisor(options: SupervisorOptions): ServerSupervisor {
  const execPath = options.execPath ?? process.execPath
  const args = options.args ?? [options.entry]
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS
  const log = options.onLog ?? ((): void => {})

  let child: ChildProcess | null = null
  let stopping = false
  /** 就绪过一次之后崩溃才重启：从没就绪就退出，重启只会把同一段报错刷三遍 */
  let booted = false
  let restarts = 0
  let stderrTail: string[] = []

  let firstSettled = false
  let resolveFirst: (ready: ServerReady) => void = () => {}
  let rejectFirst: (error: Error) => void = () => {}
  const ready = new Promise<ServerReady>((resolve, reject) => {
    resolveFirst = resolve
    rejectFirst = reject
  })
  // 窗口可能已经关了：没人接住这个 rejection 会变成 uncaught，把主进程带走
  ready.catch(() => {})

  /** 当前这次 spawn 的就绪等待；null 表示这次 spawn 已经结束（就绪或失败） */
  let pending: { timer: NodeJS.Timeout } | null = null

  const clearPending = (): void => {
    if (pending !== null) clearTimeout(pending.timer)
    pending = null
  }

  const failPending = (error: Error): void => {
    const wasPending = pending !== null
    clearPending()
    if (!wasPending) return
    if (!firstSettled) {
      firstSettled = true
      rejectFirst(error)
    }
  }

  const spawnOnce = (): void => {
    stderrTail = []
    const tail = (): string => (stderrTail.length === 0 ? '' : `\n${stderrTail.join('\n')}`)

    const started = spawn(execPath, [...args], {
      // `TENON_STDIN_SHUTDOWN` 让 server 监听 stdin 的 EOF —— Windows 上那是唯一
      // 能"优雅关停"的通道（那边没有可捕获的 SIGTERM）
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1', TENON_STDIN_SHUTDOWN: '1' },
      // stdin 必须是管道：stop() 靠"关掉它"通知对方收尾
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = started

    const timer = setTimeout(() => {
      failPending(new Error(`${Math.round(readyTimeoutMs / 1000)} 秒内没等到 TENON_READY${tail()}`))
      // 已经判失败了就别再重启：启动不起来是代码/环境问题
      stopping = true
      started.kill('SIGKILL')
    }, readyTimeoutMs)
    timer.unref?.()
    pending = { timer }

    const onLine = (line: string): void => {
      if (line.trim() !== '') log(line)
      const parsed = parseReady(line)
      if (parsed === null) return
      if (pending === null) return // 重复的 READY：忽略
      clearPending()
      booted = true
      if (!firstSettled) {
        firstSettled = true
        resolveFirst(parsed)
      }
      options.onReady?.(parsed)
    }

    let buffer = ''
    started.stdout?.setEncoding('utf8')
    started.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        onLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })

    started.stderr?.setEncoding('utf8')
    started.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue
        log(line)
        stderrTail.push(line)
        if (stderrTail.length > 20) stderrTail.shift()
      }
    })

    started.on('error', (error) => {
      failPending(new Error(`无法启动 server：${error.message}`))
    })

    started.on('exit', (code, signal) => {
      child = null
      const wasWaiting = pending !== null

      if (stopping) {
        clearPending()
        return
      }

      if (wasWaiting) {
        clearPending()
        if (!firstSettled) {
          // 首次启动就失败：重启只会把同一段报错再刷两遍，直接交给调用方
          firstSettled = true
          rejectFirst(
            new Error(`server 在就绪前退出（code=${String(code)} signal=${String(signal)}）${tail()}`),
          )
          return
        }
        // 已经就绪过 → 这是"重启之后又挂了"，按崩溃继续处理
      }

      if (!booted) return
      if (restarts >= maxRestarts) {
        options.onGaveUp?.(new Error(`server 连续 ${restarts + 1} 次异常退出，已放弃重启${tail()}`))
        return
      }
      restarts += 1
      const delay = restartDelayMs * 2 ** (restarts - 1)
      log(`[tenon] server 退出（code=${String(code)}），${String(delay)}ms 后重启（第 ${restarts} 次）`)
      setTimeout(() => {
        if (!stopping) spawnOnce()
      }, delay).unref?.()
    })
  }

  spawnOnce()

  return {
    ready,
    get restarts() {
      return restarts
    },
    async stop() {
      stopping = true
      const target = child
      if (target === null) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          target.kill('SIGKILL')
          resolve()
        }, KILL_GRACE_MS)
        timer.unref?.()
        target.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        /*
         * 先关 stdin（三个平台都有效的"请收尾"），POSIX 上再补一个 SIGTERM。
         *
         * 顺序不能反：Windows 上 `kill('SIGTERM')` 是 `TerminateProcess`，
         * 先 kill 就没有"收尾"可言了 —— server 里的 sqlite / PGlite / git 锁
         * 一个都来不及放。`shutdown()` 自己是幂等的，两边都到也无害。
         */
        target.stdin?.end()
        if (process.platform !== 'win32') target.kill('SIGTERM')
      })
    },
  }
}
