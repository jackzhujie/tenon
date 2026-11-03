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
import type { BudgetDimension, UsageSnapshot } from '@tenon/protocol'
// 走 `/browser` 子路径：主入口会把整张 zod 表带进产物（见 protocol/browser.ts 的说明）
import { budgetMessage, formatCost, formatTokens } from '@tenon/protocol/browser'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import type { Outcome } from '../../hooks/useWorkspace.js'

const DOT_CLASS: Record<UsageSnapshot['level'], string> = {
  ok: 'bg-line',
  warn: 'bg-warn',
  over: 'bg-bad',
}

const LEVEL_TEXT: Record<UsageSnapshot['level'], string> = {
  ok: '正常',
  warn: '快用完了',
  over: '已用完',
}

/** 空 = 不设限；负数/非数字 = 填错了 */
function parseLimit(raw: string): number | null | 'bad' {
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : 'bad'
}

/** 额度那一行的展示：没设就说"不设限"，别显示一个假的 0 */
function limitText(limit: number | null, format: (value: number) => string): string {
  return limit === null ? '不设限' : format(limit)
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
  const [open, setOpen] = useState(false)
  const [tokensInput, setTokensInput] = useState('')
  const [costInput, setCostInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

  const level = usage?.level ?? 'ok'
  const chip = usage === null ? '用量' : formatTokens(usage.totals.totalTokens)
  /*
   * 没配价格时**不能显示 $0.00**：那不是"便宜"，是"没算"。用户看到 $0 会以为
   * 离额度还很远，于是拿它当保护伞 —— 这是这个面板最容易骗人的一格。
   */
  const cost =
    usage === null ? '' : usage.priced ? formatCost(usage.totals.costUsd) : '未定价'
  const costOf = (usd: number): string => (usage?.priced === true ? formatCost(usd) : '未定价')

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
      setError('上限要填一个不小于 0 的数；留空 = 这条不设限')
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors',
          'hover:bg-panel-3 disabled:cursor-not-allowed disabled:opacity-40',
          open && 'bg-panel-3',
        )}
        title={usage === null ? '这个应用的用量' : `累计 ${chip} tokens · ${cost}；点开设额度`}
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
            <span className="text-[12px] text-ink">用量与额度</span>
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
                {LEVEL_TEXT[level]}
              </span>
            )}
          </div>

          {stoppedDim !== null && usage !== null && (
            <p className="border-b border-line-soft bg-bad/10 px-3 py-2 text-[11.5px] leading-4 text-bad">
              {budgetMessage(usage.totals, usage.budget, stoppedDim)}
            </p>
          )}

          <div className="space-y-1 px-3 py-2">
            <Row label="本应用累计" value={usage === null ? '—' : `${chip} · ${cost}`} />
            <Row
              label="这一轮"
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
                placeholder="不设限"
                className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 font-mono text-[11.5px] text-ink placeholder:text-faint/60 focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {limitText(usage?.budget.maxTokens ?? null, formatTokens)}
              </span>
            </label>
            <label className="flex items-center gap-2 py-0.5 text-[11.5px] text-muted">
              <span className="w-20 shrink-0">美元</span>
              <input
                value={costInput}
                onChange={(event) => setCostInput(event.target.value)}
                inputMode="decimal"
                placeholder="不设限"
                className="h-6 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 font-mono text-[11.5px] text-ink placeholder:text-faint/60 focus:border-brand/60 focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {limitText(usage?.budget.maxCostUsd ?? null, formatCost)}
              </span>
            </label>

            {error !== null && <p className="mt-1.5 text-[11px] leading-4 text-bad">{error}</p>}

            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '保存'}
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
                清空
              </Button>
              <span className="ml-auto text-[10px] text-faint">
                真值在服务端，重启不丢
              </span>
            </div>
          </div>
        </div>
      )}
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
