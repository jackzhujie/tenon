/**
 * 预览编排：一个应用一套「数据库 + 网关 + dev server(+ 后端)」，生命周期跟着应用走（DESIGN §9）。
 *
 * 五个必须守住的点：
 *
 * 1. **`start()` 立刻返回**。首次 `pnpm install` 可能要几十秒，PGlite 冷启动 2.4s，
 *    ts-node 首次编译 Nest 也要几秒 —— 卡在 RPC 里会让前端以为请求丢了。
 *    进度一律走 SSE 的 `preview.status`（`readiness` 四个维度）。
 * 2. **端口先定、再起进程、`strictPort`。** 让 dev server 自己挑端口的话，
 *    网关要么指着旧端口，要么得在运行时改路由 —— 都会让 iframe 白屏且没有报错。
 *    现在一次要三个：vite、api、gateway，仍然全部先占再告诉别人。
 * 3. **`/api/*` 归后端，其余归前端。** 网关按最长前缀分流，两边同一个源，
 *    所以前端永远用相对路径，应用代码不需要知道自己在哪个端口上。
 * 4. **数据库只给全栈应用起。** 纯前端应用连 `db` 这一格都不该 pending。
 * 5. **任何失败都要走 `state: 'failed'` 并带上原因**（含对应子进程的最后几行输出）。
 *    无提示的"没起来"是这类编排代码最常见的坏味道。
 * 6. **日志跟着应用走，不跟着预览跑**。三个来源（子进程 stdout/stderr、页面主动上报、
 *    平台自己的判断）都汇进 `LogStore`，预览停掉之后缓冲还在 —— 用户回看报错是主要场景。
 */
import { existsSync } from 'node:fs'
import { appPaths, scrubEnv, type TenonHome } from '@tenon/core'
import { DatabaseManager, type DatabaseProvider, type DbSnapshot } from '@tenon/db-provisioner'
import type {
  LogEntry,
  LogLevel,
  LogSource,
  PreviewState,
  PreviewStatus,
  Readiness,
  SseEventInput,
} from '@tenon/protocol'
import { isTenonError, TenonError } from '@tenon/protocol'
import { launchApi, resolveApiEntry, type ApiLauncher } from './api.js'
import type { Launched } from './child.js'
import { ensureDeps } from './deps.js'
import { classifyLine, inputFromError, LogStore, parseClientLog, type LogInput } from './logs.js'
import { findFreePorts } from './ports.js'
import { PageBridge } from './page.js'
import { startGateway, type Gateway } from './proxy.js'
import { launchVite, type Launcher } from './vite.js'

/**
 * 只用到这几个方法，测试可以塞一个假实现进来。
 *
 * 快照三件套是**可选**的：它们只在"回滚数据"这条路上用到，而绝大多数预览测试
 * 只关心进程起没起来。做成必选会让每处测试替身都多写三个空函数，
 * 反而把"这个替身是否支持回滚"这件事变得更模糊。
 */
export interface PreviewDatabase {
  acquire(appId: string): Promise<DatabaseProvider>
  release(appId: string): Promise<void>
  closeAll(): Promise<void>
  snapshot?(appId: string, sha: string): Promise<DbSnapshot | null>
  findSnapshot?(appId: string, sha: string): Promise<DbSnapshot | null>
  restoreSnapshot?(appId: string, snapshot: DbSnapshot): Promise<void>
}

export interface PreviewManagerOptions {
  home: TenonHome
  env?: NodeJS.ProcessEnv
  publish?: (event: SseEventInput) => void
  /** 测试注入：默认 `launchVite` */
  launch?: Launcher
  /** 测试注入：默认 `launchApi` */
  launchApi?: ApiLauncher
  /** 测试注入：默认按 `TENON_DB_MODE` 建一个 DatabaseManager */
  database?: PreviewDatabase
  /** false = 不装依赖（测试用；缺依赖时会以 deps failed 结束） */
  installDeps?: boolean
  /** dev server 首屏可访问的等待上限。冷启动 + 首次预构建会慢，默认 90s */
  readyTimeoutMs?: number
  /** 后端就绪上限。首次 ts-node 编译整棵 Nest 依赖树比较慢，默认 120s */
  apiReadyTimeoutMs?: number
  log?: (line: string) => void
}

const DEFAULT_READY_TIMEOUT = 90_000
const DEFAULT_API_TIMEOUT = 120_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(err: unknown): string {
  if (isTenonError(err)) return err.message
  return err instanceof Error ? err.message : String(err)
}

/**
 * 子进程最后几行输出。
 *
 * 只取最后一行是不够的 —— 这类启动失败的**真答案**常常在倒数第 2~6 行
 * （`node --watch` 会把 "Failed running ..." 放在最后，真正的错误在它上面）。
 */
function tailOf(launched: Launched | null, count = 6): string | null {
  const rows = (launched?.output() ?? '').split('\n').filter((line) => line.trim() !== '')
  if (rows.length === 0) return null
  return rows.slice(-count).join(' / ')
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
    { url, lastError: last, stage: 'preview' },
  )
}

/**
 * 轮询 `GET /api/health`。
 *
 * 为什么不只看端口通不通：Nest 的端口在 `app.listen()` 时才开，但**迁移还没跑完**时
 * 接口会 500。判定"就绪"必须是这条接口真的返回 `ok: true` —— 否则前端会在
 * 迁移跑到一半时开始发请求，表现为"刚建的应用第一次请求必报错"。
 */
async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = '还没开始探测'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      const body = await response.text()
      if (response.ok && body.includes('"ok":true')) return
      last = `HTTP ${response.status} ${body.slice(0, 160)}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await sleep(200)
  }
  throw new TenonError(
    'PREVIEW_START_FAILED',
    `后端在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪（最后一次：${last}）`,
    { url, lastError: last, stage: 'server' },
  )
}

class PreviewRun {
  state: PreviewState = 'starting'
  readonly readiness: Readiness = {
    deps: 'pending',
    db: 'pending',
    server: 'pending',
    preview: 'pending',
  }
  url: string | null = null
  gatewayPort: number | null = null
  upstreamPort: number | null = null
  apiPort: number | null = null
  error: string | null = null
  startedAt: number | null = null
  gateway: Gateway | null = null
  /** 页面通道：Agent 借它驱动真实浏览器里的这个页面（M4 第 4 步） */
  page: PageBridge | null = null
  vite: Launched | null = null
  api: Launched | null = null
  database: DatabaseProvider | null = null
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
  private readonly launchApi: ApiLauncher
  private readonly databases: PreviewDatabase
  private readonly store = new LogStore()
  private closed = false

  constructor(private readonly options: PreviewManagerOptions) {
    this.launch = options.launch ?? launchVite
    this.launchApi = options.launchApi ?? launchApi
    this.databases =
      options.database ??
      new DatabaseManager({
        home: options.home,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.log === undefined ? {} : { log: options.log }),
      })
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
        apiPort: null,
        readiness: { deps: 'pending', db: 'pending', server: 'pending', preview: 'pending' },
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
      apiPort: run.apiPort,
      readiness: { ...run.readiness },
      error: run.error,
      startedAt: run.startedAt,
    }
  }

  /**
   * 读最近的运行日志。
   *
   * 有它才能"切回一个早就跑着的应用还能看到刚才那条报错"——SSE 只推连上之后的事。
   */
  logs(
    appId: string,
    options: { limit?: number; sources?: LogSource[]; minLevel?: LogLevel } = {},
  ): LogEntry[] {
    return this.store.list(appId, options)
  }

  clearLogs(appId: string): number {
    return this.store.clear(appId)
  }

  /** 删应用时连缓冲一起丢，别留下已删应用的日志 */
  forget(appId: string): void {
    this.store.drop(appId)
  }

  /**
   * 这个应用的页面通道（给 e2e 子 Agent 用）。
   *
   * 返回 `undefined` 而不是抛错：预览没起过是**常态**（用户还没点预览），
   * 上层据此回一句"先把预览打开"，比一个 500 有用得多。
   */
  pages(appId: string): PageBridge | undefined {
    return this.runs.get(appId)?.page ?? undefined
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
    this.pushLog(appId, { source: 'tenon', level: 'info', message: '开始启动预览' })
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
  async waitReady(appId: string, timeoutMs = 180_000): Promise<PreviewStatus> {
    const run = this.runs.get(appId)
    if (run === undefined) return this.status(appId)
    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    await Promise.race([run.settled, timer])
    return this.status(appId)
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.runs.keys()].map((appId) => this.stop(appId)))
    await this.databases.closeAll()
  }

  // ------------------------------------------------------ 库快照（回滚的数据侧）

  /**
   * 给应用库打快照。**只在"这次提交改了 schema"时调用**（判据见
   * `@tenon/core` 的 `hasSchemaChange`）—— 每轮都存不现实。
   *
   * 库不存在时返回 `null`（应用从没起过带库的预览），不是错误。
   */
  async snapshotDatabase(appId: string, sha: string): Promise<DbSnapshot | null> {
    return (await this.databases.snapshot?.(appId, sha)) ?? null
  }

  async findDatabaseSnapshot(appId: string, sha: string): Promise<DbSnapshot | null> {
    return (await this.databases.findSnapshot?.(appId, sha)) ?? null
  }

  /**
   * 用快照覆盖应用库。
   *
   * **不自己停预览**：停预览会连带清掉 `run.database`，而这里的 `restore` 之后
   * 还可能需要同一个 provider 复用它已经占住的端口。由调用方按
   * 「先 `stop()` → 再 restore → 最后让用户重启预览」的顺序编排。
   */
  async restoreDatabase(appId: string, snapshot: DbSnapshot): Promise<void> {
    if (this.databases.restoreSnapshot === undefined) {
      throw new TenonError('DB_UNSUPPORTED', '当前数据库实现不支持还原快照')
    }
    await this.databases.restoreSnapshot(appId, snapshot)
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
          this.pushLog(run.appId, {
            source: 'tenon',
            level: 'info',
            message: `依赖已安装（${result.durationMs}ms）`,
          })
        }
      }
      run.readiness.deps = 'ready'
      this.emit(run)

      // 2. 这个应用有后端吗（看 package.json.tenon.api，兜底看 api/main.ts）
      const apiEntry = resolveApiEntry(paths.repoDir)

      // 3. 数据库：只有全栈应用才起。纯前端连这一格都不该 pending
      if (apiEntry !== null) {
        try {
          run.database = await this.databases.acquire(run.appId)
        } catch (err) {
          run.readiness.db = 'failed'
          throw isTenonError(err)
            ? err
            : new TenonError('DB_START_FAILED', `应用数据库起不来：${messageOf(err)}`, {
                stage: 'db',
              })
        }
        if (run.cancelled) return
        const dbUrl = new URL(run.database.connectionString())
        this.pushLog(run.appId, {
          source: 'db',
          level: 'info',
          message: `应用数据库就绪 ${dbUrl.host}`,
        })
      }
      run.readiness.db = 'ready'
      run.readiness.server = apiEntry === null ? 'ready' : 'pending'
      this.emit(run)

      // 4. 端口（一次占齐，全部是"先定下来再告诉别人"）
      const wanted = apiEntry === null ? 2 : 3
      const ports = await findFreePorts(wanted, this.usedPorts)
      const vitePort = ports[0]
      const gatewayPort = ports[wanted - 1]
      // null 和 undefined 在类型上是两件事：Route.port 不接受 null，LaunchSpec 只接受 undefined
      const apiPort: number | undefined = apiEntry === null ? undefined : ports[1]
      if (vitePort === undefined || gatewayPort === undefined) {
        throw new TenonError('PREVIEW_PORT_EXHAUSTED', `拿不到 ${wanted} 个空闲端口`)
      }
      run.upstreamPort = vitePort
      run.gatewayPort = gatewayPort
      run.apiPort = apiPort ?? null
      if (run.cancelled) return

      /*
       * 页面通道要在网关起来**之前**建好：网关的请求处理器会闭包持有它。
       * 它自己不起任何东西（只有内存里的队列），所以放在这一步没有代价。
       */
      const page = new PageBridge()
      run.page = page

      // 5. 网关先起：url 立刻确定，前端不用等任何进程
      //
      // `port` 必须显式传：这个端口是**提前用 `findFreePorts` 占好**的，
      // 而且已经通过 `TENON_GATEWAY_PORT` 告诉了 vite 配置（模板里
      // `server.hmr.clientPort` 就用它）。不传的话网关会随机再挑一个，于是
      // 「告诉浏览器的端口」和「真正在听的端口」不是一个 —— 症状极隐蔽：
      // 页面照常打开（iframe 用的是 url），但 HMR 的 WebSocket 永远连不上。
      const routes =
        apiPort === undefined
          ? [{ prefix: '/', port: vitePort }]
          : [
              { prefix: '/', port: vitePort },
              // 最长前缀优先：`/api/x` 命中这里而不是兜底的 `/`
              { prefix: '/api', port: apiPort },
            ]
      const gateway = await startGateway({
        routes,
        port: gatewayPort,
        // 页面主动上报的异常：它归平台，不归任何上游（见 proxy.ts 的 LOG_PATH 注释）
        onClientLog: (payload) => {
          const input = parseClientLog(payload)
          if (input !== null) this.pushLog(run.appId, input)
        },
        // 页面通道：网关把 /__tenon/page* 吃掉，再往 HTML 里插一行脚本
        page,
      })
      run.gateway = gateway
      run.url = gateway.url
      if (run.cancelled) {
        await this.teardown(run)
        return
      }

      // 6. dev server
      const vite = await this.launch({
        repoDir: paths.repoDir,
        vitePort,
        gatewayPort,
        ...(apiPort === undefined ? {} : { apiPort }),
        env,
        onLine: (line, stream) => {
          this.pushLine(run.appId, 'vite', classifyLine(line, stream), line)
        },
      })
      run.vite = vite
      vite.onExit((info) => {
        if (run.cancelled || run.state !== 'ready') return
        run.state = 'failed'
        run.readiness.preview = 'failed'
        run.error = `dev server 退出了（code=${info.code ?? 'null'} signal=${info.signal ?? '-'}）`
        this.pushLog(run.appId, {
          source: 'vite',
          level: 'error',
          message: run.error,
          detail: tailOf(run.vite, 12),
        })
        this.emit(run)
        void this.teardown(run)
      })

      // 7. 后端（全栈应用才有）
      if (apiEntry !== null && apiPort !== undefined) {
        const database = run.database
        if (database === null) throw new TenonError('DB_NOT_READY', '内部错误：有后端却没有数据库')
        const api = await this.launchApi({
          repoDir: paths.repoDir,
          apiPort,
          gatewayPort,
          entry: apiEntry,
          databaseUrl: database.connectionString(),
          poolMax: database.poolMax(),
          env,
          onLine: (line, stream) => {
            this.pushLine(run.appId, 'api', classifyLine(line, stream), line)
          },
        })
        run.api = api
        api.onExit((info) => {
          if (run.cancelled || run.state !== 'ready') return
          run.state = 'failed'
          run.readiness.server = 'failed'
          run.error = `后端退出了（code=${info.code ?? 'null'} signal=${info.signal ?? '-'}）`
          this.pushLog(run.appId, {
            source: 'api',
            level: 'error',
            message: run.error,
            detail: tailOf(run.api, 12),
          })
          this.emit(run)
          void this.teardown(run)
        })
      }

      // 8. 探活：两个并行，谁先坏都能定位到是"前端没起来"还是"后端没起来"
      const probes: Array<Promise<void>> = [this.probeVite(run)]
      if (run.api !== null) probes.push(this.probeApi(run))
      await Promise.all(probes)
      if (run.cancelled) {
        await this.teardown(run)
        return
      }

      run.readiness.server = 'ready'
      run.readiness.preview = 'ready'
      run.state = 'ready'
      this.emit(run, true)
      this.options.log?.(
        `[tenon] 预览就绪 ${gateway.url}（应用 ${run.appId}${run.apiPort === null ? '' : `，后端 :${run.apiPort}`}）`,
      )
      this.pushLog(run.appId, {
        source: 'tenon',
        level: 'info',
        message: `预览就绪 ${gateway.url}${run.apiPort === null ? '' : `（后端 :${run.apiPort}）`}`,
      })
    } catch (err) {
      if (run.cancelled) return
      await this.fail(run, err)
    } finally {
      run.settle()
    }
  }

  private async probeVite(run: PreviewRun): Promise<void> {
    try {
      await waitForUpstream(run.url ?? '', this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT)
    } catch (err) {
      // dev server 起不来时，它自己的最后一行输出比任何猜测都有用（端口占、语法错、插件版本不对）
      const line = tailOf(run.vite)
      const output = run.vite?.output() ?? ''
      throw new TenonError(
        'PREVIEW_START_FAILED',
        line === null ? messageOf(err) : `${messageOf(err)}（dev server 最后输出：${line}）`,
        { output, stage: 'preview' },
      )
    }
  }

  private async probeApi(run: PreviewRun): Promise<void> {
    const base = run.url ?? ''
    const url = new URL('/api/health', base).href
    try {
      await waitForHealth(url, this.options.apiReadyTimeoutMs ?? DEFAULT_API_TIMEOUT)
    } catch (err) {
      // Nest 的失败原因几乎全在它自己的输出里（缺 ts-node、装饰器元数据、迁移报错）
      const line = tailOf(run.api)
      const output = run.api?.output() ?? ''
      throw new TenonError(
        'PREVIEW_START_FAILED',
        line === null ? messageOf(err) : `${messageOf(err)}（后端最后输出：${line}）`,
        { output, stage: 'server' },
      )
    }
  }

  private async fail(run: PreviewRun, err: unknown): Promise<void> {
    run.state = 'failed'
    run.error = messageOf(err)
    const stage = isTenonError(err) ? err.details?.['stage'] : undefined
    if (isTenonError(err) && err.code === 'PREVIEW_DEPS_FAILED') run.readiness.deps = 'failed'
    else if (stage === 'db' || (isTenonError(err) && err.code.startsWith('DB_'))) {
      run.readiness.db = 'failed'
    } else if (stage === 'server') run.readiness.server = 'failed'
    else run.readiness.preview = 'failed'
    this.options.log?.(`[tenon] 预览失败（应用 ${run.appId}）：${run.error}`)
    this.pushLog(run.appId, inputFromError(stage === 'db' ? 'db' : stage === 'server' ? 'api' : 'tenon', err, '预览失败：'))
    this.emit(run)
    await this.teardown(run)
  }

  private async teardown(run: PreviewRun): Promise<void> {
    const api = run.api
    const vite = run.vite
    const gateway = run.gateway
    const page = run.page
    run.api = null
    run.vite = null
    run.gateway = null
    run.page = null
    // 先掐通道：挂着的 e2e 命令立刻失败，不必等十几秒超时（Agent 那边会以为是自己错了）
    if (page !== null) page.close()
    if (run.upstreamPort !== null) this.usedPorts.delete(run.upstreamPort)
    if (run.apiPort !== null) this.usedPorts.delete(run.apiPort)
    if (run.gatewayPort !== null) this.usedPorts.delete(run.gatewayPort)

    // 先收进程再收网关：反过来的话，最后一刻还在飞的请求会打在已关的 socket 上
    if (api !== null) await api.stop().catch(() => undefined)
    if (vite !== null) await vite.stop().catch(() => undefined)
    if (gateway !== null) await gateway.close().catch(() => undefined)
    if (run.database !== null) {
      run.database = null
      await this.databases.release(run.appId)
    }

    if (run.state === 'ready' || run.state === 'starting') run.state = 'stopped'
    run.url = null
  }

  /**
   * 记一条日志并推给前端。
   *
   * `LogStore` 负责去重（同一句在 1 秒内合并成 `repeat`），但**合并后的那条照样推** ——
   * id 不变，前端按 id upsert，界面上就是一条 `×N`，不会跳行也不会刷屏。
   */
  private pushLog(appId: string, input: LogInput): void {
    this.emitLog(appId, this.store.add(appId, input))
  }

  /**
   * 子进程的**每一行**。与 `pushLog` 的差别全在 `LogStore.addLine`：
   * 堆栈续行会并进上一条的 detail，而不是在面板里刷出一堆缩进的 `at ...`。
   */
  private pushLine(appId: string, source: LogSource, level: LogLevel, line: string): void {
    this.emitLog(appId, this.store.addLine(appId, source, level, line))
  }

  private emitLog(appId: string, entry: LogEntry): void {
    this.options.publish?.({ type: 'app.log', appId, entry })
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
