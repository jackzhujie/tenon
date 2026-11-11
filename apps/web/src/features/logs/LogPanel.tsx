/**
 * 运行日志面板（M2 错误面板的界面一半）。
 *
 * 存在的理由：预览起不来时，用户看到的是「启动失败」四个字，而真正的原因在
 * dev server / Nest 的 stderr 里。在这一步之前，那些输出只活在服务端的环形缓冲里，
 * 只有写代码的人 `/tmp` 里翻得到 —— 面板把它搬到界面上。
 *
 * 三个刻意的取舍：
 *
 * 1. **默认收起，但一有 error 就自己展开**。常驻半个屏幕的日志栏会挤掉预览；
 *    而报错发生时用户最需要看到它，那时候自动展开是对的。
 * 2. **同一条合并成 `×N`**。React 渲染里抛错最常见的形态是无限刷同一句，
 *    不做合并的话面板会瞬间冲到几百条，把有用的第一条挤出去。
 * 3. **`detail`（堆栈）点开才看**。摘要要能一眼扫完；堆栈是给人复制去搜的。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogLevel, LogSource } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import { ChevronDownIcon } from '../../components/icons.js'
import { cn } from '../../lib/cn.js'
import { buildLogPrompt } from '../../lib/log-prompt.js'
import { useT } from '../../lib/i18n.js'
import type { LogsKey } from '../../lib/messages/logs.js'

const SOURCE_KEY: Record<LogSource, LogsKey> = {
  web: 'log.source.web',
  api: 'log.source.api',
  vite: 'log.source.vite',
  db: 'log.source.db',
  tenon: 'log.source.tenon',
}

/** 颜色只做很轻的区分：日志的主体是文字，不是色块 */
const SOURCE_CLASS: Record<LogSource, string> = {
  web: 'text-brand-soft',
  api: 'text-[#8fb8e0]',
  vite: 'text-[#b6a2d8]',
  db: 'text-[#7fc8b8]',
  tenon: 'text-faint',
}

const LEVEL_DOT: Record<LogLevel, string> = {
  debug: 'bg-faint',
  info: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-bad',
}

const SOURCES: LogSource[] = ['web', 'api', 'vite', 'db', 'tenon']

type LevelFilter = 'all' | 'warn' | 'error'

const FILTER_KEY: Record<LevelFilter, LogsKey> = {
  all: 'log.filter.all',
  warn: 'log.filter.warn',
  error: 'log.filter.error',
}

function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function rankOf(level: LogLevel): number {
  return level === 'error' ? 3 : level === 'warn' ? 2 : level === 'info' ? 1 : 0
}

export interface LogPanelProps {
  appId: string | null
  logs: LogEntry[]
  onClear(): void
  /**
   * 把一条错误日志（含前后几行上下文）交给对话去修。
   *
   * 为什么是"塞进输入框"而不是直接发送：用户往往想补一句"别动样式，只修这个"。
   * 拼好的文本见 `lib/log-prompt.ts`，面板只负责搬运。
   */
  onAskFix?(text: string): void
}

export function LogPanel({ appId, logs, onClear, onAskFix }: LogPanelProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [hiddenSources, setHiddenSources] = useState<LogSource[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const seenErrorRef = useRef(0)

  const errorCount = useMemo(() => logs.filter((entry) => entry.level === 'error').length, [logs])

  // 冒出新错误就展开一次。收起状态下也要能被告知 —— 这正是面板的意义。
  useEffect(() => {
    if (errorCount > seenErrorRef.current) setOpen(true)
    seenErrorRef.current = errorCount
  }, [errorCount])

  // 换应用：收起 + 清掉展开态，别让上一个应用的堆栈留在这里
  useEffect(() => {
    setExpandedId(null)
    setOpen(false)
    seenErrorRef.current = 0
  }, [appId])

  const visible = useMemo(() => {
    const minRank = levelFilter === 'all' ? 0 : levelFilter === 'warn' ? 2 : 3
    return logs.filter((entry) => {
      if (hiddenSources.includes(entry.source)) return false
      return rankOf(entry.level) >= minRank
    })
  }, [logs, levelFilter, hiddenSources])

  // 贴底：只在已经贴底时跟随，用户往上翻的时候不要把他拽回来
  const pinnedRef = useRef(true)
  useEffect(() => {
    const node = listRef.current
    if (!open || node === null || !pinnedRef.current) return
    node.scrollTop = node.scrollHeight
  }, [visible, open])

  const last = visible.at(-1)

  return (
    <div className="flex shrink-0 flex-col border-t border-line-soft bg-panel/40">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1.5 text-[11.5px] text-muted hover:text-ink"
          title={open ? t('log.collapse') : t('log.expand')}
        >
          <ChevronDownIcon
            className={cn('size-3 transition-transform', open ? 'rotate-0' : '-rotate-90')}
          />
          {t('log.title')}
        </button>

        {errorCount > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px] leading-4',
              'bg-bad/15 text-bad',
            )}
            title={t('log.errors', { count: errorCount })}
          >
            {errorCount} 错误
          </span>
        )}

        {!open && last !== undefined && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
            {last.message}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1">
          {open && (
            <>
              <span className="flex items-center gap-0.5">
                {SOURCES.map((source) => {
                  const off = hiddenSources.includes(source)
                  return (
                    <button
                      key={source}
                      type="button"
                      onClick={() =>
                        setHiddenSources((current) =>
                          current.includes(source)
                            ? current.filter((item) => item !== source)
                            : [...current, source],
                        )
                      }
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] leading-4 transition-colors',
                        off ? 'text-faint/50 hover:text-muted' : cn('bg-panel-2', SOURCE_CLASS[source]),
                      )}
                      title={off
                        ? t('log.showSource', { source: t(SOURCE_KEY[source]) })
                        : t('log.hideSource', { source: t(SOURCE_KEY[source]) })}
                    >
                      {t(SOURCE_KEY[source])}
                    </button>
                  )
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  setLevelFilter((current) =>
                    current === 'all' ? 'warn' : current === 'warn' ? 'error' : 'all',
                  )
                }
                className="rounded px-1.5 py-0.5 text-[10px] leading-4 text-faint hover:text-muted"
                title={t('log.raiseFilter')}
              >
                {t(FILTER_KEY[levelFilter])}
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5 text-[10.5px] text-faint hover:text-ink"
                onClick={onClear}
                disabled={logs.length === 0}
                title={t('log.clearTitle')}
              >
                {t('log.clear')}
              </Button>
            </>
          )}
        </span>
      </div>

      {open && (
        <div
          ref={listRef}
          onScroll={(event) => {
            const node = event.currentTarget
            pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          }}
          className="h-52 overflow-y-auto border-t border-line-soft/70 font-mono text-[11px]"
        >
          {visible.length === 0 && (
            <p className="px-3 py-4 text-[11.5px] text-faint">
              {logs.length === 0
                ? t('log.empty.never')
                : t('log.empty.filtered')}
            </p>
          )}

          {visible.map((entry) => {
            const expanded = expandedId === entry.id
            const hasDetail = entry.detail !== null
            return (
              <div
                key={entry.id}
                className={cn(
                  'group flex items-start gap-1 border-b border-line-soft/40 pr-2 last:border-0',
                  entry.level === 'error' && 'bg-bad/[0.06]',
                )}
              >
                {/*
                 * 可点区是**里面的 button**，不是整行：右侧还要放一个「发给 Agent」，
                 * button 里不能套 button（HTML 不允许，点了也不会有预期的行为）。
                 */}
                <button
                  type="button"
                  disabled={!hasDetail}
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className={cn(
                    'flex min-w-0 flex-1 items-start gap-2 py-1 pl-3 text-left',
                    hasDetail ? 'hover:bg-panel-2/70' : 'cursor-default',
                  )}
                >
                  <span className="shrink-0 pt-px text-[10px] tabular-nums text-faint">
                    {clockOf(entry.at)}
                  </span>
                  <span
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      LEVEL_DOT[entry.level],
                    )}
                  />
                  <span className={cn('shrink-0 text-[10px] leading-5', SOURCE_CLASS[entry.source])}>
                    {t(SOURCE_KEY[entry.source])}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 whitespace-pre-wrap break-words leading-5',
                      entry.level === 'error' ? 'text-bad/90' : 'text-muted',
                    )}
                  >
                    {entry.message}
                  </span>
                  {entry.repeat > 1 && (
                    <span className="shrink-0 leading-5 text-faint">×{entry.repeat}</span>
                  )}
                </button>

                {entry.level === 'error' && onAskFix !== undefined && (
                  <button
                    type="button"
                    onClick={() => onAskFix(buildLogPrompt(logs, entry, t))}
                    /*
                     * **常显**，不做 hover 才出现：错误行的价值就是"这一下能点"，
                     * 藏起来等于没有（用户第一反应就是"点了没反应"）。
                     */
                    className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-4 text-faint transition-colors hover:bg-bad/15 hover:text-bad"
                    title={t('log.askFix.title')}
                  >
                    {t('log.askFix.button')}
                  </button>
                )}

                {expanded && entry.detail !== null && (
                  <pre className="mx-3 mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-line-soft bg-[#0a0908] px-2 py-1.5 text-[10.5px] leading-relaxed text-faint">
                    {entry.detail}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
