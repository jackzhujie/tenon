/**
 * 插件页（M5 第 6 步 / DoD ④）：列表 / 独立开关 / 来源标识 / "官方 Hub 筹备中"占位。
 *
 * 为什么 M5 就要把它做出来（那时只有内置组件）：M6 会同时面对"加载器改造 + 界面重构 +
 * 更新机制"三件事，风险叠在发布前。先把界面按最终形状立起来，之后只是填数据源。
 *
 * 三个刻意的取舍：
 * 1. **关掉 ≠ 卸载**。开关只改装配声明的 `enabled`，声明还在 —— 所以能一键开回来；
 *    想真删掉走 Agent 的 `remove_component`（那会连带清 AGENTS.md）。
 * 2. **问题直接摊在列表上**，不折叠。装不上的原因（要求更高版本、槽位没声明）是用户
 *    唯一能据以行动的信息，藏进二级面板等于没有。
 * 3. **来源必须可见**：内置（随包）/ Hub（官方下载，M6）。用户有权知道这段代码从哪来。
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  AvailableComponent,
  ComponentProblem,
  InstalledComponent,
  RpcOutput,
} from '@tenon/protocol'
import { rpc } from '../../lib/rpc.js'
import { cn } from '../../lib/cn.js'

interface ComponentList {
  components: InstalledComponent[]
  problems: ComponentProblem[]
  available: AvailableComponent[]
  tenonVersion: string
}

/**
 * 直接用协议的出参类型，**不在这里手抄一份**：手抄的形状会漂，而漂的方式是
 * "服务端多给了一个字段、界面永远看不到"，没有任何报错。
 */
type HubCheck = RpcOutput<'hub.check'>

const SOURCE_LABEL: Record<InstalledComponent['source'], string> = {
  bundled: '内置',
  hub: 'Hub',
  local: '本地',
}

export interface PluginsPanelProps {
  appId: string | null
}

export function PluginsPanel({ appId }: PluginsPanelProps) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<ComponentList | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /*
   * Hub 状态。**未配置是正常状态**（官方 Hub 上线前就是它），所以这里不显示错误，
   * 只把"现在用的是哪一套"说清楚 —— 写死一句"筹备中"会在 Hub 上线那天变成假话。
   */
  const [hub, setHub] = useState<{ configured: boolean; hubUrl: string | null; keyFingerprint: string | null } | null>(null)
  /**
   * 更新检查的结果。
   *
   * **默认不自动检查**：每次开面板都去请求一次 Hub，会让离线用户反复看到"连不上"，
   * 也会让"我刚点的更新怎么没反应"变成一条新谜题（其实是在等网络）。所以给一个按钮，
   * 用户点了才查 —— 点一下就是明确的意图。
   */
  const [updates, setUpdates] = useState<HubCheck | null>(null)
  const [checking, setChecking] = useState(false)
  /** 成功提示（与 error 分开：一个红一个灰，混用会让人以为更新失败） */
  const [notice, setNotice] = useState<string | null>(null)

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setUpdates(await rpc('hub.check', {}))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (appId === null) return
    try {
      const [list, hubStatus] = await Promise.all([
        rpc('component.list', { appId }),
        rpc('hub.status', {}),
      ])
      setData(list)
      setHub(hubStatus)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [appId])

  /**
   * 装一个版本。装完必须 `load()`：列表里的版本号来自 `component.list`，
   * 不刷新的话用户会看到"更新成功"但版本号没变 —— 那种界面比报错更让人怀疑人生。
   */
  const install = useCallback(
    async (id: string): Promise<void> => {
      setBusy(`hub:${id}`)
      try {
        const result = await rpc('hub.install', { id })
        await load()
        await check()
        setError(null)
        setNotice(
          result.reloadedApps > 0
            ? `已更新到 v${result.version}，${result.reloadedApps} 个应用已重新加载`
            : `已装好 v${result.version}。没有应用在用这个版本（版本区间不接受它），需要改装配声明`,
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [load, check],
  )


  useEffect(() => {
    if (!open) return
    // 换应用/重新打开时把上一次的结论清掉：挂着旧结论比没有结论更容易误事
    setUpdates(null)
    setNotice(null)
    void load()
  }, [open, load])

  async function toggle(component: InstalledComponent): Promise<void> {
    if (appId === null) return
    setBusy(component.id)
    try {
      await rpc('component.setEnabled', { appId, id: component.id, enabled: !component.enabled })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const installed = data?.components ?? []
  const problems = data?.problems ?? []
  const installable = (data?.available ?? []).filter((item) => !item.installed)

  return (
    <div className="relative">
      <button
        type="button"
        disabled={appId === null}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-muted',
          'hover:text-ink disabled:opacity-40',
        )}
        title="这个应用装了哪些组件"
      >
        插件
        {installed.length > 0 && <span className="ml-1 text-[10px] text-faint">{installed.length}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-40 w-[420px] rounded-lg border border-line bg-panel p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] text-ink">这个应用的组件</span>
            <span className="font-mono text-[10px] text-faint">v{data?.tenonVersion ?? '—'}</span>
          </div>

          {error !== null && <p className="mb-2 text-[11px] text-bad">读不出来：{error}</p>}

          {installed.length === 0 && problems.length === 0 && (
            <p className="text-[11px] text-faint">
              还没装组件。可以让 Agent 装一个（比如「加上 AI 小助手」），或者用 <code>install_component</code>。
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {installed.map((component) => (
              <li key={component.id} className="rounded-md border border-line bg-panel-2 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] text-ink">{component.name}</span>
                      <span className="rounded border border-line px-1 text-[9.5px] text-faint">
                        {SOURCE_LABEL[component.source]}
                      </span>
                      <span className="font-mono text-[9.5px] text-faint">v{component.version}</span>
                    </div>
                    <div className="truncate font-mono text-[9.5px] text-faint">{component.id}</div>
                  </div>
                  <label className="flex shrink-0 items-center gap-1 text-[10.5px] text-faint">
                    <input
                      type="checkbox"
                      checked={component.enabled}
                      disabled={busy === component.id}
                      onChange={() => void toggle(component)}
                    />
                    {component.enabled ? '启用' : '已关闭'}
                  </label>
                </div>
                {component.mounts.length > 0 && (
                  <div className="mt-1 text-[10px] text-faint">
                    挂载：{component.mounts.map((mount) => mount.slot).join('、')}
                  </div>
                )}
                {!component.loaded && component.enabled && (
                  <div className="mt-1 text-[10px] text-warn">没加载起来（原因见下）</div>
                )}
              </li>
            ))}
          </ul>

          {problems.length > 0 && (
            <div className="mt-2 rounded-md border border-bad/40 bg-bad/5 p-2">
              <div className="mb-1 text-[11px] text-bad">装不上的 {problems.length} 条</div>
              <ul className="flex flex-col gap-1">
                {problems.map((item, index) => (
                  <li key={`${item.code}-${index}`} className="text-[10.5px] text-muted">
                    <span className="font-mono text-[9.5px] text-faint">{item.code}</span> {item.message}
                    {item.hint !== null && <span className="text-faint">（{item.hint}）</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {installable.length > 0 && (
            <div className="mt-2 border-t border-line pt-2">
              <div className="mb-1 text-[10.5px] text-faint">还能装</div>
              <ul className="flex flex-col gap-1">
                {installable.map((item) => (
                  <li key={item.id} className="flex items-center justify-between text-[10.5px] text-muted">
                    <span className="truncate">
                      {item.name} <span className="font-mono text-[9.5px] text-faint">{item.id}</span>
                    </span>
                    <span className="shrink-0 text-[9.5px] text-faint">让 Agent 装</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/*
            更新区。三件事按顺序说：Hub 连没连上 → 有没有新版 → 装上会不会生效。
            第三件最容易漏：应用的版本区间可能不接受新版，装了也是白装。
          */}
          <div className="mt-2 border-t border-line pt-2 text-[10px] text-faint">
            {hub?.configured === true ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    官方 Hub：<span className="font-mono text-muted">{hub.hubUrl}</span>
                    {hub.keyFingerprint !== null && (
                      <span className="ml-1 font-mono">· 密钥 {hub.keyFingerprint}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => {
                      setNotice(null)
                      void check()
                    }}
                    className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                  >
                    {checking ? '检查中…' : '检查更新'}
                  </button>
                </div>

                {updates !== null && updates.reachable === false && (
                  // 连不上**不是故障**：内置组件不依赖 Hub，说一句就够，别做成红色错误
                  <div className="mt-1 text-faint">
                    连不上 Hub（不影响已装的组件）：{updates.error ?? '未知原因'}
                  </div>
                )}

                {updates !== null && updates.reachable && (
                  <div className="mt-1">
                    {(() => {
                      const mine = updates.components.filter((item) => item.installedVersion !== null)
                      const pending = mine.filter((item) => item.update)
                      if (mine.length === 0) {
                        return <span>本机还没有从 Hub 装的组件（内置组件跟软件版本走）。</span>
                      }
                      if (pending.length === 0) {
                        return <span>已装的 {mine.length} 个 Hub 组件都是最新的。</span>
                      }
                      return (
                        <ul className="flex flex-col gap-1.5">
                          {pending.map((item) => (
                            <li key={item.id} className="rounded border border-line bg-panel-2 p-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-muted">
                                  {item.name}{' '}
                                  <span className="font-mono text-[9.5px]">
                                    v{item.installedVersion} → v{item.latest}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={() => void install(item.id)}
                                  className="shrink-0 rounded border border-brand/50 bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand disabled:opacity-40"
                                >
                                  {busy === `hub:${item.id}` ? '更新中…' : '更新'}
                                </button>
                              </div>
                              {item.notes !== null && (
                                <div className="mt-0.5 truncate text-[9.5px] text-faint">{item.notes}</div>
                              )}
                              {item.blockedBy.length > 0 && (
                                <div className="mt-0.5 text-[9.5px] text-warn">
                                  装了也用不上：应用{' '}
                                  <span className="font-mono">{item.blockedBy.join('、')}</span>{' '}
                                  声明的版本区间不接受 v{item.latest}（要改装配声明里的区间）
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )
                    })()}
                  </div>
                )}
              </>
            ) : (
              '官方 Hub 筹备中：内置组件跟随软件版本更新，Hub 上线后可单独下载与热更新。'
            )}

            {notice !== null && <div className="mt-1 text-muted">{notice}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
