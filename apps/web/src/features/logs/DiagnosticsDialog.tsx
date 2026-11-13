/**
 * 诊断对话框 —— 「出错了，把这份发给作者」那一步。
 *
 * ## 三个刻意的设计
 *
 * **一、不自动发。** 本地优先的产品默认往外发东西，就是把"你的代码不出这台机器"
 * 这句话打了个折。所以这里只生成、只展示，发不发由用户点 —— 关掉对话框什么都不会发生。
 *
 * **二、原文摊开。** 显示的就是要发出去的那段文本，不做折叠、不做摘要渲染。
 * 一旦做成"摘要 + 详情"，用户点发送时看到的和真正发出去的就可能不是同一份东西，
 * 而那正是隐私类功能最不该出现的偏差。
 *
 * **三、脱敏只是兜底，人才是最后一道。** 自动规则能挡住家目录、密钥、连接串，
 * 但挡不住"客户合同管理"这种业务词。所以文案里明说"先看一眼"，
 * 而不是让它看起来像"已经安全了，闭眼发吧"。
 *
 * ## 为什么出口是「复制 + 新建 Issue」而不是一个上传地址
 *
 * 上传要一个接收端：要防垃圾写入、要清老数据、要能被审计。而这些成本换来的是
 * "用户不知道自己发了什么"。GitHub Issue 免费、可见、可追溯，用户还能顺手补一句
 * "我点发布时崩的" —— 那条信息比任何自动采集都值钱。
 */
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button.js'
import { rpc } from '../../lib/rpc.js'
import { useT } from '../../lib/i18n.js'

const ISSUE_URL = 'https://github.com/jackzhujie/tenon/issues/new'

export interface DiagnosticsDialogProps {
  /** 有应用就带上它的错误日志；null 时只有环境信息 */
  appId: string | null
  onClose(): void
}

export function DiagnosticsDialog({ appId, onClose }: DiagnosticsDialogProps) {
  const { t } = useT()
  const [text, setText] = useState<string | null>(null)
  const [redactions, setRedactions] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    const input = appId === null ? {} : { appId }
    void rpc('diagnostics.report', input)
      .then((result) => {
        if (cancelled) return
        setText(result.text)
        setRedactions(result.redactions)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [appId])

  // Esc 关闭：这是个只读面板，没有"填了一半"要保护
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function copy(): Promise<boolean> {
    if (text === null) return false
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      return true
    } catch {
      // 复制不了不报错：用户还能手动选中 `<pre>` 里的文字
      return false
    }
  }

  async function openIssue(): Promise<void> {
    // 先复制再开页：诊断文本动辄几千字符，塞进 URL 会被截断，
    // 而"打开页面发现是空的"比不复制更糟
    await copy()
    const query = new URLSearchParams({
      title: t('log.diag.issueTitle'),
      body: t('log.diag.issueBody'),
    })
    window.open(`${ISSUE_URL}?${query.toString()}`, '_blank', 'noopener')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-title"
        className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border border-line bg-panel-2 shadow-2xl shadow-black/60"
      >
        <div className="border-b border-line-soft px-4 py-3">
          <h2 id="diagnostics-title" className="text-[13.5px] text-ink">
            {t('log.diag.title')}
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint">{t('log.diag.intro')}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error !== null ? (
            <p className="text-[11.5px] text-bad">{t('log.diag.failed', { detail: error })}</p>
          ) : text === null ? (
            <p className="text-[11.5px] text-faint">{t('log.diag.loading')}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-5 text-muted">
              {text}
            </pre>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line-soft px-4 py-2.5">
          <span className="text-[10.5px] text-faint">
            {t('log.diag.redactions', { count: redactions })}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('log.diag.close')}
            </Button>
            <Button size="sm" disabled={text === null} onClick={() => void openIssue()}>
              {t('log.diag.issue')}
            </Button>
            <Button variant="primary" size="sm" disabled={text === null} onClick={() => void copy()}>
              {copied ? t('log.diag.copied') : t('log.diag.copy')}
            </Button>
          </span>
        </div>
      </div>
    </div>
  )
}
