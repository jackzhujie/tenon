import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.js'
import type { StreamState } from '../../lib/stream.js'

export interface ComposerProps {
  disabled: boolean
  submitting: boolean
  stream: StreamState
  onSend(content: string): void
  onStop(): void
}

export function Composer({ disabled, submitting, stream, onSend, onStop }: ComposerProps) {
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
          <textarea
            ref={ref}
            value={value}
            rows={1}
            placeholder={
              disabled
                ? '先选择一个应用'
                : connected
                  ? '说说你想做什么，Enter 发送，Shift+Enter 换行'
                  : '正在连接本地服务…'
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
              <span className="text-[11px] text-warn">连接断开，正在重连…</span>
            )}
            {stream === 'failed' && (
              <span className="text-[11px] text-bad">连接已断开，刷新页面重试</span>
            )}
            <span className="ml-auto" />
            {submitting ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                停止
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!canSend} onClick={send}>
                发送
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 px-1 text-[10.5px] leading-relaxed text-faint">
          每一轮对话结束会自动提交一次 git，可随时回滚。
        </p>
      </div>
    </div>
  )
}
