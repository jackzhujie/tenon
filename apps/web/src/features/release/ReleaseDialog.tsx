/**
 * 发布对话框。
 *
 * 这里要讲清三件事。
 *
 * **一、"发布"在当前阶段交付了什么。** 它没有把应用推上线（那要 Docker / 静态部署），
 * 而是把一个 commit 冻结成版本，推到本地备份库（一个标准裸库，`git clone` 出来就是
 * 这一版的完整代码）。与其含糊地说"发布成功"，不如把路径和 clone 命令直接给出来 ——
 * 用户能自己验证。
 *
 * **二、打开对话框就开始预检。** 门禁只在点发布时跑的话，用户是"点了才知道过不过"，
 * 而这个功能的全部价值恰恰是**在发之前**知道。所以一打开就跑 `release.check`：
 * 能发是绿的、不能发直接把清单摊开、连发布的前提都不满足（工作区脏、没有提交）
 * 就一句话说清并禁用按钮。
 *
 * **三、预检是真跑，不是读缓存。** 它真的会执行 `tsc` 与 `pnpm run test`，有测试的
 * 应用可能要几十秒 —— 所以必须有"正在检查"和已等秒数，否则用户以为界面卡死了。
 * 也正因为真跑，点发布时**服务端会再跑一遍**：两次之间代码、依赖都可能变，
 * 拿上一次的结论当依据等于把门禁交给一个可能过期的答案。这一点界面上要说出来，
 * 不然用户会奇怪"刚才不是检查过了吗"。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CheckOutcome, GitCommit, Release } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import { rpc } from '../../lib/rpc.js'
import type {
  CheckOutcomeResult,
  PublishOutcome,
  PublishResult,
  ReleaseCheck,
} from '../../hooks/useWorkspace.js'

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
  /** 导出要用（`export.static`）。与 `appName` 分开：名字可能还没加载出来，id 一定有 */
  appId: string | null
  /** 当前 HEAD，发布的就是它 */
  headCommit: GitCommit | null
  releases: Release[]
  publishing: boolean
  onClose(): void
  /** `force` = 检查没过也发（服务端仍会跑检查，记录里标 `forced`） */
  onPublish(notes: string, force?: boolean): Promise<PublishOutcome>
  /** 预检（`release.check`）。只读，但会真跑类型检查与测试 */
  onCheck(): Promise<CheckOutcomeResult>
}

export function ReleaseDialog({
  open,
  appName,
  appId,
  headCommit,
  releases,
  publishing,
  onClose,
  onPublish,
  onCheck,
}: ReleaseDialogProps) {
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)
  /** 预检结果。null = 还没出来（checking 为真时） */
  const [preflight, setPreflight] = useState<ReleaseCheck | null>(null)
  const [checking, setChecking] = useState(false)
  /** 预检本身没跑成（网络 / 服务端崩）。它不等于"检查没过"，不能混成一个红条 */
  const [checkError, setCheckError] = useState<string | null>(null)
  /** 已经等了多少毫秒。检查会真跑测试，没有这个数字用户以为卡死了 */
  const [waitedMs, setWaitedMs] = useState(0)
  /** 点发布被拦时的那份清单 —— 预检通过之后代码又改了才会走到这里 */
  const [blocked, setBlocked] = useState<CheckOutcome[] | null>(null)
  /** 已经点过一次"仍然发布"，再点才真的发 */
  const [confirming, setConfirming] = useState(false)
  /*
   * 导出：发布是**给自己留底**（备份库 + tag），导出是**拿出去用**。两件事在同一刻决定，
   * 所以放在同一个对话框里 —— 但导出不走 hook 的状态：产物路径只在这次对话里有意义。
   */
  const [exporting, setExporting] = useState(false)
  const [exportElapsed, setExportElapsed] = useState(0)
  const [exported, setExported] = useState<{
    dir: string
    bytes: number
    files: number
    hasApi: boolean
  } | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    if (!exporting) return
    const started = Date.now()
    // 构建 + 装生产依赖，几十秒到两分钟；不给秒数用户会以为界面卡死了
    const timer = setInterval(() => setExportElapsed(Math.round((Date.now() - started) / 1000)), 500)
    return () => clearInterval(timer)
  }, [exporting])

  const runExport = useCallback(async (): Promise<void> => {
    if (appId === null) return
    setExporting(true)
    setExportElapsed(0)
    setExportError(null)
    setExported(null)
    try {
      const done = await rpc('export.static', { appId, installDeps: true })
      setExported({ dir: done.dir, bytes: done.bytes, files: done.files, hasApi: done.hasApi })
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [appId])

  const runCheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    setCheckError(null)
    setWaitedMs(0)
    // 上一轮的结论先清掉：留着会出现"旧清单 + 正在检查"，人会以为那就是这一次的结果
    setPreflight(null)
    setBlocked(null)
    setConfirming(false)
    const outcome = await onCheck()
    setChecking(false)
    if (outcome.ok) setPreflight(outcome.result)
    else setCheckError(outcome.message)
  }, [onCheck])

  /**
   * 打开就跑一次预检。
   *
   * `openedFor` 是给 React StrictMode 的：开发模式下 effect 会跑两遍，而这个 effect
   * 跑一遍就是**真跑一遍 `pnpm run test`**（几十秒，还占满 CPU）。按"这一次打开"去重 ——
   * 不能靠调用方去重，因为它不知道我们为什么要跑两次。
   */
  const openedFor = useRef(false)
  useEffect(() => {
    if (!open) {
      openedFor.current = false
      return
    }
    if (openedFor.current) return
    openedFor.current = true
    setNotes('')
    setError(null)
    setResult(null)
    void runCheck()
  }, [open, runCheck])

  // 计时：只在"正在检查"期间走，每半秒刷一次（刷太勤没有意义，人眼也看不出）
  useEffect(() => {
    if (!checking) return
    const startedAt = Date.now()
    setWaitedMs(0)
    const timer = setInterval(() => setWaitedMs(Date.now() - startedAt), 500)
    return () => clearInterval(timer)
  }, [checking])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !publishing) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, publishing, onClose])

  if (!open) return null

  /** 发布的前提都不满足：连检查都没跑，按钮该灰着（不是"检查没过"，是"现在不能发"） */
  const hardBlocked = preflight !== null && preflight.blocked !== null
  /**
   * 检查没过。两种来源都算：预检就红了，或者预检转绿之后点发布被服务端拦下
   *（那几十秒里代码又变了）—— 两者对用户是同一件事：能发，但要先说清楚。
   */
  const gateFailed =
    blocked !== null || (preflight !== null && preflight.gate !== null && !preflight.gate.ok)
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

  const shortSha = (sha: string): string => sha.slice(0, 7)

  /**
   * 主按钮。
   *
   * 检查没过时它**不是**发布 —— 是「重新检查」。这是有意的：绝大多数时候用户会去改
   * 代码再来一遍，把"仍然发布"放成主按钮等于把逃生舱摆到驾驶座旁边。逃生舱要看得见
   * （左边那个 ghost 按钮），但不好误点（点了先变色、再点一次才真的发）。
   */
  const primary = (): void => {
    if (hardBlocked || publishing) return
    if (gateFailed) {
      if (!confirming) {
        void runCheck()
        return
      }
      void submit(true)
      return
    }
    void submit(false)
  }

  const primaryLabel = (): string => {
    if (publishing) return '发布中…'
    if (hardBlocked) return '先处理上面的问题'
    if (checking) return '检查中…'
    if (gateFailed) return confirming ? '确认：带着问题发布' : '重新检查'
    return result === null ? '发布' : '再发一版'
  }

  /**
   * 逃生舱：「检查没过也发」。
   *
   * 第一次点只是把按钮变成红的并换文案 —— 双击不会误发，因为点的时候文案刚变
   * （这是设计，不是巧合）。真正发出去需要再点一次那个红按钮。
   */
  const forceButton = (): ReactNode => {
    if (!gateFailed || publishing) return null
    return (
      <Button
        variant={confirming ? 'danger' : 'ghost'}
        className={confirming ? 'mr-auto border border-bad/50' : 'mr-auto'}
        size="sm"
        disabled={checking}
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            return
          }
          void submit(true)
        }}
      >
        {confirming ? '确认：带着问题发布' : '仍然发布'}
      </Button>
    )
  }

  /** 预检区块：四态（检查中 / 前提不满足 / 过了 / 没过）+ 一个"结果过期"的旁支 */
  const preflightBlock = (): ReactNode => {
    if (checking) {
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
            <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-muted" />
            <span className="text-[11.5px] text-muted">正在跑类型检查与测试…</span>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">
              {(waitedMs / 1000).toFixed(0)}s
            </span>
          </div>
          <p className="text-[10.5px] leading-relaxed text-faint">
            这一步会<span className="text-muted">真跑一遍</span>（不是读上一次的结果），有测试的应用可能要几十秒。
          </p>
        </div>
      )
    }

    if (checkError !== null) {
      return (
        <div className="rounded-lg border border-line bg-panel px-3 py-2">
          <p className="text-[11.5px] leading-relaxed text-muted">预检没跑起来：{checkError}</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
            这不代表代码有问题 —— 点发布时服务端还会完整检查一遍。
          </p>
        </div>
      )
    }

    if (preflight === null) return null

    if (preflight.blocked !== null) {
      return (
        <div className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2">
          <p className="text-[11.5px] leading-relaxed text-ink">{preflight.blocked.message}</p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
            现在不满足发布的前提，所以这一步<span className="text-muted">没有</span>跑类型检查和测试。
          </p>
        </div>
      )
    }

    if (preflight.gate === null) return null

    // 0.0s 会让人怀疑"它到底跑了没有"。没跑起来的情况（缺 typescript）本来就是瞬时的。
    // 不带单位：JSX 那边统一补一个 `s`
    const seconds = preflight.elapsedMs < 1000 ? '<1' : (preflight.elapsedMs / 1000).toFixed(1)
    if (preflight.stale) {
      return (
        <div className="space-y-2">
          <div className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2">
            <p className="text-[11.5px] leading-relaxed text-ink">
              检查期间又有新提交，这份结果讲的是{' '}
              <span className="font-mono text-[11px]">{shortSha(preflight.commitSha ?? "")}</span> 那一版，不算数。
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              针对 A 版的"通过"拿去给 B 版用，比不检查更糟 —— 它给的是虚假的安心。再查一次。
            </p>
          </div>
          <GateList checks={preflight.gate.checks} />
        </div>
      )
    }

    if (!preflight.gate.ok) {
      return (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[11.5px] text-bad">检查没通过，先别发</span>
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">{seconds}s</span>
          </div>
          <GateList checks={preflight.gate.checks} />
          <p className="text-[10.5px] leading-relaxed text-faint">
            修好再点「重新检查」；确实要发就点「仍然发布」，历史里会标「带问题」。
          </p>
        </div>
      )
    }

    return (
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11.5px] text-ok">✓ 检查通过，可以发</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">{seconds}s</span>
        </div>
        <GateList checks={preflight.gate.checks} />
        <p className="text-[10.5px] leading-relaxed text-faint">
          点发布会再跑一遍（结果不缓存 —— 两次之间代码或依赖都可能变），所以还会再等一次。
        </p>
      </div>
    )
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
            把当前提交冻结成一个版本，推到本地备份库。备份库是标准裸库，{' '}
            <span className="text-muted">git clone 出来就是这一版的完整代码</span>。
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

          {preflightBlock()}

          {blocked !== null && (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[11.5px] text-bad">检查没通过，先别发</span>
                <span className="text-[10.5px] text-faint">修好再点发布；确实要发就点「仍然发布」</span>
              </div>
              <GateList checks={blocked} />
            </div>
          )}

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

          {/*
            导出区块放在"发布历史"之前：发布完最自然的下一件事就是"那我怎么把它放到服务器上"。
            产物路径只在这次对话里有意义，所以状态留在本组件，不进 hook。
          */}
          <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-muted">拿去部署</span>
              <Button
                variant="outline"
                size="sm"
                disabled={exporting || appId === null}
                data-tenon-action="export-static"
                onClick={() => void runExport()}
              >
                {exporting ? `导出中… ${exportElapsed}s` : '导出静态包'}
              </Button>
            </div>
            <p className="text-[10.5px] leading-relaxed text-faint">
              产出一个能拷走就跑的目录：前端 + 后端 + 生产依赖，只认一个 DATABASE_URL。
              导出会真跑一次构建（几十秒到两分钟），进度在左下角的日志里。
            </p>
            {exportError !== null && (
              <p className="rounded border border-bad/30 bg-[#241413] px-2 py-1.5 text-[11px] leading-relaxed text-bad">
                {exportError}
              </p>
            )}
            {exported !== null && (
              <div className="space-y-1" data-tenon-export-result>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 font-mono text-[10.5px] text-muted">
                    {exported.dir}
                  </code>
                  <CopyButton text={exported.dir} label="复制路径" />
                </div>
                <p className="text-[10.5px] text-faint">
                  {Math.round(exported.bytes / 1024 / 1024)}MB · {exported.files} 个文件 ·{' '}
                  {exported.hasApi ? '含后端（迁移会自动跑）' : '纯前端'}
                  。产物里的 README 写了怎么起。
                </p>
              </div>
            )}
          </div>

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

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          {confirming && (
            <p className="w-full text-right text-[10.5px] leading-tight text-warn">
              再点一次就真的发出去 —— 历史里会标「带问题」
            </p>
          )}
          {/* 逃生舱在最左：看得见，但不是主按钮 */}
          {forceButton()}
          <Button variant="ghost" size="sm" disabled={publishing} onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={publishing || checking || hardBlocked || headCommit === null}
            onClick={primary}
          >
            {primaryLabel()}
          </Button>
        </div>
      </div>
    </div>
  )
}
