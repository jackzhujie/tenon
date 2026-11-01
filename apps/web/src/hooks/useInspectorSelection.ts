import { useEffect, useState } from 'react'
import type { PreviewStatus, SelectionContext } from '@tenon/protocol'
import { harvestInspectorMessage, originOf } from '../lib/selection.js'

function newToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `insp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 给当前预览 iframe 发一把 token，并接收应用页面发回来的点选上下文。
 *
 * 返回的 token 由 `PreviewPanel` 拼进 iframe 的 hash（`#tenon-inspector=<token>`）。
 * 预览地址一变就换新的 —— 旧页面拿着旧 token 发来的消息一律不认。
 *
 * 说明：token **不是字面意义上的一次性**（用一次就废）。应用侧的 inspector 在页面加载时
 * 读到 hash 里的 token 就不再变，父窗口单方面作废会让"第二次点选"静默失效。
 * 所以它的语义是"这个 iframe 这次加载的会话凭证"，随重载轮换。
 */
export function useInspectorSelection(
  preview: PreviewStatus | null,
  onSelect: (context: SelectionContext) => void,
): string | null {
  const url = preview?.state === 'ready' ? preview.url : null
  const origin = originOf(url)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    setToken(url === null ? null : newToken())
  }, [url])

  useEffect(() => {
    if (origin === null || token === null) return
    const handler = (event: MessageEvent): void => {
      const context = harvestInspectorMessage({
        data: event.data,
        eventOrigin: event.origin,
        expectedOrigin: origin,
        expectedToken: token,
      })
      if (context !== undefined) onSelect(context)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [origin, token, onSelect])

  return token
}
