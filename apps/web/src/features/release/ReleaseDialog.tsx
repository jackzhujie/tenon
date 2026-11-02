/**
 * 发布对话框。
 *
 * 这里要讲清两件事。
 *
 * **一、"发布"在当前阶段交付了什么。** 它没有把应用推上线（那要 Docker / 静态部署），
 * 而是把一个 commit 冻结成版本，推到本地备份库（一个标准裸库，`git clone` 出来就是
 * 这一版的完整代码）。与其含糊地说"发布成功"，不如把路径和 clone 命令直接给出来 ——
 * 用户能自己验证。
 *
 * **二、它现在会先检查一遍（M4 第 7 步）。** 类型检查 / 测试不过就不发。检查没过的界面
 * 不是"报个错就完"，而是三件事一起给：哪一项没过、为什么、以及一个显式的出口
 * （"我还是发"）。出口必须**看得见但不好误点** —— 藏起来会逼用户去翻命令行，
 * 一点就过会让门禁形同虚设，所以是"再点一次确认"。
 */
import { useEffect, useState } from 'react'
import type { CheckOutcome, GitCommit, Release } from '@tenon/protocol'
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

const CHECK_LABEL: Record<string, string> = { typecheck: '类型检查', test: '测试' }
const STATUS_STYLE: Record<CheckOutcome['status'], { glyph: string; className: string }> = {
  pass: { glyph: '✓', className: 'text-ok' },
  fail: { glyph: '✗', className: 'text-bad' },
  // 跳过不是失败，但也不能长得像通过 —— 用中性的灰色，配一句为什么跳过
  skip: { glyph: '⏭', className: 'text-warn' },
}

/** 一项检查。失败/跳过的明细折起来：默认只占一行，要看细节时再展开 */
function CheckRow({ check }: { check: CheckOutcome }) {
  const style = STATUS_STYLE[check.status]
  return (
    <li className="px-2.5 py-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className={cn('shrink-0 text-[11px]', style.className)}>{style.glyph}</span>
        <span className="shrink-0 text-[11.5px] text-muted">{CHECK_LABEL[check.id] ?? check.id}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink" title={check.summary}>
          {check.summary}
        </span>
      </div>
      {check.detail !== null && check.detail.trim() !== '' && (
        <details className="mt-1 pl-4">
          <summary className="cursor-pointer text-[10.5px] text-faint hover:text-muted">看输出</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-panel px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted">
            {check.detail}
          </pre>
        </details>
      )}
    </li>
  )
}

function GateList({ checks }: { checks: CheckOutcome[] }) {
  return (
    <ul className="divide-y divide-line-soft rounded-lg border border-line">
      {checks.map((check) => (
        <CheckRow key={check.id} check={check} />
      ))}
    </ul>
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
  /** `force` = 检查没过也发（服务端仍会跑检查，记录里标 `forced`） */
  onPublish(notes: string, force?: boolean): Promise<PublishOutcome>
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
  /** 门禁没过时的那份清单。有它就说明"上一次点发布被拦了" */
  const [blocked, setBlocked] = useState<CheckOutcome[] | null>(null)
  /** 已经点过一次"仍然发布"，再点才真的发 */
  const [confirming, setConfirming] = useState(false)

  // 每次打开都从干净状态开始：上次的"发布成功"卡片留着，会让人以为这次也发过了
  useEffect(() => {
    if (!open) return
    setNotes('')
    setError(null)
    setResult(null)
    setBlocked(null)
    setConfirming(false)
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

  const submit = async (force = false): Promise<void> => {
    if (publishing) return
    setError(null)
    const outcome = await onPublish(notes, force)
    if (outcome.ok) {
      setResult(outcome.result)
      setBlocked(null)
      setConfirming(false)
      return
    }
    setError(outcome.message)
    // 只有"检查没过"才把清单摊开：工作区脏、没有提交这些一句话就说清了
    if (outcome.checks !== null) setBlocked(outcome.checks)
    else setBlocked(null)
    setConfirming(false)
  }

  /** 主按钮：门禁没过时它就是"仍然发布"，而且第一次点只是把话说清楚 */
  const primary = (): void => {
    if (blocked === null) {
      void submit(false)
      return
    }
    if (!confirming) {
      setConfirming(true)
      return
    }
    void submit(true)
  }

  const primaryLabel = (): string => {
    if (publishing) return blocked === null ? '检查并发布中…' : '发布中…'
    if (blocked !== null) return confirming ? '确认：带着问题发布' : '仍然发布'
    return result === null ? '发布' : '再发一版'
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
            发布前会先跑一遍类型检查和测试。
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

          {blocked !== null && (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[11.5px] text-bad">检查没通过，先别发</span>
                <span className="text-[10.5px] text-faint">修好再点发布；确实要发就点「仍然发布」</span>
              </div>
              <GateList checks={blocked} />
            </div>
          )}

          {error !== null && blocked === null && (
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
                <span className="text-[10.5px] text-faint">检查</span>
                <GateList checks={result.gate.checks} />
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
                    {/* 留痕：这一版是"检查通过"还是"用户硬发"。老记录是 null —— 那时候还没有门禁 */}
                    {release.gateStatus === 'forced' && (
                      <span
                        className="shrink-0 rounded border border-warn/40 px-1 py-px text-[9.5px] text-warn"
                        title={release.gateSummary ?? '检查没通过仍然发布'}
                      >
                        带问题
                      </span>
                    )}
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
          {confirming && (
            <span className="mr-auto self-center text-[10.5px] leading-tight text-warn">
              检查没过还发，历史里会标「带问题」
            </span>
          )}
          {/* 被拦下之后，用户最常见的下一步是"我去改代码，然后重试"。
              没有这个按钮就只能关掉对话框再打开 —— 而重开还会把发布说明清空 */}
          {blocked !== null && (
            <Button variant="ghost" size="sm" disabled={publishing} onClick={() => void submit(false)}>
              重新检查
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={publishing} onClick={onClose}>
            关闭
          </Button>
          <Button
            variant={confirming ? 'danger' : 'primary'}
            className={confirming ? 'border border-bad/50' : undefined}
            size="sm"
            disabled={publishing || headCommit === null}
            onClick={primary}
          >
            {primaryLabel()}
          </Button>
        </div>
      </div>
    </div>
  )
}
