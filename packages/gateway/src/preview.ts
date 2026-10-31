/**
 * 预览编排：一个应用一套「网关 + dev server」，生命周期跟着应用走（DESIGN §9.2）。
 *
 * 三个必须守住的点：
 * 1. **`start()` 立刻返回**。首次 `pnpm install` 可能要几十秒，卡在 RPC 里会让
 *    前端以为请求丢了。进度一律走 SSE 的 `preview.status`。
 * 2. **端口先定、再起进程、`strictPort`**。让 dev server 自己挑端口的话，
 *    网关要么指着旧端口，要么得在运行时改路由 —— 都会让 iframe 白屏且没有报错。
 * 3. **任何失败都要走 `state: 'failed'` 并带上原因**。无提示的"没起来"是这类
 *    编排代码最常见的坏味道：用户只能猜是依赖没装、端口被占、还是代码有语法错。
 *
 * 纯前端应用（M1）没有后端，`readiness.server` 直接记 ready；M2 接 NestJS 之后
 * 这里会变成真实的 `GET /api/health` 探测。
 */
import { existsSync } from 'node:fs'
import { appPaths, scrubEnv, type TenonHome } from '@tenon/core'
import type { PreviewState, PreviewStatus, Readiness, SseEventInput } from '@tenon/protocol'
import { isTenonError, TenonError } from '@tenon/protocol'
import { ensureDeps } from './deps.js'
import { findFreePorts } from './ports.js'
import { startGateway, type Gateway } from './proxy.js'
import { launchVite, type Launched, type Launcher } from './vite.js'

export interface PreviewManagerOptions {
  home: TenonHome
  env?: NodeJS.ProcessEnv
  publish?: (event: SseEventInput) => void
  /** 测试注入：默认 `launchVite`。注入一个 stub 上游就能把编排逻辑验完，不需要装 React */
  launch?: Launcher
  /** false = 不装依赖（测试用；缺依赖时会以 deps failed 结束） */
  installDeps?: boolean
  /** dev server 首屏可访问的等待上限。冷启动 + 首次预构建会慢，默认 90s */
  readyTimeoutMs?: number
  log?: (line: string) => void
}

const DEFAULT_READY_TIMEOUT = 90_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(err: unknown): string {
  if (isTenonError(err)) return err.message
  return err instanceof Error ? err.message : String(err)
}

/** 轮询到上游返回非 5xx 为止。5xx = 网关连不上 dev server，继续等 */
async function waitForUpstream(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = '还没开始探测'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      await response.text()
      if (response.status < 500) return
      last = `HTTP ${response.status}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await sleep(150)
  }
  throw new TenonError(
    'PREVIEW_START_FAILED',
    `dev server 在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪（最后一次：${last}）`,
    { url, lastError: last },
  )
}

class PreviewRun {
  state: PreviewState = 'starting'
  readonly readiness: Readiness = { deps: 'pending', server: 'pending', preview: 'pending' }
  url: string | null = null
  gatewayPort: number | null = null
  upstreamPort: number | null = null
  error: string | null = null
  startedAt: number | null = null
  gateway: Gateway | null = null
  launched: Launched | null = null
  cancelled = false
  settled: Promise<void>
  private settleDone!: () => void

  constructor(readonly appId: string) {
    this.settled = new Promise<void>((resolve) => {
      this.settleDone = resolve
    })
  }

  settle(): void {
    this.settleDone()
  }
}

export class PreviewManager {
  private readonly runs = new Map<string, PreviewRun>()
  private readonly usedPorts = new Set<number>()
  private readonly launch: Launcher
  private closed = false

  constructor(private readonly options: PreviewManagerOptions) {
    this.launch = options.launch ?? launchVite
  }

  /** 正在跑/正在起的应用 id（health 与 UI 用） */
  activeApps(): string[] {
    return [...this.runs.entries()].filter(([, run]) => run.state !== 'failed').map(([id]) => id)
  }

  status(appId: string): PreviewStatus {
    const run = this.runs.get(appId)
    if (run === undefined) {
      return {
        appId,
        state: 'stopped',
        url: null,
        gatewayPort: null,
        upstreamPort: null,
        readiness: { deps: 'pending', server: 'pending', preview: 'pending' },
        error: null,
        startedAt: null,
      }
    }
    return {
      appId,
      state: run.state,
      url: run.url,
      gatewayPort: run.gatewayPort,
      upstreamPort: run.upstreamPort,
      readiness: { ...run.readiness },
      error: run.error,
      startedAt: run.startedAt,
    }
  }

  /** 立刻返回 `starting`；真正的就绪通过 `preview.status` / `waitReady()` 观察 */
  async start(appId: string, options: { restart?: boolean } = {}): Promise<PreviewStatus> {
    if (this.closed) throw new TenonError('PREVIEW_NOT_RUNNING', '服务正在关闭，不能再起预览')

    const existing = this.runs.get(appId)
    if (existing !== undefined && (existing.state === 'starting' || existing.state === 'ready')) {
      if (options.restart !== true) return this.status(appId)
      await this.stop(appId)
    }

    const paths = appPaths(this.options.home, appId)
    if (!existsSync(paths.repoDir)) {
      throw new TenonError('APP_HOME_MISSING', '应用目录不存在，没法起预览', { repoDir: paths.repoDir })
    }

    const run = new PreviewRun(appId)
    run.startedAt = Date.now()
    this.runs.set(appId, run)
    this.emit(run)
    void this.execute(run)
    return this.status(appId)
  }

  async stop(appId: string): Promise<PreviewStatus> {
    const run = this.runs.get(appId)
    if (run === undefined) return this.status(appId)
    run.cancelled = true
    await this.teardown(run)
    this.runs.delete(appId)
    return this.status(appId)
  }

  /** 等到 ready 或 failed（不会 reject —— 调用方看 `state` 与 `error`） */
  async waitReady(appId: string, timeoutMs = 120_000): Promise<PreviewStatus> {
    const run = this.runs.get(appId)
    if (run === undefined) return this.status(appId)
    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    await Promise.race([run.settled, timer])
    return this.status(appId)
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.runs.keys()].map((appId) => this.stop(appId)))
  }

  // ------------------------------------------------------------ 内部

  /**
   * 子进程的环境。
   *
   * ★ 不能直接把 `options.env` 丢给 spawn：`StartServerOptions.env` 的语义是
   * **对 `process.env` 的覆盖**（`openCore` 从它里面读 `TENON_HOME`），测试里常常只传
   * `{ TENON_HOME, TENON_FAUX }` 两个键。原样当环境用 → 子进程没有 `PATH`，
   * `pnpm install` 直接以 `code=null` 失败，报错还只说"退出码 null"，极难查。
   *
   * 合并之后再过一遍 `scrubEnv`：密钥不该进生成应用的进程。
   */
  private spawnEnv(): NodeJS.ProcessEnv {
    return scrubEnv({ ...process.env, ...(this.options.env ?? {}) })
  }

  private async execute(run: PreviewRun): Promise<void> {
    const paths = appPaths(this.options.home, run.appId)
    const env = this.spawnEnv()
    try {
      // 1. 依赖
      if (this.options.installDeps !== false) {
        const result = await ensureDeps({
          repoDir: paths.repoDir,
          env,
          ...(this.options.log === undefined ? {} : { onLog: this.options.log }),
        })
        if (run.cancelled) return
        if (result.installed) {
          this.options.log?.(`[tenon] 依赖装好了（${result.durationMs}ms）`)
        }
      }
      run.readiness.deps = 'ready'
      this.emit(run)

      // 2. 端口（先定下来，strictPort 才有意义）
      const ports = await findFreePorts(2, this.usedPorts)
      const vitePort = ports[0]
      const gatewayPort = ports[1]
      if (vitePort === undefined || gatewayPort === undefined) {
        throw new TenonError('PREVIEW_PORT_EXHAUSTED', '拿不到两个空闲端口')
      }
      run.upstreamPort = vitePort
      run.gatewayPort = gatewayPort
      if (run.cancelled) return

      // 3. 网关先起：url 立刻确定，前端不用等 dev server
      const gateway = await startGateway({ routes: [{ prefix: '/', port: vitePort }] })
      run.gateway = gateway
      run.url = gateway.url
      if (run.cancelled) {
        await this.teardown(run)
        return
      }

      // 4. dev server
      const launched = await this.launch({ repoDir: paths.repoDir, vitePort, gatewayPort, env })
      run.launched = launched
      launched.onExit((info) => {
        if (run.cancelled || run.state !== 'ready') return
        run.state = 'failed'
        run.readiness.preview = 'failed'
        run.error = `dev server 退出了（code=${info.code ?? 'null'} signal=${info.signal ?? '-'}）`
        this.emit(run)
        void this.teardown(run)
      })

      // 5. 等首屏真的能打开
      try {
        await waitForUpstream(gateway.url, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT)
      } catch (err) {
        // dev server 起不来时，它自己的最后一行输出比任何猜测都有用（端口占、语法错、插件版本不对）
        const output = launched.output()
        const lastLine = output.split('\n').filter((line) => line.trim() !== '').at(-1)
        const reason = messageOf(err)
        throw new TenonError(
          'PREVIEW_START_FAILED',
          lastLine === undefined ? reason : `${reason}（dev server 最后输出：${lastLine}）`,
          { output },
        )
      }
      if (run.cancelled) {
        await this.teardown(run)
        return
      }

      run.readiness.preview = 'ready'
      // M1 生成的是纯前端应用：没有后端就不是"没就绪"，而是"不需要"
      run.readiness.server = 'ready'
      run.state = 'ready'
      this.emit(run, true)
      this.options.log?.(`[tenon] 预览就绪 ${gateway.url}（应用 ${run.appId}）`)
    } catch (err) {
      if (run.cancelled) return
      await this.fail(run, err)
    } finally {
      run.settle()
    }
  }

  private async fail(run: PreviewRun, err: unknown): Promise<void> {
    run.state = 'failed'
    run.error = messageOf(err)
    if (isTenonError(err) && err.code === 'PREVIEW_DEPS_FAILED') run.readiness.deps = 'failed'
    else run.readiness.preview = 'failed'
    this.options.log?.(`[tenon] 预览失败（应用 ${run.appId}）：${run.error}`)
    this.emit(run)
    await this.teardown(run)
  }

  private async teardown(run: PreviewRun): Promise<void> {
    const launched = run.launched
    const gateway = run.gateway
    run.launched = null
    run.gateway = null
    if (run.upstreamPort !== null) this.usedPorts.delete(run.upstreamPort)
    if (run.gatewayPort !== null) this.usedPorts.delete(run.gatewayPort)
    if (launched !== null) await launched.stop().catch(() => undefined)
    if (gateway !== null) await gateway.close().catch(() => undefined)
    if (run.state === 'ready' || run.state === 'starting') run.state = 'stopped'
    run.url = null
  }

  private emit(run: PreviewRun, ready = false): void {
    const publish = this.options.publish
    if (publish === undefined) return
    const status = this.status(run.appId)
    publish({ type: 'preview.status', appId: run.appId, status })
    if (ready && status.url !== null) {
      publish({
        type: 'preview.ready',
        appId: run.appId,
        url: status.url,
        readiness: status.readiness,
      })
    }
  }
}
