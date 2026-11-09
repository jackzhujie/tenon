/**
 * 存储面板（BACKLOG 3.3）：让 `~/.tenon` 那 200MB 变成一个能看懂、也能清的数字。
 *
 * 做之前的状况：库里一直在攒（依赖、库快照、备份裸库、导出），但界面上**没有任何地方**
 * 提过这件事。用户能察觉到的只有"磁盘满了"，而那时候已经不知道该删什么。
 *
 * 四个刻意的取舍：
 * 1. **先看再删**。清理是两步：第一次点只把"要释放多少"摊出来，第二次才真删。
 *    一步到位的"清理"按钮，点错一次就是重装依赖 / 回滚不到旧版本。
 * 2. **数字不编**。依赖能给准确值（就是它的字节数）；快照只能给 `≈`（按平均值估），
 *    备份 gc 干脆不给预估 —— 这三样在界面上长得一样的话，用户会以为都在算同一件事。
 * 3. **删完给出路径**。一句"已释放 177MB"是不可核对的，而路径列表可以。
 * 4. **不可清理的东西也列出来**。代码、数据库、会话都只显示不提供按钮 ——
 *    否则"为什么不能清"会变成反复被问的问题。
 */
import { useCallback, useState } from 'react'
import type { RpcOutput } from '@tenon/protocol'
import { rpc } from '../../lib/rpc.js'
import { cn } from '../../lib/cn.js'

type Report = RpcOutput<'storage.report'>
type CategoryKey = Report['apps'][number]['categories'][number]['key']
type CleanKind = 'deps' | 'snapshots' | 'backups-gc'

const CATEGORY_LABEL: Record<CategoryKey, string> = {
  code: '代码',
  git: 'Git',
  deps: '依赖',
  database: '数据库',
  snapshots: '快照',
  exports: '导出',
  metadata: '会话',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

interface Outcome {
  freedBytes: number
  removed: string[]
  notes: string[]
}

export function StoragePanel() {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 快照保留份数：默认 3，够覆盖"最近几轮"，又不至于一份都不剩 */
  const [keep, setKeep] = useState(3)
  /** 待确认的动作；非 null 时对应按钮变成"确定释放" */
  const [confirm, setConfirm] = useState<CleanKind | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setReport(await rpc('storage.report', {}))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])


  const clean = async (kind: CleanKind): Promise<void> => {
    setBusy(true)
    setError(null)
    setOutcome(null)
    try {
      const result = await rpc('storage.clean', {
        kind,
        ...(kind === 'snapshots' ? { keep } : {}),
      })
      setOutcome({ freedBytes: result.freedBytes, removed: result.removed, notes: result.notes })
      setConfirm(null)
      // 删完立刻重新盘点：让"释放了多少"与后面的数字对得上，而不是靠一次减法猜
      setReport(await rpc('storage.report', {}))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const depsBytes = (report?.apps ?? []).reduce((sum, app) => sum + app.depsBytes, 0)
  const snapshotCount = (report?.apps ?? []).reduce((sum, app) => sum + app.snapshotCount, 0)
  const snapshotBytes = (report?.apps ?? []).reduce((sum, app) => sum + app.snapshotBytes, 0)
  /**
   * 按平均值估：报告里只有每个应用的总量与份数，没有每份的大小。
   * 逐应用算 `max(0, 份数 - 保留数) × 平均` —— 不能把"总份数"和"应用数"混在一个式子里，
   * 那是两个量纲（份 vs 个），算出来的数字看着像错的、其实就是错的。
   */
  const estimatedSnapshotFreed = (report?.apps ?? []).reduce((sum, app) => {
    const extra = Math.max(0, app.snapshotCount - keep)
    if (extra === 0) return sum
    return sum + Math.round((app.snapshotBytes / app.snapshotCount) * extra)
  }, 0)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open
          setOpen(next)
          // 打开的那一刻才去盘点：关着的时候不该为这个面板走一遍目录
          if (next && report === null) void load()
        }}
        className={cn(
          'rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-muted',
          'hover:text-ink',
        )}
        title="看看 ~/.tenon 占了多少、能清什么"
      >
        存储
        {report !== null && <span className="ml-1 text-[10px] text-faint">{formatBytes(report.totalBytes)}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-40 w-[460px] rounded-lg border border-line bg-panel p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              {/*
                说清口径：这里按**文件大小**累加，而 Finder / `du` 按块对齐算 ——
                两者差 20% 是正常的（小文件多的时候尤其明显）。不写这一句，
                用户拿 Finder 一对就会认为面板算错了。
              */}
              <div
                className="text-[11.5px] text-ink"
                title="按文件大小累加；Finder 与 du 按块对齐统计，通常会更大一些"
              >
                占用（按文件大小）
              </div>
              <div className="text-[10px] text-faint">{report?.root ?? '正在盘点…'}</div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy}
              className="rounded border border-line px-2 py-0.5 text-[10.5px] text-faint hover:text-ink disabled:opacity-40"
            >
              {busy ? '处理中…' : '重新盘点'}
            </button>
          </div>

          {error !== null && (
            <p className="mb-2 rounded border border-bad/30 bg-bad/10 px-2 py-1 text-[10.5px] text-bad">
              {error}
            </p>
          )}

          {report !== null && (
            <>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[18px] text-ink">{formatBytes(report.totalBytes)}</span>
                <span className="text-[10.5px] text-faint">
                  备份库 {formatBytes(report.backupsBytes)} · 其他 {formatBytes(report.sharedBytes)}
                </span>
              </div>

              <div className="mb-2 max-h-[210px] space-y-1.5 overflow-auto">
                {report.apps.map((app) => (
                  <div key={app.appId} className="rounded border border-line-soft/60 px-2 py-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11px] text-ink">{app.name}</span>
                      <span className="shrink-0 text-[10.5px] text-muted">{formatBytes(app.bytes)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-faint">
                      {app.categories
                        .filter((item) => item.bytes > 0)
                        .sort((a, b) => b.bytes - a.bytes)
                        .map((item) => (
                          <span key={item.key} className={item.reclaimable ? 'text-warn/80' : undefined}>
                            {CATEGORY_LABEL[item.key]} {formatBytes(item.bytes)}
                            {item.key === 'snapshots' && `（${app.snapshotCount} 份）`}
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
                {report.apps.length === 0 && (
                  <p className="px-1 py-2 text-[10.5px] text-faint">还没有应用。</p>
                )}
              </div>

              <div className="space-y-1.5 border-t border-line-soft pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10.5px] text-muted">
                    依赖（删了下一次预览会重装）
                    <span className="ml-1 text-faint">{formatBytes(depsBytes)}</span>
                  </div>
                  <button
                    type="button"
                    disabled={busy || depsBytes === 0}
                    onClick={() => (confirm === 'deps' ? void clean('deps') : setConfirm('deps'))}
                    className={cn(
                      'rounded border px-2 py-0.5 text-[10.5px] disabled:opacity-40',
                      confirm === 'deps'
                        ? 'border-warn/60 bg-warn/15 text-warn'
                        : 'border-line text-faint hover:text-ink',
                    )}
                  >
                    {confirm === 'deps' ? `确定释放 ${formatBytes(depsBytes)}？` : '清理依赖'}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10.5px] text-muted">
                    库快照
                    <span className="ml-1 text-faint">
                      {snapshotCount} 份（{formatBytes(snapshotBytes)}）· 每应用留最近
                      <select
                        value={keep}
                        onChange={(event) => {
                          setKeep(Number(event.target.value))
                          setConfirm(null)
                        }}
                        className="mx-1 rounded border border-line bg-panel-2 px-1 py-0.5 text-[10px] text-ink"
                      >
                        {[0, 1, 3, 5, 10].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                      份
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={busy || estimatedSnapshotFreed === 0}
                    onClick={() => (confirm === 'snapshots' ? void clean('snapshots') : setConfirm('snapshots'))}
                    className={cn(
                      'rounded border px-2 py-0.5 text-[10.5px] disabled:opacity-40',
                      confirm === 'snapshots'
                        ? 'border-warn/60 bg-warn/15 text-warn'
                        : 'border-line text-faint hover:text-ink',
                    )}
                    title="按平均大小估算；实际释放量以清理结果为准"
                  >
                    {confirm === 'snapshots'
                      ? `确定释放 ≈${formatBytes(estimatedSnapshotFreed)}？`
                      : `清理旧快照 ≈${formatBytes(estimatedSnapshotFreed)}`}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10.5px] text-muted">
                    备份裸库
                    <span className="ml-1 text-faint">
                      {report.backups.length} 个 · {formatBytes(report.backupsBytes)}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={busy || report.backups.length === 0}
                    onClick={() => void clean('backups-gc')}
                    className="rounded border border-line px-2 py-0.5 text-[10.5px] text-faint hover:text-ink disabled:opacity-40"
                    title="只打包松散对象，不删除任何可达提交"
                  >
                    压缩
                  </button>
                </div>

                <p className="pt-1 text-[9.5px] leading-relaxed text-faint">
                  代码、数据库、会话不做清理入口：它们是这个应用本身。
                </p>
              </div>

              {outcome !== null && (
                <div className="mt-2 rounded border border-ok/30 bg-ok/10 px-2 py-1.5 text-[10.5px] text-ok">
                  已释放 {formatBytes(outcome.freedBytes)}
                  {outcome.notes.length > 0 && (
                    <span className="text-muted">（{outcome.notes.join('；')}）</span>
                  )}
                  {outcome.removed.length > 0 && (
                    <div className="mt-1 space-y-0.5 text-[9.5px] text-faint">
                      {outcome.removed.slice(0, 3).map((path) => (
                        <div key={path} className="truncate">
                          {path}
                        </div>
                      ))}
                      {outcome.removed.length > 3 && <div>…还有 {outcome.removed.length - 3} 项</div>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
