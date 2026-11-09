/**
 * 自动更新的测试：**不启动 Electron**，用假 adapter 打事件。
 *
 * 为什么不用真 `autoUpdater`：它只在打包版里工作（`app.isPackaged` 为真、还要真网络），
 * 而这里要验的恰恰是最容易写错的部分 —— 状态机、进度换算、错误降级、安装顺序。
 * 这几条逻辑一旦只能靠"打个包点一下"来验，就永远没人验。
 *
 * 覆盖的都是真实会发生的故障，不是"能不能编译"：
 * 1. 开发态 / 没配更新源 → **不能**去问 feed（会挂 20 秒然后给个假错误）
 * 2. 有新版本 → 状态里必须带上目标版本，界面才有东西可显示
 * 3. 下载进度乱序到达 → 不能把"已下载完"打回"下载中"
 * 4. 检查抛错 → 变成 `error`，绝不冒泡（否则整个应用启动就崩）
 * 5. macOS 未签名 → 翻译成人话，并给一条能走的路
 * 6. 安装 → **先收 server 再 quitAndInstall**（顺序错了会杀出半截库）
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createUpdater,
  type UpdaterAdapter,
  type UpdaterOptions,
  type UpdateState,
} from '../src/updater.js'

/** 假 adapter：记录调用、允许测试手动打事件 */
function fakeAdapter() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const calls = { check: 0, download: 0, install: 0, feed: [] as string[] }
  const adapter: UpdaterAdapter & { emit(event: string, payload?: unknown): void } = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    on(event, handler) {
      handlers.set(event, handler as (payload: unknown) => void)
    },
    checkForUpdates: async () => {
      calls.check += 1
      return null
    },
    downloadUpdate: async () => {
      calls.download += 1
      return null
    },
    quitAndInstall: () => {
      calls.install += 1
    },
    setFeedURL: (options) => {
      calls.feed.push(options.url)
    },
    emit(event, payload) {
      handlers.get(event)?.(payload)
    },
  }
  return { adapter, calls }
}

function setup(overrides: Partial<UpdaterOptions> = {}) {
  const { adapter, calls } = fakeAdapter()
  const states: UpdateState[] = []
  const beforeInstall = vi.fn(async () => {})
  const updater = createUpdater({
    adapter,
    isPackaged: true,
    currentVersion: '0.0.0-alpha.3',
    feedUrl: 'https://example.test/feed',
    feedConfigured: true,
    onState: (state) => states.push(state),
    beforeInstall,
    platform: 'darwin',
    ...overrides,
  })
  return { updater, adapter, calls, states, beforeInstall }
}

describe('自动更新状态机', () => {
  it('开发态：不打扰 feed，状态是 unavailable 且 check 什么都不做', async () => {
    const { updater, calls } = setup({ isPackaged: false })
    expect(updater.state().phase).toBe('unavailable')
    expect(updater.state().message).toContain('开发态')

    await updater.check()
    expect(calls.check).toBe(0)
    expect(updater.state().phase).toBe('unavailable')
  })

  it('打包了但没配更新源：算 unavailable，不算 error（重试永远失败的那种假故障）', async () => {
    const { updater, calls } = setup({ feedUrl: null, feedConfigured: false })
    expect(updater.state().phase).toBe('unavailable')
    await updater.check()
    expect(calls.check).toBe(0)
  })

  it('打包版 + feed：检查到新版本，状态带上目标版本与当前版本', async () => {
    const { updater, adapter, calls } = setup()
    // alpha 阶段必须开 allowPrerelease，否则 GitHub 上的预发布永远"看不到"
    expect(adapter.allowPrerelease).toBe(true)
    // 不自动下载：更新流量要用户点
    expect(adapter.autoDownload).toBe(false)
    // 外部 feed 会被真的设进去（端到端测试就靠它指到本地静态目录）
    expect(calls.feed).toEqual(['https://example.test/feed'])

    const running = updater.check()
    expect(updater.state().phase).toBe('checking')
    adapter.emit('update-available', { version: '0.0.0-alpha.4' })
    await running

    expect(calls.check).toBe(1)
    expect(updater.state()).toMatchObject({
      phase: 'available',
      version: '0.0.0-alpha.4',
      currentVersion: '0.0.0-alpha.3',
    })
  })

  it('已是最新：current，且不留下"下载"按钮', async () => {
    const { updater, adapter } = setup()
    const running = updater.check()
    adapter.emit('update-not-available', {})
    await running
    expect(updater.state().phase).toBe('current')
    expect(updater.state().version).toBeNull()
  })

  it('下载进度取整并夹在 0–100，且乱序迟到的进度不能把 ready 打回 downloading', async () => {
    const { updater, adapter } = setup()
    const running = updater.check()
    adapter.emit('update-available', { version: '0.0.0-alpha.4' })
    await running

    await updater.download()
    adapter.emit('download-progress', { percent: 41.6 })
    expect(updater.state().percent).toBe(42)
    adapter.emit('download-progress', { percent: 999 })
    expect(updater.state().percent).toBe(100)

    adapter.emit('update-downloaded', { version: '0.0.0-alpha.4' })
    expect(updater.state().phase).toBe('ready')

    // 迟到的进度事件：必须被阶段检查挡掉，否则"重启安装"按钮会被一个 99% 抹掉
    adapter.emit('download-progress', { percent: 99 })
    expect(updater.state().phase).toBe('ready')
    expect(updater.state().percent).toBe(100)
  })

  it('检查抛错：变成 error 并带重试提示，绝不冒泡', async () => {
    const { updater, adapter } = setup()
    adapter.checkForUpdates = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    }
    await expect(updater.check()).resolves.toBeUndefined()
    expect(updater.state().phase).toBe('error')
    expect(updater.state().message).toContain('ENOTFOUND')
    expect(updater.state().hint).toContain('重试')
  })

  it('macOS 未签名：错误翻译成人话，并给出"手动下载"这条能走的路', () => {
    const { updater, adapter } = setup()
    adapter.emit('error', new Error('Could not get code signature for running application'))
    expect(updater.state().phase).toBe('error')
    expect(updater.state().message).toContain('没有签名')
    expect(updater.state().hint).toContain('手动下载')
  })

  it('安装：先收 server 再 quitAndInstall（顺序反了会杀出半截库）', async () => {
    const { updater, adapter, calls, beforeInstall } = setup()
    const ran: string[] = []
    beforeInstall.mockImplementation(async () => {
      ran.push('stop-server')
    })
    adapter.quitAndInstall = () => {
      ran.push('install')
      calls.install += 1
    }

    // 还没 ready：不许装（避免用户误点把应用重启掉）
    await updater.install()
    expect(calls.install).toBe(0)

    const running = updater.check()
    adapter.emit('update-available', { version: '0.0.0-alpha.4' })
    await running
    adapter.emit('update-downloaded', { version: '0.0.0-alpha.4' })

    await updater.install()
    expect(ran).toEqual(['stop-server', 'install'])
  })

  it('收尾失败也照装，但状态里要说清楚（不静默）', async () => {
    const { updater, adapter, calls, beforeInstall } = setup()
    beforeInstall.mockRejectedValue(new Error('server 没响应'))
    const running = updater.check()
    adapter.emit('update-available', { version: '0.0.0-alpha.4' })
    await running
    adapter.emit('update-downloaded', { version: '0.0.0-alpha.4' })

    await updater.install()
    expect(calls.install).toBe(1)
    expect(updater.state().message).toContain('仍然继续安装')
  })

  it('同时点两下检查：只打一次请求', async () => {
    const { updater, calls } = setup()
    await Promise.all([updater.check(), updater.check(), updater.check()])
    expect(calls.check).toBe(1)
  })
})
