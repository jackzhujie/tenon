import { useEffect, useRef, useState } from 'react'
import type { TemplateInfo } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import { cn } from '../../lib/cn.js'
import { useT } from '../../lib/i18n.js'

/** 第一次打开就该选中它：唯一一个建完能直接看到东西的模板 */
const DEFAULT_TEMPLATE_ID = 'react-vite'

export interface NewAppDialogProps {
  open: boolean
  templates: TemplateInfo[]
  onClose(): void
  /** `brief` = 用户的一句话需求，建完会塞进对话框（技术栈交给 Agent 决定） */
  onCreate(name: string, templateId: string, brief: string): Promise<void>
}

export function NewAppDialog({ open, templates, onClose, onCreate }: NewAppDialogProps) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [brief, setBrief] = useState('')
  /**
   * 技术栈默认**不让用户选**：要建什么应用决定用什么栈，而这件事 Agent 比用户清楚
   * （用户不该被要求先知道 "Vite 还是 Next"）。展开只是给"我知道我要什么"的人留个口子。
   */
  const [advanced, setAdvanced] = useState(false)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const briefRef = useRef<HTMLTextAreaElement>(null)

  // 每次打开都重置：上次输了一半的名字留着只会让人误建
  useEffect(() => {
    if (!open) return
    setName('')
    // 默认选能跑起来的那个，不是列表里的第一个：
    // `blank` 排在最前（它最简单），但建完是个空目录、预览起不来，第一印象很差
    setTemplateId(
      templates.find((item) => item.id === DEFAULT_TEMPLATE_ID)?.id ??
        templates[0]?.id ??
        DEFAULT_TEMPLATE_ID,
    )
    setBrief('')
    setAdvanced(false)
    setPending(false)
    // 等隐藏态切完再聚焦，否则 Safari 会把焦点吞掉
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open, templates])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, pending, onClose])

  if (!open) return null

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed === '' || pending) return
    setPending(true)
    try {
      await onCreate(trimmed, templateId === '' ? 'react-vite' : templateId, brief.trim())
      onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-app-title"
        className="w-full max-w-md rounded-xl border border-line bg-panel-2 shadow-2xl shadow-black/60"
      >
        <div className="border-b border-line-soft px-4 py-3">
          <h2 id="new-app-title" className="text-[13.5px] text-ink">
            {t('apps.new')}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-faint">
            {t('apps.new.body')}
          </p>
        </div>

        <div className="space-y-4 px-4 py-3.5">
          <label className="block space-y-1.5">
            <span className="text-[11.5px] text-muted">{t('apps.new.name')}</span>
            <input
              ref={inputRef}
              value={name}
              maxLength={64}
              placeholder={t('apps.new.namePlaceholder')}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
              className="h-8.5 w-full rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11.5px] text-muted">
              {t('apps.new.brief')} <span className="text-faint">{t('apps.new.briefHint')}</span>
            </span>
            <textarea
              ref={briefRef}
              value={brief}
              rows={3}
              maxLength={600}
              placeholder={t('apps.new.briefPlaceholder')}
              disabled={pending}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={(event) => {
                // Enter 提交、Shift+Enter 换行 —— 与对话输入框保持一致
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              className="w-full resize-none rounded-lg border border-line bg-panel px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
          </label>

          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-faint">
              {t('apps.new.stack.before')}<span className="text-muted">{t('apps.new.stack.emphasis')}</span>
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => setAdvanced((current) => !current)}
              className="text-[11px] text-faint underline-offset-2 hover:text-muted hover:underline"
            >
              {advanced ? t('apps.new.collapse') : t('apps.new.advancedShow')}
            </button>
          </div>

          <div className={cn('space-y-1.5', advanced ? '' : 'hidden')}>
            <span className="text-[11.5px] text-muted">{t('apps.new.template')}</span>
            <div className="grid gap-1.5">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  disabled={pending}
                  onClick={() => setTemplateId(template.id)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors',
                    templateId === template.id
                      ? 'border-brand/50 bg-brand-dim/40'
                      : 'border-line bg-panel hover:border-[#3a3431]',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] text-ink">{template.label}</span>
                    <span className="font-mono text-[10px] text-faint">{template.id}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{template.description}</p>
                </button>
              ))}
              {templates.length === 0 && (
                <p className="text-[11.5px] text-faint">{t('apps.new.templateFailed')}</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending || name.trim() === ''}
            onClick={() => void submit()}
          >
            {pending ? t('apps.new.creating') : t('apps.new.create')}
          </Button>
        </div>
      </div>
    </div>
  )
}
