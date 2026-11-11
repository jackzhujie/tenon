import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.js'
import type { SelectionContext } from '@tenon/protocol'
import { selectionLabel } from '../../lib/selection.js'
import type { StreamState } from '../../lib/stream.js'
import { useT } from '../../lib/i18n.js'

/**
 * 从外面（比如日志面板的「发给 Agent」）塞进输入框的一段文本。
 *
 * 带 `seq` 是必须的：同一段文字可能被点两次，靠字符串比较会"第二次没反应"。
 */
export interface ComposerPrefill {
  text: string
  seq: number
}

export interface ComposerProps {
  disabled: boolean
  submitting: boolean
  stream: StreamState
  /** 从预览里点选的元素/区域；非空时在输入框上方显示一个可删除的 chip */
  selection: SelectionContext | null
  onSend(content: string): void
  onStop(): void
  onClearSelection(): void
  /** 非空时把 `text` 追加到输入框（不自动发送：用户通常还要补一句） */
  prefill?: ComposerPrefill | null
}

export function Composer({
  disabled,
  submitting,
  stream,
  selection,
  onSend,
  onStop,
  onClearSelection,
  prefill = null,
}: ComposerProps) {
  const { t } = useT()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  /** IME 组合中按 Enter 是「确认候选词」，不是「发送」。中文输入必须挡住这一下 */
  const composing = useRef(false)

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    // `field-sizing: content` 在 Safari 还没有，这里手动量一次（动态尺寸，允许写 style）
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`
  }, [value])

  // 这一轮跑完了就把焦点还给输入框：用户下一步一定是继续说
  useEffect(() => {
    if (!submitting && !disabled) ref.current?.focus()
  }, [submitting, disabled])

  /*
   * 外部塞进来的文本（日志面板的「发给 Agent」）。
   *
   * 用 `seq` 去重而不是比较字符串：同一段日志被点两次也要有反应。
   * 已经写了一半就追加在下面 —— 不能覆盖用户正在打的字。
   */
  const lastPrefill = useRef<number | null>(null)
  useEffect(() => {
    if (prefill === null || prefill.seq === lastPrefill.current) return
    lastPrefill.current = prefill.seq
    setValue((current) => (current.trim() === '' ? prefill.text : `${current}\n\n${prefill.text}`))
    requestAnimationFrame(() => ref.current?.focus())
  }, [prefill])

  const connected = stream === 'open'
  const canSend = value.trim() !== '' && !submitting && !disabled && connected

  const send = (): void => {
    if (!canSend) return
    onSend(value)
    setValue('')
  }

  return (
    <div className="border-t border-line-soft bg-panel/60 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-xl border border-line bg-panel-2 px-3 py-2 focus-within:border-brand/40">
          {selection !== null && (
            <div className="mb-1.5 flex items-center gap-2 border-b border-line-soft pb-1.5">
              <span className="flex max-w-full items-center gap-1.5 rounded-md bg-brand-dim/70 px-1.5 py-0.5 text-[11px] text-brand-soft">
                <span className="shrink-0">◱</span>
                <span className="truncate font-mono">{selectionLabel(selection, t)}</span>
                <button
                  type="button"
                  title={t('chat.composer.selectionTitle')}
                  onClick={onClearSelection}
                  className="shrink-0 text-brand-soft/60 hover:text-brand-soft"
                >
                  ✕
                </button>
              </span>
              <span className="truncate text-[10.5px] text-faint">
                {t('chat.composer.selectionWillInclude')}
              </span>
            </div>
          )}
          <textarea
            ref={ref}
            value={value}
            rows={1}
            placeholder={
              disabled
                ? t('chat.composer.placeholder.disabled')
                : connected
                  ? t('chat.composer.placeholder.ready')
                  : t('chat.composer.placeholder.connecting')
            }
            disabled={disabled || !connected}
            onChange={(event) => setValue(event.target.value)}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              if (composing.current || event.nativeEvent.isComposing) return
              event.preventDefault()
              send()
            }}
            className="block max-h-42 w-full resize-none bg-transparent text-[13.5px] leading-[1.7] text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed"
          />
          <div className="mt-1 flex items-center gap-2">
            {stream === 'reconnecting' && (
              <span className="text-[11px] text-warn">{t('chat.stream.reconnecting')}</span>
            )}
            {stream === 'failed' && (
              <span className="text-[11px] text-bad">{t('chat.stream.failed')}</span>
            )}
            <span className="ml-auto" />
            {submitting ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                {t('chat.composer.stop')}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!canSend} onClick={send}>
                {t('chat.composer.send')}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 px-1 text-[10.5px] leading-relaxed text-faint">
          {t('chat.composer.footer')}
        </p>
      </div>
    </div>
  )
}
