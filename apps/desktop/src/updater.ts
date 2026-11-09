/**
 * 自动更新：**壳的事，不是业务的事**。
 *
 * 为什么放在这里而不是 server 里：能换掉安装包的东西只有 Electron 主进程
 * （Squirrel / NSIS 的安装动作由 `electron-updater` 在壳内触发）。server 连自己在不在
 * 壳里都不知道（铁律 1）。所以这里只做两件事：问 feed「有没有新版」、把状态讲给界面听。
 *
 * 为什么这个文件不 import `electron`：它要能在 node 里被单测（`apps/desktop/test/`）。
 * 版本比较、进度换算、错误降级这些逻辑一旦只能靠"装个包点一下"来验，就永远没人验。
 * 于是 `electron` 的那一小面（`autoUpdater`）通过 `UpdaterAdapter` 注入，
 * 运行期给真的，测试里给假的。
 *
 * 三条底线（写在这里，改的时候别越过去）：
 *
 * 1. **更新失败绝不影响应用本身。** 所有入口 try/catch 到底，只把状态写进 `error`。
 *    更新是锦上添花，连不上 GitHub 的机器也要能正常干活。
 * 2. **不静默。** 检查失败、下载失败都要能说出"为什么"，界面上要有一个能重试的按钮。
 *    这一条和发布门禁的"三态判定"是同一个价值观：说不清就等于骗人。
 * 3. **安装前先把 server 收干净。** 直接 `quitAndInstall()` 会当场杀进程，
 *    而那个进程正在写 `tenon.db` 与应用的 git 仓库 —— 用户下次打开就是"库需要恢复"。
 *    所以 `beforeInstall` 是必填项，不是可选优化。
 */

/** 界面会看到的阶段。`unavailable` 是"这套环境没有更新这回事"，界面**不渲染任何入口** */
export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateState {
  readonly phase: UpdatePhase
  /** 当前安装的版本（来自 `app.getVersion()`） */
  readonly currentVersion: string
  /** 可更新到的版本（`available` / `downloading` / `ready` 时有值） */
  readonly version: string | null
  /** 下载进度 0–100 的整数（只有 `downloading` 有值） */
  readonly percent: number | null
  /** 给用户看的一句话；`unavailable` / `current` 时也写清楚原因 */
  readonly message: string
  /** 出问题时"下一步能做什么"；没有就是 null */
  readonly hint: string | null
}

export interface AvailableInfo {
  version: string
  releaseNotes?: string | null
}

/** `electron-updater` 的最小面：多一个方法都不要，否则测试里的假实现会跟着漂 */
export interface UpdaterAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  /** alpha / beta 阶段必须开，否则 GitHub Releases 里的预发布永远"看不到" */
  allowPrerelease: boolean
  on(event: string, handler: (payload: never) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  setFeedURL?(options: { provider: 'generic'; url: string }): void
}

export interface UpdaterOptions {
  adapter: UpdaterAdapter
  /** `app.isPackaged`：开发态没有安装包，检查更新没有意义 */
  isPackaged: boolean
  currentVersion: string
  /** 覆盖 feed（自托管 / 端到端测试用）。null = 用包内 `app-update.yml` */
  feedUrl: string | null
  /** 打包时是否真的生成了 `app-update.yml`（`electron-builder` 的 publish 配置） */
  feedConfigured: boolean
  onState: (state: UpdateState) => void
  /** 安装前收尾（停 server）。失败也要继续装 —— 但要在日志里留下痕迹 */
  beforeInstall: () => Promise<void>
  platform?: NodeJS.Platform
}

export interface UpdaterController {
  state(): UpdateState
  /** 检查有没有新版。重复调用安全：checking / downloading 期间直接返回 */
  check(): Promise<void>
  /** 开始下载（`available` 才有意义） */
  download(): Promise<void>
  /** 退出并安装（`ready` 才有意义） */
  install(): Promise<void>
}

const CHECK_TIMEOUT_MS = 20_000

/**
 * 超时兜底。
 *
 * 为什么需要：`checkForUpdates()` 在"DNS 能解析但不回包"的网络里会挂很久，
 * 而界面上那个"检查中"就一直是转圈 —— 用户以为卡死了。20 秒足够慢网，
 * 也短到不像死机。（与网关给页面通道加超时是同一个理由。）
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${String(ms / 1000)}s）`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createUpdater(options: UpdaterOptions): UpdaterController {
  const { adapter, isPackaged, currentVersion, feedUrl, feedConfigured, onState, beforeInstall } =
    options
  const platform = options.platform ?? process.platform

  /*
   * 为什么 `autoDownload = false`：自动下载会在用户不知道的情况下吃掉几十 MB。
   * 这个产品到处在讲"用量看得见"，更新流量也该是用户点的。
   * `autoInstallOnAppQuit = true`（下载完之后关窗即装）是因为**那时用户已经点了下载**，
   * 再让他多点一次"重启"是多余的仪式。
   */
  adapter.autoDownload = false
  adapter.autoInstallOnAppQuit = true
  adapter.allowPrerelease = /-(alpha|beta|rc)/i.test(currentVersion)

  let current: UpdateState = initial()
  /** 正在飞的一次检查/下载：防抖，也防界面连点两下打两次请求 */
  let inFlight = false

  function initial(): UpdateState {
    if (!isPackaged) {
      return {
        phase: 'unavailable',
        currentVersion,
        version: null,
        percent: null,
        message: '开发态不检查更新',
        hint: null,
      }
    }
    if (feedUrl === null && !feedConfigured) {
      /*
       * 打包了但没有更新源：**这不是错误**，是"这个包不带更新能力"（比如内部自编译版）。
       * 报成 error 会让用户去点重试，而重试永远失败 —— 那是最招人烦的一种假故障。
       */
      return {
        phase: 'unavailable',
        currentVersion,
        version: null,
        percent: null,
        message: '这个安装包没有配置更新源',
        hint: null,
      }
    }
    return {
      phase: 'idle',
      currentVersion,
      version: null,
      percent: null,
      message: '可以检查更新',
      hint: null,
    }
  }

  function set(next: UpdateState): void {
    current = next
    try {
      onState(next)
    } catch {
      // 界面那边出事不该把更新流程带崩（比如窗口已经销毁）
    }
  }

  function fail(error: unknown, hint: string | null): void {
    const reason = error instanceof Error ? error.message : String(error)
    set({
      phase: 'error',
      currentVersion,
      version: current.version,
      percent: null,
      message: `更新失败：${reason}`,
      hint,
    })
  }

  /*
   * 事件接线。
   *
   * 每条都做"阶段检查"而不是无条件覆盖：`download-progress` 可能在 `update-downloaded`
   * 之后才到（网络乱序 + 我们的 await 也在切换状态），无条件写就会把"已下载完"
   * 打回"下载中"，界面于是永远不给那个"重启"按钮。
   */
  adapter.on('update-available', ((info: AvailableInfo) => {
    set({
      phase: 'available',
      currentVersion,
      version: info.version,
      percent: null,
      message: `有新版本 ${info.version}`,
      hint: null,
    })
  }) as (payload: never) => void)

  adapter.on('update-not-available', (() => {
    set({
      phase: 'current',
      currentVersion,
      version: null,
      percent: null,
      message: `已是最新版本（${currentVersion}）`,
      hint: null,
    })
  }) as (payload: never) => void)

  adapter.on('download-progress', ((progress: { percent?: number }) => {
    if (current.phase !== 'downloading' && current.phase !== 'available') return
    const raw = typeof progress.percent === 'number' ? progress.percent : 0
    const percent = Math.min(100, Math.max(0, Math.round(raw)))
    set({
      phase: 'downloading',
      currentVersion,
      version: current.version,
      percent,
      message: `正在下载 ${String(percent)}%`,
      hint: null,
    })
  }) as (payload: never) => void)

  adapter.on('update-downloaded', ((info: { version?: string }) => {
    const version = info.version ?? current.version
    set({
      phase: 'ready',
      currentVersion,
      version,
      percent: 100,
      message: `新版本 ${version ?? ''} 已下载，重启后生效`.replace('  ', ' '),
      hint: null,
    })
  }) as (payload: never) => void)

  adapter.on('error', ((error: Error) => {
    /*
     * macOS 上最常见的一条：应用未签名。Squirrel.Mac 拒绝安装未签名更新，
     * 错误文案是 "Could not get code signature for running application"。
     * 把它翻译成人话，否则用户只会看到一句英文然后以为是我们坏了。
     */
    const message = error instanceof Error ? error.message : String(error)
    const unsigned = platform === 'darwin' && /code signature|signature/i.test(message)
    set({
      phase: 'error',
      currentVersion,
      version: current.version,
      percent: null,
      message: unsigned ? '这个版本没有签名，macOS 不允许自动更新' : `更新失败：${message}`,
      hint: unsigned
        ? '去 GitHub Releases 手动下载新的 .dmg 覆盖安装即可'
        : '检查网络后重试；一直失败就去 GitHub Releases 手动下载',
    })
  }) as (payload: never) => void)

  if (feedUrl !== null && adapter.setFeedURL !== undefined) {
    adapter.setFeedURL({ provider: 'generic', url: feedUrl })
  }

  return {
    state: () => current,

    async check(): Promise<void> {
      // 开发态 / 没配源：不打扰 feed，直接把原因留在状态里
      if (current.phase === 'unavailable') return
      if (inFlight || current.phase === 'downloading') return
      inFlight = true
      set({
        phase: 'checking',
        currentVersion,
        version: current.version,
        percent: null,
        message: '正在检查更新…',
        hint: null,
      })
      try {
        await withTimeout(adapter.checkForUpdates(), CHECK_TIMEOUT_MS, '检查更新')
      } catch (error) {
        fail(error, '检查网络后重试；一直失败就去 GitHub Releases 手动下载')
      } finally {
        inFlight = false
      }
    },

    async download(): Promise<void> {
      if (inFlight || current.phase === 'ready' || current.phase === 'downloading') return
      if (current.version === null) return
      inFlight = true
      set({
        phase: 'downloading',
        currentVersion,
        version: current.version,
        percent: 0,
        message: '正在下载 0%',
        hint: null,
      })
      try {
        await adapter.downloadUpdate()
      } catch (error) {
        fail(error, '检查网络后重试；一直失败就去 GitHub Releases 手动下载')
      } finally {
        inFlight = false
      }
    },

    async install(): Promise<void> {
      if (current.phase !== 'ready') return
      try {
        await beforeInstall()
      } catch (error) {
        /*
         * 收尾失败也照装：留一个"库要恢复"的库，比让用户永远升不上去好。
         * 但要在状态里说清楚 —— 这一条属于"不静默"。
         */
        const reason = error instanceof Error ? error.message : String(error)
        set({
          ...current,
          message: `本地服务没能正常关闭（${reason}），仍然继续安装`,
        })
      }
      adapter.quitAndInstall()
    },
  }
}
