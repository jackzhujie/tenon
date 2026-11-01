/**
 * 改动面板：一轮对话到底动了什么，以及"能不能退回去"。
 *
 * 三件事决定了它的形状：
 *
 * 1. **不卸载 iframe**。它是覆盖在预览之上的一层，不是替换 —— 换掉的话
 *    iframe 一销毁，HMR 连接断开、预览状态回到空白，看完 diff 切回去等于重启一次。
 * 2. **逐行折叠上下文**。Agent 经常整文件重写，1500 行全铺出来，用户找不到那两行差异。
 * 3. **回滚用 `revert` 语义**（历史保留），所以按钮文案不叫"撤销"，叫"回滚这一版"，
 *    确认框里明说"会生成一条新的回滚提交"。用户以为能把历史抹掉的话，后面会更困惑。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFile, GitCommit } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import {
  collapseContext,
  diffTotals,
  revertHint,
  shortPath,
  STATUS_SIGN,
} from '../../lib/diff.js'

export interface DiffPanelProps {
  commits: GitCommit[]
  selectedSha: string | null
  diff: { commit: GitCommit; files: DiffFile[] } | null
  loading: boolean
  reverting: boolean
  onSelect(sha: string): void
  onRevert(sha: string): void
  onClose(): void
}

function relativeTime(at: number): string {
  const delta = Date.now() - at
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${String(Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${String(Math.floor(delta / 3_600_000))} 小时前`
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const SIGN_CLASS: Record<DiffFile['status'], string> = {
  added: 'text-ok',
  modified: 'text-warn',
  deleted: 'text-bad',
}

/** 新增绿、删除红 —— 这是 diff 的通用约定，与行情的红涨绿跌不是一个语境 */
const ROW_CLASS: Record<'ctx' | 'add' | 'del', string> = {
  ctx: 'text-muted',
  add: 'bg-[#12241a] text-[#8fdcaa]',
  del: 'bg-[#2a1414] text-[#e89089]',
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  const [full, setFull] = useState(false)
  const rows = useMemo(
    () => (full ? collapseContext(file.lines, Number.MAX_SAFE_INTEGER) : collapseContext(file.lines)),
    [file.lines, full],
  )
  const collapsed = !full && rows.some((row) => row.kind === 'skip')

  return (
    <section className="border-b border-line-soft last:border-b-0">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line-soft bg-panel px-3 py-1.5">
        <span className={cn('font-mono text-[10.5px]', SIGN_CLASS[file.status])}>
          {STATUS_SIGN[file.status]}
        </span>
        <span className="truncate font-mono text-[11.5px] text-ink" title={file.path}>
          {shortPath(file.path)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10.5px]">
          {file.insertions > 0 && <span className="text-ok">+{file.insertions}</span>}
          {file.deletions > 0 && <span className="text-bad">-{file.deletions}</span>}
          {collapsed && (
            <button
              type="button"
              onClick={() => setFull(true)}
              className="text-faint hover:text-muted"
              title="展开整个文件"
            >
              全文
            </button>
          )}
        </span>
      </header>

      {file.binary === true && (
        <p className="px-3 py-2 text-[11.5px] text-faint">二进制文件，不做逐行比较</p>
      )}
      {file.truncated === true && (
        <p className="px-3 py-2 text-[11.5px] text-faint">文件太大，已省略逐行比较</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
            <tbody>
              {rows.map((row, index) =>
                row.kind === 'skip' ? (
                  <tr key={`skip-${String(index)}`} className="bg-panel-2/60">
                    <td colSpan={3} className="px-3 py-0.5 text-[10.5px] text-faint">
                      ⋯ 跳过 {row.count} 行
                    </td>
                  </tr>
                ) : (
                  <tr key={`${String(row.oldLine ?? 'x')}-${String(row.newLine ?? 'x')}-${String(index)}`} className={ROW_CLASS[row.kind]}>
                    <td className="w-10 select-none border-r border-line-soft/60 pr-1.5 text-right align-top text-[10.5px] text-faint">
                      {row.oldLine ?? ''}
                    </td>
                    <td className="w-10 select-none border-r border-line-soft/60 pr-1.5 text-right align-top text-[10.5px] text-faint">
                      {row.newLine ?? ''}
                    </td>
                    <td className="whitespace-pre-wrap break-all pl-2 pr-3">
                      {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                      {row.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function DiffPanel({
  commits,
  selectedSha,
  diff,
  loading,
  reverting,
  onSelect,
  onRevert,
  onClose,
}: DiffPanelProps) {
  const totals = diff === null ? null : diffTotals(diff.files)
  const scroller = useRef<HTMLDivElement | null>(null)
  // 回滚要点两下。不用 window.confirm：Electron 里它会阻塞渲染进程，
  // 而这条链路后面还挂着"回滚完刷新提交列表"的异步动作
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    setConfirming(null)
  }, [selectedSha])

  // 换一版就把内容滚回顶部，否则会停在上一个文件的中段，看起来像"没切换"
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [selectedSha])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const active = diff !== null && diff.commit.sha === selectedSha

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft bg-panel/60 px-3">
        <span className="text-[11.5px] text-muted">改动</span>
        {totals !== null && (
          <span className="flex items-center gap-1.5 font-mono text-[10.5px]">
            <span className="text-faint">{totals.files} 个文件</span>
            <span className="text-ok">+{totals.insertions}</span>
            <span className="text-bad">-{totals.deletions}</span>
          </span>
        )}
        {loading && <span className="text-[10.5px] text-faint">读取中…</span>}

        <span className="ml-auto flex items-center gap-1">
          {diff !== null && confirming !== diff.commit.sha && (
            <Button
              variant="outline"
              size="sm"
              disabled={reverting}
              title={revertHint(diff.commit.sha, diff.commit.message)}
              onClick={() => setConfirming(diff.commit.sha)}
            >
              回滚这一版
            </Button>
          )}
          {diff !== null && confirming === diff.commit.sha && (
            <>
              <span className="text-[11px] text-warn">
                回滚会写一条新提交（历史保留），确定？
              </span>
              <Button
                variant="danger"
                size="sm"
                disabled={reverting}
                onClick={() => {
                  setConfirming(null)
                  onRevert(diff.commit.sha)
                }}
              >
                {reverting ? '回滚中…' : '确定回滚'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                取消
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="px-1.5" title="关闭（Esc）" onClick={onClose}>
            ✕
          </Button>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-line-soft bg-panel/40">
          <p className="shrink-0 px-3 py-1.5 text-[10.5px] text-faint">版本（点一条看它改了什么）</p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {commits.length === 0 && (
              <p className="px-3 py-2 text-[11.5px] text-faint">还没有提交</p>
            )}
            {commits.map((commit, index) => (
              <button
                key={commit.sha}
                type="button"
                onClick={() => onSelect(commit.sha)}
                className={cn(
                  'block w-full border-l-2 px-2.5 py-1.5 text-left transition-colors',
                  commit.sha === selectedSha
                    ? 'border-l-brand bg-brand-dim/40'
                    : 'border-l-transparent hover:bg-panel-2',
                )}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[10.5px] text-muted">{commit.sha.slice(0, 7)}</span>
                  {index === 0 && <span className="text-[9.5px] text-brand-soft">最新</span>}
                  <span className="ml-auto text-[10px] text-faint">{relativeTime(commit.at)}</span>
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-ink/85" title={commit.message}>
                  {commit.message.split('\n')[0]}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {active && totals !== null && totals.files === 0 && (
            <p className="px-4 py-6 text-[12px] text-faint">这一版没有文件改动。</p>
          )}
          {active && diff.files.map((file) => <DiffFileBlock key={file.path} file={file} />)}
          {!active && !loading && (
            <p className="px-4 py-6 text-[12px] text-faint">从左边选一个版本。</p>
          )}
        </div>
      </div>
    </div>
  )
}
