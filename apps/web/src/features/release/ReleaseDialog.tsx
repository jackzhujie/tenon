/**
 * 发布对话框。
 *
 * 这里要讲清的一件事：**"发布"在当前阶段到底交付了什么**。
 * 它没有把应用推上线（那要 Docker / 静态部署，还没做），而是把一个 commit 冻结成版本，
 * 推到本地备份库（一个标准裸库，`git clone` 出来就是这一版的完整代码）。
 * 与其含糊地说"发布成功"，不如在界面上把路径和 clone 命令直接给出来 —— 用户能自己验证。
 */
import { useEffect, useState } from 'react'
import type { GitCommit, Release } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import type { PublishOutcome, PublishResult } from '../../hooks/useWorkspace.js'

function stampOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 复制到剪贴板。失败不抛 —— 复制不了还能手动选中路径 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 px-1.5 text-[11px]"
      onClick={() => {
        void copy(text).then((ok) => setCopied(ok))
      }}
    >
      {copied ? '已复制' : label}
    </Button>
  )
}

export interface ReleaseDialogProps {
  open: boolean
  appName: string | null
  /** 当前 HEAD，发布的就是它 */
  headCommit: GitCommit | null
  releases: Release[]
  publishing: boolean
  onClose(): void
  onPublish(notes: string): Promise<PublishOutcome>
}

export function ReleaseDialog({
  open,
  appName,
  headCommit,
  releases,
  publishing,
  onClose,
  onPublish,
}: ReleaseDialogProps) {
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)

  // 每次打开都从干净状态开始：上次的"发布成功"卡片留着，会让人以为这次也发过了
  useEffect(() => {
    if (!open) return
    setNotes('')
    setError(null)
    setResult(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !publishing) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, publishing, onClose])

  if (!open) return null

  const submit = async (): Promise<void> => {
    if (publishing) return
    setError(null)
    const outcome = await onPublish(notes)
    if (outcome.ok) setResult(outcome.result)
    else setError(outcome.message)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !publishing) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-title"
        className="flex max-h-full w-full max-w-lg flex-col rounded-xl border border-line bg-panel-2 shadow-2xl shadow-black/60"
      >
        <div className="border-b border-line-soft px-4 py-3">
          <h2 id="release-title" className="text-[13.5px] text-ink">
            发布{appName === null ? '' : ` · ${appName}`}
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint">
            把当前提交冻结成一个版本，推到本地备份库。备份库是标准裸库，
            <span className="text-muted"> git clone 出来就是这一版的完整代码</span>。
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
          <div className="rounded-lg border border-line bg-panel px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[11.5px] text-muted">这一版</span>
              {headCommit === null ? (
                <span className="text-[11.5px] text-warn">还没有任何提交</span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">
                  {headCommit.message.split('\n')[0]}
                  <span className="ml-1.5 font-mono text-[10.5px] text-faint">
                    {headCommit.sha.slice(0, 7)}
                  </span>
                </span>
              )}
            </div>
          </div>

          <label className="block space-y-1.5">
            <span className="text-[11.5px] text-muted">发布说明（可选）</span>
            <textarea
              value={notes}
              maxLength={2000}
              rows={3}
              disabled={publishing}
              placeholder="这一版改了什么、为什么要发"
              onChange={(event) => setNotes(event.target.value)}
              className="min-h-[76px] w-full resize-none rounded-lg border border-line bg-panel px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
            <span className="block text-[10.5px] text-faint">
              会写进这次 tag 的正文，拿备份库的人也能看到。
            </span>
          </label>

          {error !== null && (
            <p className="rounded-lg border border-bad/30 bg-[#241413] px-3 py-2 text-[11.5px] leading-relaxed text-bad">
              {error}
            </p>
          )}

          {result !== null && (
            <div className="space-y-2 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] text-ok">已发布 {result.version}</span>
                <span className="font-mono text-[10.5px] text-faint">
                  {result.commitSha.slice(0, 7)} → {result.branch}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-[10.5px] text-faint">备份库</span>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 font-mono text-[10.5px] text-muted">
                    {result.backupPath}
                  </code>
                  <CopyButton text={result.backupPath} />
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-[10.5px] text-faint">克隆这一版的完整代码</span>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 font-mono text-[10.5px] text-muted">
                    git clone {result.backupPath}
                  </code>
                  <CopyButton text={`git clone ${result.backupPath}`} />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <span className="text-[11.5px] text-muted">发布历史</span>
            {releases.length === 0 ? (
              <p className="text-[11.5px] text-faint">还没有发布过。</p>
            ) : (
              <ul className="divide-y divide-line-soft rounded-lg border border-line">
                {releases.map((release) => (
                  <li key={release.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="font-mono text-[11px] text-ink">{release.version}</span>
                    <span className="font-mono text-[10px] text-faint">
                      {release.commitSha.slice(0, 7)}
                    </span>
                    {release.notes !== null && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                        {release.notes}
                      </span>
                    )}
                    <span className={cn('ml-auto shrink-0 text-[10.5px] text-faint')}>
                      {stampOf(release.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <Button variant="ghost" size="sm" disabled={publishing} onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={publishing || headCommit === null}
            onClick={() => void submit()}
          >
            {publishing ? '发布中…' : result === null ? '发布' : '再发一版'}
          </Button>
        </div>
      </div>
    </div>
  )
}
