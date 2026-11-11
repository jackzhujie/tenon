/**
 * 用量与额度（M4 第 3 步）。
 *
 * 顶栏上一个小数字，点开是这个应用的账：累计多少、这一轮多少、按模型分几档，
 * 以及额度表单。放顶栏而不是放预览下方，是因为**它不是任务状态**：
 * 空闲时也要看得见（"这个应用总共花了多少"随时都可能想知道），
 * 而任务条空闲时是不渲染的。
 *
 * 三个刻意的取舍：
 *
 * 1. **数字全部来自服务端快照**，前端不累加。子 Agent 的消耗不经过父会话的事件流，
 *    压缩摘要更是连 entry 都没有 —— 前端累加必然少一半。
 * 2. **额度在这里设，不另开设置页。** 看到"已经花了多少"的地方就是最想改上限的地方。
 * 3. **`usage` 为 null 时不显示数字**（还没拉到），而不是显示 0 ——
 *    0 会被读成"没花钱"，那是错的。
 */
import { useEffect, useRef, useState } from 'react'
import type { BudgetDimension, RpcOutput, UsageAppUsage, UsageSnapshot, UsageTotals } from '@tenon/protocol'
import { useT } from '../../lib/i18n.js'
import type { UsageKey } from '../../lib/messages/usage.js'
import type { TFunction } from '../../lib/i18n.js'
// 走 `/browser` 子路径：主入口会把整张 zod 表带进产物（见 protocol/browser.ts 的说明）
import { budgetMessage, formatCost, formatTokens } from '@tenon/protocol/browser'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import { rpc } from '../../lib/rpc.js'
import type { Outcome } from '../../hooks/useWorkspace.js'

/** `usage.total` 的返回（跨应用汇总）。只列面板要用的四格 */
interface UsageTotal {
  totals: UsageTotals
  apps: UsageAppUsage[]
  failed: Array<{ appId: string; name: string; error: string }>
  priced: boolean
}

const DOT_CLASS: Record<UsageSnapshot['level'], string> = {
  ok: 'bg-line',
  warn: 'bg-warn',
  over: 'bg-bad',
}

const LEVEL_KEY: Record<UsageSnapshot['level'], UsageKey> = {
  ok: 'usage.level.ok',
  warn: 'usage.level.warn',
  over: 'usage.level.over',
}

/** 空 = 不设限；负数/非数字 = 填错了 */
function parseLimit(raw: string): number | null | 'bad' {
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : 'bad'
}

/** 额度那一行的展示：没设就说"不设限"，别显示一个假的 0 */
function limitText(limit: number | null, format: (value: number) => string, t: TFunction): string {
  return limit === null ? t('common.unlimited') : format(limit)
}

export interface UsagePanelProps {
  usage: UsageSnapshot | null
  /** 这一轮被哪个维度掐了（`budget.exceeded` 事件）。非 null 时横幅以它为准 */
  stopped: BudgetDimension | null
  /** 没选中应用时禁用 */
  disabled: boolean
  onSetBudget(maxCostUsd: number | null, maxTokens: number | null): Promise<Outcome>
}

export function UsagePanel({ usage, stopped, disabled, onSetBudget }: UsagePanelProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [tokensInput, setTokensInput] = useState('')
  const [costInput, setCostInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 跨应用汇总（v1.2.17）。`null` = 还没拉到 —— 与"合计是 0"分开 */
  const [total, setTotal] = useState<UsageTotal | null>(null)
  const [totalError, setTotalError] = useState<string | null>(null)
  /*
   * 全局额度（两道闸）。输入框初值从 `budget.global` 拉，**不跟着 usage 变化重置** ——
   * 全局数变得不频繁，而每次模型回包都清一次输入框会让人没法填。
   */
  const [global, setGlobal] = useState<RpcOutput<'budget.global'> | null>(null)
  /*
   * 界面上只暴露**美元**。token 那两个维度仍在协议里（`Budget` 复用），只是不给入口 ——
   * 用户估不出"我这个月能花多少 token"，给了只会乱填；而单应用那边留着 token 栏
   * 是因为 faux 报 0 美元，只设钱没法验熔断。
   */
  const [gMonthlyCost, setGMonthlyCost] = useState('')
  const [gLifetimeCost, setGLifetimeCost] = useState('')
  const [gSaving, setGSaving] = useState(false)
  const [gError, setGError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // 每次打开都从当前额度重新起稿：上次没保存的输入不该留下来（会被误当成已生效）
  useEffect(() => {
    if (!open) return
    setTokensInput(usage?.budget.maxTokens?.toString() ?? '')
    setCostInput(usage?.budget.maxCostUsd?.toString() ?? '')
    setError(null)
  }, [open, usage])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /*
   * 每次打开都拉一次汇总。依赖里带 `usage`：本应用的量一变（一轮跑完），
   * 合计也该跟着变 —— 否则面板上"本应用"动了、"全部应用"不动，看着像 bug。
   * 服务端有 15s 缓存，所以这里多拉几次不会真的去扫 N 个库。
   */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTotalError(null)
    void rpc('usage.total', {})
      .then((value) => {
        if (!cancelled) setTotal(value as UsageTotal)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setTotalError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open, usage])

  // 全局额度：只在打开时拉一次。它不随每一轮变化（本月已用由服务端现算），
  // 所以没必要跟着 `usage` 反复请求
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void rpc('budget.global', {})
      .then((value) => {
        if (cancelled) return
        setGlobal(value)
        setGMonthlyCost(value.budget.monthly.maxCostUsd?.toString() ?? '')
        setGLifetimeCost(value.budget.lifetime.maxCostUsd?.toString() ?? '')
      })
      .catch((cause: unknown) => {
        if (!cancelled) setGError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const level = usage?.level ?? 'ok'
  const chip = usage === null ? t('usage.chip') : formatTokens(usage.totals.totalTokens)
  /*
   * 没配价格时**不能显示 $0.00**：那不是"便宜"，是"没算"。用户看到 $0 会以为
   * 离额度还很远，于是拿它当保护伞 —— 这是这个面板最容易骗人的一格。
   */
  const cost =
    usage === null ? '' : usage.priced ? formatCost(usage.totals.costUsd) : t('usage.unpriced')
  const costOf = (usd: number): string => (usage?.priced === true ? formatCost(usd) : t('usage.unpriced'))

  /*
   * 解释横幅看 `exceeded`，不只认事件。
   *
   * `budget.exceeded` 只在"跑到一半真的被掐停"时才会来；而用户完全可能
   * 手动把上限调到比已用量还低（那一刻没有人被掐），这时服务端快照里的
   * `exceeded` 已经不为 null —— 面板必须也解释一句，否则用户只看到一个红点，
   * 不知道"现在发不出去了"。事件带来的 `stopped` 优先，因为它指明是谁先撞的线。
   */
  const stoppedDim: BudgetDimension | null = stopped ?? usage?.exceeded ?? null

  async function save(): Promise<void> {
    const tokens = parseLimit(tokensInput)
    const limit = parseLimit(costInput)
    if (tokens === 'bad' || limit === 'bad') {
      setError(t('usage.error.limit'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const outcome = await onSetBudget(limit, tokens)
      if (outcome.ok) setOpen(false)
      else setError(outcome.message)
    } finally {
      setSaving(false)
    }
  }

  async function saveGlobal(): Promise<void> {
    const monthly = parseLimit(gMonthlyCost)
    const lifetime = parseLimit(gLifetimeCost)
    if (monthly === 'bad' || lifetime === 'bad') {
      setGError(t('usage.error.limit'))
      return
    }
    setGSaving(true)
    setGError(null)
    try {
      await rpc('budget.global.set', {
        // token 两维原样保留（界面上没有入口），只改钱，不要把已有的 token 闸冲掉
        monthly: { maxCostUsd: monthly, maxTokens: global?.budget.monthly.maxTokens ?? null },
        lifetime: { maxCostUsd: lifetime, maxTokens: global?.budget.lifetime.maxTokens ?? null },
      })
      // 以服务端回读的为准：它会把负数 / NaN 规整成 null，输入框跟着对齐
      const fresh = await rpc('budget.global', {})
      setGlobal(fresh)
      setGMonthlyCost(fresh.budget.monthly.maxCostUsd?.toString() ?? '')
      setGLifetimeCost(fresh.budget.lifetime.maxCostUsd?.toString() ?? '')
    } catch (cause) {
      setGError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGSaving(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        /* 截图与端到端靠它定位：这个按钮的文案是数字，没法按文字选 */
        data-tenon-usage-trigger
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors',
          'hover:bg-panel-3 disabled:cursor-not-allowed disabled:opacity-40',
          open && 'bg-panel-3',
        )}
        title={usage === null ? t('usage.tip.app') : t('usage.tip.cumulative', { tokens: chip, cost })}
      >
        <span className={cn('size-1.5 rounded-full', DOT_CLASS[level], level === 'over' && 'tenon-pulse')} />
        <span
          className={cn(
            'font-mono text-[10.5px] tabular-nums',
            level === 'over' ? 'text-bad' : level === 'warn' ? 'text-warn' : 'text-faint',
          )}
        >
          {chip}
        </span>
        {cost !== '' && cost !== '$0' && (
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{cost}</span>
        )}
      </button>

      {open && (
        /*
         * `right-0` 而不是 `left-0`：这个 chip 就在顶栏最右边，往右展开会直接顶出窗口
         * （实测：面板右侧那一列数字全在可视区外，看起来像"数字没显示"）。
         */
        <div className="absolute top-full right-0 z-40 mt-1 w-72 overflow-hidden rounded-lg border border-line bg-panel-2 shadow-xl shadow-black/40">
          <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
            <span className="text-[12px] text-ink">{t('usage.title')}</span>
            {usage !== null && (
              <span
                className={cn(
                  'ml-auto rounded-full px-1.5 py-px text-[10px] leading-4',
                  level === 'over'
                    ? 'bg-bad/15 text-bad'
                    : level === 'warn'
                      ? 'bg-warn/15 text-warn'
                      : 'bg-panel-3 text-faint',
                )}
              >
                {t(LEVEL_KEY[level])}
              </span>
            )}
          </div>

          {stoppedDim !== null && usage !== null && (
            <p className="border-b border-line-soft bg-bad/10 px-3 py-2 text-[11.5px] leading-4 text-bad">
              {budgetMessage(usage.totals, usage.budget, stoppedDim)}
            </p>
          )}

          {/* 全部应用：跨应用汇总。放最上面，因为"我到底花了多少"是打开这个面板的第一个问题 */}
          <div className="space-y-1 border-b border-line-soft px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[11.5px] text-muted">{t('usage.allApps')}</span>
              <span className="ml-auto font-mono text-[11.5px] tabular-nums text-ink">
                {total === null
                  ? totalError === null
                    ? '…'
                    : '—'
                  : `${formatTokens(total.totals.totalTokens)} · ${total.priced ? formatCost(total.totals.costUsd) : t('usage.unpriced')}`}
              </span>
            </div>
            {total !== null &&
              total.apps.slice(0, 4).map((app) => (
                <AppRow
                  key={app.appId}
                  app={app}
                  priced={total.priced}
                  current={app.appId === usage?.appId}
                />
              ))}
            {total !== null && total.apps.length > 4 && (
              <p className="text-[10px] text-faint">…另有 {total.apps.length - 4} 个应用</p>
            )}
            {total !== null && total.failed.length > 0 && (
              <p className="text-[10px] leading-4 text-warn">
                {total.failed.length} 个应用的账本读不到（没算进合计）：{total.failed.map((item) => item.name).join('、')}
              </p>
            )}
            {total !== null && total.apps.every((app) => !app.known) && total.apps.length > 0 && (
              <p className="text-[10px] leading-4 text-faint">{t('usage.noLedger')}</p>
            )}
            {totalError !== null && (
              <p className="text-[10px] leading-4 text-warn">读不到汇总：{totalError}</p>
            )}
          </div>

          <div className="space-y-1 px-3 py-2">
            <Row label={t('usage.row.appTotal')} value={usage === null ? '—' : `${chip} · ${cost}`} />
            <Row
              label={t('usage.row.thisTurn')}
              value={
                usage === null
                  ? '—'
                  : `${formatTokens(usage.turn.totalTokens)} · ${costOf(usage.turn.costUsd)}`
              }
            />
            {usage !== null &&
              Object.entries(usage.models).map(([model, totals]) => (
                <Row
                  key={model}
                  label={model}
                  muted
                  value={`${formatTokens(totals.totalTokens)} · ${costOf(totals.costUsd)}`}
                />
              ))}
          </div>

          <div className="border-t border-line-soft px-3 py-2">
            <p className="mb-1.5 text-[11px] text-faint">
              额度（用完就不让再发；留空 = 不设限）
            </p>
            <label className="flex items-center gap-2 py-0.5 text-[11.5px] text-muted">
              <span className="w-20 shrink-0">token</span>
              <input
                value={tokensInput}
                onChange={(event) => setTokensInput(event.target.value)}
                inputMode="numeric"
                placeholder={t('common.unlimited')}
                className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 font-mono text-[11.5px] text-ink placeholder:text-faint/60 focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {limitText(usage?.budget.maxTokens ?? null, formatTokens, t)}
              </span>
            </label>
            <label className="flex items-center gap-2 py-0.5 text-[11.5px] text-muted">
              <span className="w-20 shrink-0">{t('usage.unit.usd')}</span>
              <input
                value={costInput}
                onChange={(event) => setCostInput(event.target.value)}
                inputMode="decimal"
                placeholder={t('common.unlimited')}
                className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 font-mono text-[11.5px] text-ink placeholder:text-faint/60 focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {limitText(usage?.budget.maxCostUsd ?? null, formatCost, t)}
              </span>
            </label>

            {error !== null && <p className="mt-1.5 text-[11px] leading-4 text-bad">{error}</p>}

            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setTokensInput('')
                  setCostInput('')
                }}
              >
                {t('common.clear')}
              </Button>
              <span className="ml-auto text-[10px] text-faint">
                {t('usage.note.server')}
              </span>
            </div>
          </div>

          {/*
            全局额度：所有应用加起来。放在单应用额度**下面**，因为它是更大的那个圈 ——
            先看"这个应用花了多少"，再看"总共花了多少"。
          */}
          <div className="border-t border-line-soft px-3 py-2">
            <p className="mb-1.5 text-[11px] text-faint">
              {t('usage.global.title')}
            </p>

            <label className="flex items-center gap-2 py-0.5 text-[11.5px] text-muted">
              <span className="w-20 shrink-0">{t('usage.global.monthly')}</span>
              <input
                value={gMonthlyCost}
                onChange={(event) => setGMonthlyCost(event.target.value)}
                inputMode="decimal"
                placeholder={t('common.unlimited')}
                data-tenon-global-monthly
                className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 font-mono text-[11.5px] text-ink placeholder:text-faint/60 focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {global === null ? '' : t('usage.global.monthUsed', { cost: formatCost(global.monthUsed.costUsd) })}
              </span>
            </label>

            <label className="flex items-center gap-2 py-0.5 text-[11.5px] text-muted">
              <span className="w-20 shrink-0">{t('usage.global.totalCap')}</span>
              <input
                value={gLifetimeCost}
                onChange={(event) => setGLifetimeCost(event.target.value)}
                inputMode="decimal"
                placeholder={t('common.unlimited')}
                data-tenon-global-lifetime
                className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 font-mono text-[11.5px] text-ink placeholder:text-faint/60 focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {global === null ? '' : t('usage.global.totalUsed', { cost: formatCost(global.totalUsed.costUsd) })}
              </span>
            </label>

            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              {t('usage.global.note.before')}
            <span className="text-muted">{t('usage.global.note.emphasis')}</span>
              {t('usage.global.note.after')}
              {global !== null && global.unreadable > 0 && (
                <span className="text-warn">
                  {' '}
                  有 {global.unreadable} 个应用账本读不到，那两个数里不含它们。
                </span>
              )}
            </p>

            {gError !== null && <p className="mt-1.5 text-[11px] leading-4 text-bad">{gError}</p>}

            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="primary" disabled={gSaving} onClick={() => void saveGlobal()}>
                {gSaving ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={gSaving}
                onClick={() => {
                  setGMonthlyCost('')
                  setGLifetimeCost('')
                }}
              >
                {t('common.clear')}
              </Button>
              <span className="ml-auto text-[10px] text-faint">{t('usage.global.emptyHint')}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 汇总里的一行。`known: false` 显示"还没跑过"而不是 `0` ——
 * 0 会被读成"用了但没花钱"，而这两种状态要用户做的事完全不同。
 */
function AppRow({
  app,
  priced,
  current,
}: {
  app: UsageAppUsage
  priced: boolean
  current: boolean
}) {
  const { t } = useT()
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className={cn('size-1 shrink-0 rounded-full', DOT_CLASS[app.level])} />
      <span className={cn('min-w-0 flex-1 truncate', current ? 'text-brand-soft' : 'text-muted')}>
        {app.name}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
        {app.known
                  ? `${formatTokens(app.totals.totalTokens)} · ${priced ? formatCost(app.totals.costUsd) : t('usage.unpriced')}`
                  : t('usage.notRun')}
      </span>
    </div>
  )
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-[11.5px]">
      <span className={cn('min-w-0 flex-1 truncate', muted ? 'font-mono text-[10.5px] text-faint' : 'text-muted')}>
        {label}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">{value}</span>
    </div>
  )
}
