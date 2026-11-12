/**
 * 插件页：**已装**（开关 / 更新 / 移除）与**商店**（还能装什么）两个页签。
 *
 * 历史：M5 第 6 步先按最终形状立起来（那时只有内置组件，商店只是"让 Agent 装"的占位），
 * M6 第 2 步补了更新检查，第 3 步把商店做成真能装的地方。
 *
 * 四个刻意的取舍：
 * 1. **关掉 ≠ 移除**。开关只改装配声明的 `enabled`，声明还在 —— 所以能一键开回来；
 *    「移除」才真的删声明（那会连带清 `docs/AGENTS.md`，Agent 也才知道它没了）。
 * 2. **问题直接摊在列表上**，不折叠。装不上的原因（要求更高版本、槽位没声明）是用户
 *    唯一能据以行动的信息，藏进二级面板等于没有。
 * 3. **来源必须可见**：内置（随包）/ Hub（官方下载）。用户有权知道这段代码从哪来。
 * 4. **"装了"与"用上了"分开说**。包装在本机是全局的，但用不用它由每个应用的版本区间
 *    决定 —— 所以更新那一行会点名"哪个应用挡住了"。
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
import { useT } from '../../lib/i18n.js'
import type { PluginsKey } from '../../lib/messages/plugins.js'

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

const SOURCE_KEY: Record<InstalledComponent['source'], PluginsKey> = {
  bundled: 'plugin.source.bundled',
  hub: 'plugin.source.hub',
  local: 'plugin.source.local',
}

/** 商店里的一行：本机可装的（bundled / 已下载的 hub 包）与 Hub 目录里的都归到这里 */
interface StoreItem {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 能装的版本 */
  readonly version: string
  readonly source: InstalledComponent['source']
  readonly paid: boolean
  /** 本机还没有这个包，点一下要先下载 */
  readonly needsDownload: boolean
}

export interface PluginsPanelProps {
  appId: string | null
}

export function PluginsPanel({ appId }: PluginsPanelProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'installed' | 'store'>('installed')
  const [data, setData] = useState<ComponentList | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /*
   * Hub 状态。**未配置是正常状态**（官方 Hub 上线前就是它），所以这里不显示错误，
   * 只把"现在用的是哪一套"说清楚 —— 写死一句"筹备中"会在 Hub 上线那天变成假话。
   */
  const [hub, setHub] = useState<{
    configured: boolean
    hubUrl: string | null
    keyFingerprint: string | null
    /** 配置打哪来（M6 第 5 步）：环境变量 / 安装包里的 hub.json */
    origin: 'env' | 'file' | null
    /** 配了但不对时的原因（只给了一半、文件坏了） */
    note: string | null
  } | null>(null)
  /**
   * 更新检查的结果 —— 同时也是商店的目录。
   *
   * **已装页签不自动查**：每次开面板都请求一次 Hub，会让离线用户反复看到"连不上"。
   * 但**商店页签会自动查一次** —— 打开商店等于说"我想看看有什么"，此时不查只会让
   * 用户对着空列表以为商店坏了。
   */
  const [updates, setUpdates] = useState<HubCheck | null>(null)
  const [checking, setChecking] = useState(false)
  /** 成功提示（与 error 分开：一个红一个灰，混用会让人以为操作失败） */
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
   * 把组件装进这个应用。本机没有包时服务端会先下载（`downloaded` 告诉我们是不是这次下的）。
   */
  const installIntoApp = useCallback(
    async (id: string): Promise<void> => {
      if (appId === null) return
      setBusy(`app:${id}`)
      try {
        const result = await rpc('component.install', { appId, id })
        await load()
        // 目录可能变了（刚下载了一个包），顺手刷新，免得商店里还写着"要下载"
        await check()
        if (result.problems.length > 0) {
          const first = result.problems[0]!
          setError(`${first.message}${first.hint === null ? '' : `（${first.hint}）`}`)
          setNotice(null)
          return
        }
        setError(null)
        setNotice(result.downloaded ? t('plugin.notice.installedFromHub') : t('plugin.notice.installed'))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [appId, load, check, t],
  )

  const removeFromApp = useCallback(
    async (id: string): Promise<void> => {
      if (appId === null) return
      setBusy(`rm:${id}`)
      try {
        const result = await rpc('component.remove', { appId, id })
        await load()
        setError(null)
        setNotice(result.removed ? t('plugin.notice.removed') : t('plugin.notice.notInstalled'))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [appId, load, t],
  )

  /**
   * 更新已装的 Hub 组件 = 把新版本装到**本机**。装配声明不动，
   * 所以受影响的只有版本区间接受它的应用（`reloadedApps` 就是这个数）。
   */
  const updatePackage = useCallback(
    async (id: string): Promise<void> => {
      setBusy(`hub:${id}`)
      try {
        const result = await rpc('hub.install', { id })
        await load()
        await check()
        setError(null)
        setNotice(
          result.reloadedApps > 0
            ? t('plugin.notice.updated', { version: result.version, count: result.reloadedApps })
            : t('plugin.notice.updatedNoUser', { version: result.version }),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [load, check, t],
  )

  useEffect(() => {
    if (!open) return
    // 换应用 / 重新打开时把上一次的结论清掉：挂着旧结论比没有结论更容易误事
    setUpdates(null)
    setNotice(null)
    setError(null)
    setTab('installed')
    void load()
  }, [open, load])

  // 打开商店时自动取一次目录（理由见 `updates` 的注释）
  useEffect(() => {
    if (!open || tab !== 'store') return
    if (hub?.configured !== true) return
    if (updates !== null || checking) return
    void check()
  }, [open, tab, hub, updates, checking, check])

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
  const inApp = new Set(installed.map((component) => component.id))

  /*
   * 商店 = 本机可装的（bundled / 已下载的 hub 包）+ Hub 目录里还没在本机的。
   *
   * 顺序有意义：**本机的排在前面**。本机能装的不需要网络，也不会因为"Hub 连不上"就
   * 装不了；把 Hub 的混在前面会让离线用户以为整个商店都不能用。
   */
  const store: StoreItem[] = []
  for (const item of data?.available ?? []) {
    if (item.installed) continue
    store.push({
      id: item.id,
      // 界面优先用当前语言的覆盖；没有就落回基准值（英文）
      name: item.localizedName ?? item.name,
      description: item.localizedDescription ?? item.description,
      version: item.version,
      source: item.source,
      paid: item.pricing.type === 'paid',
      needsDownload: false,
    })
  }
  for (const item of updates?.components ?? []) {
    if (inApp.has(item.id)) continue
    if (store.some((entry) => entry.id === item.id)) continue
    store.push({
      id: item.id,
      name: item.name,
      description: item.description,
      version: item.latest,
      source: 'hub',
      paid: item.paid,
      needsDownload: item.installedVersion === null,
    })
  }

  const updatable = (updates?.components ?? []).filter(
    (item) => item.installedVersion !== null && item.update,
  )
  const hubCount = store.filter((item) => item.source === 'hub').length

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
        title={t('plugin.tip')}
      >
        {t('plugin.title')}
        {installed.length > 0 && <span className="ml-1 text-[10px] text-faint">{installed.length}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-40 w-[440px] rounded-lg border border-line bg-panel p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {(
                [
                  ['installed', t('plugin.tab.installed', { count: installed.length })],
                  ['store', t('plugin.tab.store')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px]',
                    tab === value ? 'bg-panel-2 text-ink' : 'text-faint hover:text-muted',
                  )}
                >
                  {label}
                  {/* 有更新时在页签上标一下，否则用户根本不会点进去看 */}
                  {value === 'installed' && updatable.length > 0 && (
                    <span className="ml-1 text-warn">↑{updatable.length}</span>
                  )}
                </button>
              ))}
            </div>
            <span className="shrink-0 font-mono text-[10px] text-faint">v{data?.tenonVersion ?? '—'}</span>
          </div>

          {error !== null && <p className="mb-2 text-[11px] text-bad">{error}</p>}

          {tab === 'installed' ? (
            <>
              {installed.length === 0 && problems.length === 0 && (
                <p className="text-[11px] text-faint">
                  {t('plugin.empty.installed')}
                </p>
              )}

              <ul className="flex flex-col gap-2">
                {installed.map((component) => (
                  <li key={component.id} className="rounded-md border border-line bg-panel-2 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] text-ink">{component.localizedName ?? component.name}</span>
                          <span className="shrink-0 rounded border border-line px-1 text-[9.5px] text-faint">
                            {t(SOURCE_KEY[component.source])}
                          </span>
                          <span className="shrink-0 font-mono text-[9.5px] text-faint">
                            v{component.version}
                          </span>
                        </div>
                        <div className="truncate font-mono text-[9.5px] text-faint">{component.id}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <label className="flex items-center gap-1 text-[10.5px] text-faint">
                          <input
                            type="checkbox"
                            checked={component.enabled}
                            disabled={busy === component.id}
                            onChange={() => void toggle(component)}
                          />
                          {component.enabled ? t('plugin.enabled') : t('plugin.disabled')}
                        </label>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void removeFromApp(component.id)}
                          title={t('plugin.remove.title')}
                          className="rounded border border-line px-1 text-[10px] text-faint hover:text-bad disabled:opacity-40"
                        >
                          {busy === `rm:${component.id}` ? '…' : t('plugin.remove')}
                        </button>
                      </div>
                    </div>
                    {component.mounts.length > 0 && (
                      <div className="mt-1 text-[10px] text-faint">
                        挂载：{component.mounts.map((mount) => mount.slot).join('、')}
                      </div>
                    )}
                    {!component.loaded && component.enabled && (
                      <div className="mt-1 text-[10px] text-warn">{t('plugin.loadFailed')}</div>
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

              {/*
                更新区。三件事按顺序说：有没有新版 → 装上会不会生效 → 怎么更新。
                第二件最容易漏：应用的版本区间可能不接受新版，装了也是白装。
              */}
              {hub?.configured === true && (
                <div className="mt-2 border-t border-line pt-2 text-[10px] text-faint">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      官方 Hub：<span className="font-mono text-muted">{hub.hubUrl}</span>
                      {hub.keyFingerprint !== null && (
                        <span className="ml-1 font-mono">· 密钥 {hub.keyFingerprint}</span>
                      )}
                      {/*
                        「随包内置 / 环境变量」这一句是为了回答"我这个包为什么连的是这个地址"。
                        没有它就是：用户在另一台机器上装了同一个 dmg，看到的地址却是本机环境变量决定的。
                      */}
                      <span className="ml-1">· {hub.origin === 'file' ? t('plugin.hub.bundled') : t('plugin.hub.env')}</span>
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
                      {checking ? t('plugin.checkUpdates.checking') : t('plugin.checkUpdates.action')}
                    </button>
                  </div>

                  {updates !== null && updates.reachable === false && (
                    // 连不上**不是故障**：内置组件不依赖 Hub，说一句就够，别做成红色错误
                    <div className="mt-1">
                      {t('plugin.updates.unreachable', { reason: updates.error ?? t('plugin.updates.unknown') })}
                    </div>
                  )}

                  {updates !== null && updates.reachable && (
                    <div className="mt-1">
                      {updatable.length === 0 ? (
                        <span>
                          {(() => {
                            const mine = updates.components.filter(
                              (item) => item.installedVersion !== null,
                            )
                            return mine.length === 0
                              ? t('plugin.updates.noneInstalled')
                              : t('plugin.updates.allCurrent', { count: mine.length })
                          })()}
                        </span>
                      ) : (
                        <ul className="flex flex-col gap-1.5">
                          {updatable.map((item) => (
                            <li key={item.id} className="rounded border border-line bg-panel p-1.5">
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
                                  onClick={() => void updatePackage(item.id)}
                                  className="shrink-0 rounded border border-brand/50 bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand disabled:opacity-40"
                                >
                                  {busy === `hub:${item.id}` ? t('plugin.updates.updating') : t('plugin.updates.update')}
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
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-faint">
                <span className="truncate">
                  {hub?.configured === true ? (
                    <>
                      <span className="font-mono text-muted">{hub.hubUrl}</span>
                      {hubCount > 0 && <span> · {hubCount} 个来自 Hub</span>}
                    </>
                  ) : hub?.note != null ? (
                    /* 配了但不对（只给了一半 / 文件坏了）：这是"商店为什么是空的"的答案 */
                    <span className="text-warn">Hub 配置有问题：{hub.note}</span>
                  ) : (
                    t('plugin.store.hubPending')
                  )}
                </span>
                {hub?.configured === true && (
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => {
                      setNotice(null)
                      void check()
                    }}
                    className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                  >
                    {checking ? t('plugin.store.refreshing') : t('plugin.store.refresh')}
                  </button>
                )}
              </div>

              {updates !== null && updates.reachable === false && (
                <p className="mb-2 text-[10px] text-faint">
                  {t('plugin.store.unreachable', { reason: updates.error ?? t('plugin.updates.unknown') })}
                </p>
              )}

              {store.length === 0 ? (
                <p className="text-[11px] text-faint">
                  {hub?.configured !== true
                    ? t('plugin.store.noBundled')
                    : updates === null
                      ? t('plugin.store.readingHub')
                      : t('plugin.store.allInstalled')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {store.map((item) => (
                    <li key={item.id} className="rounded-md border border-line bg-panel-2 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] text-ink">{item.name}</span>
                            <span className="shrink-0 rounded border border-line px-1 text-[9.5px] text-faint">
                              {t(SOURCE_KEY[item.source])}
                            </span>
                            <span className="shrink-0 font-mono text-[9.5px] text-faint">
                              v{item.version}
                            </span>
                            {item.paid && (
                              <span className="shrink-0 rounded border border-warn/40 px-1 text-[9.5px] text-warn">
                                {t('plugin.paid')}
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono text-[9.5px] text-faint">{item.id}</div>
                        </div>
                        <button
                          type="button"
                          disabled={busy !== null || item.paid}
                          onClick={() => void installIntoApp(item.id)}
                          title={item.paid ? t('plugin.paid.tip') : undefined}
                          className="shrink-0 rounded border border-brand/50 bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand disabled:opacity-40"
                        >
                          {busy === `app:${item.id}`
                            ? item.needsDownload
                              ? t('plugin.installing.downloading')
                              : t('plugin.installing.installing')
                            : item.needsDownload
                              ? t('plugin.install.download')
                              : t('plugin.install.add')}
                        </button>
                      </div>
                      {item.description !== '' && (
                        <div className="mt-1 line-clamp-2 text-[10px] text-faint">{item.description}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {notice !== null && <div className="mt-2 text-[10px] text-muted">{notice}</div>}
        </div>
      )}
    </div>
  )
}
