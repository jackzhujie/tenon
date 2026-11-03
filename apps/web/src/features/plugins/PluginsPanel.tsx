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
import type { AvailableComponent, ComponentProblem, InstalledComponent } from '@tenon/protocol'
import { rpc } from '../../lib/rpc.js'
import { cn } from '../../lib/cn.js'

interface ComponentList {
  components: InstalledComponent[]
  problems: ComponentProblem[]
  available: AvailableComponent[]
  tenonVersion: string
}

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

  const load = useCallback(async (): Promise<void> => {
    if (appId === null) return
    try {
      const list = await rpc('component.list', { appId })
      setData(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [appId])

  useEffect(() => {
    if (!open) return
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

          <div className="mt-2 border-t border-line pt-2 text-[10px] text-faint">
            官方 Hub 筹备中：内置组件跟随软件版本更新，Hub 上线后可单独下载与热更新。
          </div>
        </div>
      )}
    </div>
  )
}
