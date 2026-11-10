/**
 * 发布对话框里的「远端仓库」一块。
 *
 * 三个决定：
 *
 * **一、令牌框永远空白。** 读回来的只有 `hasToken` 与尾四位。想"显示一下我刚才填的"
 * 是不可能的 —— 一旦能回显，加密保存就只剩心理安慰。
 *
 * **二、默认收起。** 大多数人第一次发布只是想留个底（本地备份库），不需要远端。
 * 一上来摊三个输入框会让人以为"发布必须配 GitHub"。
 *
 * **三、保存后立刻清空输入框且不关闭面板。** 关掉会让人以为"是不是没存上"；
 * 留着明文输入框则是把令牌又摆回屏幕上。清空 + 显示尾四位，两件事一起做才对。
 *
 * 表单初值只来自 props，**不用 effect 去同步**：配置变了说明刚刚保存或清除过，
 * 调用方用 `key` 让这个组件重挂一次即可（同步 setState 的效果既慢又容易被
 * react-hooks 的 lint 判成"级联渲染"）。
 */
import { useCallback, useState } from 'react'
import type { ReleaseRemote } from '@tenon/protocol'
import { Button } from '../../components/ui/Button.js'
import { rpc } from '../../lib/rpc.js'

interface RemoteSectionProps {
  appId: string | null
  /** 发布进行中：不许改配置（改了也不知道这一版用的是哪个） */
  disabled: boolean
  remote: ReleaseRemote | null
  onChange: (remote: ReleaseRemote | null) => void
}

/** `https://github.com/me/app.git` → `github.com/me/app`；只为少占两行，不做美化 */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\.git$/, '')
}

export function RemoteSection({ appId, disabled, remote, onChange }: RemoteSectionProps) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(remote?.url ?? '')
  const [username, setUsername] = useState(remote?.username ?? '')
  const [token, setToken] = useState('')
  const [branch, setBranch] = useState(remote?.branch ?? 'main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async (): Promise<void> => {
    if (appId === null) return
    setBusy(true)
    setError(null)
    try {
      const saved = await rpc('release.remote.set', {
        appId,
        url: url.trim(),
        username: username.trim() === '' ? undefined : username.trim(),
        token: token.trim() === '' ? undefined : token.trim(),
        branch: branch.trim() === '' ? undefined : branch.trim(),
      })
      onChange(saved.remote)
      // 令牌不进 state 的"已保存"态：清掉输入框，靠尾四位让用户确认存的是哪一个
      setToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [appId, url, username, token, branch, onChange])

  const clear = useCallback(async (): Promise<void> => {
    if (appId === null) return
    setBusy(true)
    setError(null)
    try {
      await rpc('release.remote.clear', { appId })
      onChange(null)
      setToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [appId, onChange])

  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-muted">远端仓库</span>
        {remote === null ? (
          <span className="text-[10.5px] text-faint">未配置 · 可选，配了就同时推一份到 GitHub 等</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink">
            {shortUrl(remote.url)}
            <span className="ml-1.5 text-faint">
              {remote.branch}
              {remote.hasToken ? ` · 令牌 ${remote.tokenHint ?? ''}` : ' · 无令牌'}
            </span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {remote !== null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              data-tenon-action="remote-clear"
              onClick={() => void clear()}
            >
              清除
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            data-tenon-action="remote-toggle"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起' : remote === null ? '配置' : '修改'}
          </Button>
        </div>
      </div>

      {remote !== null && !open && (
        <p className="text-[10.5px] leading-relaxed text-faint">
          每次发布都会推一份到这里（分支 + 版本标签）。推失败**不会**让这次发布作废 ——
          本地备份库已经是完整的一版，可以稍后「再推一次」。
        </p>
      )}

      {open && (
        <div className="space-y-2 rounded-lg border border-line bg-panel px-2.5 py-2">
          <label className="block space-y-1">
            <span className="text-[10.5px] text-muted">仓库地址（只收 https）</span>
            <input
              value={url}
              disabled={disabled || busy}
              placeholder="https://github.com/me/my-app.git"
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
              className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
          </label>

          <div className="flex gap-2">
            <label className="block min-w-0 flex-1 space-y-1">
              <span className="text-[10.5px] text-muted">用户名（可选）</span>
              <input
                value={username}
                disabled={disabled || busy}
                placeholder="GitLab 填 oauth2"
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
              />
            </label>
            <label className="block w-24 space-y-1">
              <span className="text-[10.5px] text-muted">分支</span>
              <input
                value={branch}
                disabled={disabled || busy}
                spellCheck={false}
                onChange={(event) => setBranch(event.target.value)}
                className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-brand/50 disabled:opacity-60"
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-[10.5px] text-muted">
              访问令牌
              {remote?.hasToken === true && (
                <span className="ml-1 text-faint">（已存 {remote.tokenHint ?? ''}，留空表示不改）</span>
              )}
            </span>
            <input
              value={token}
              type="password"
              disabled={disabled || busy}
              placeholder={remote?.hasToken === true ? '留空则保持原令牌' : 'ghp_… 或 glpat-…'}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
          </label>

          <p className="text-[10.5px] leading-relaxed text-faint">
            令牌加密存在本机（AES-256-GCM），不会回显。GitHub 用 Fine-grained token，
            权限勾 <span className="text-muted">Contents: Read and write</span> 并选中这个仓库。
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || busy || url.trim() === ''}
              data-tenon-action="remote-save"
              onClick={() => void save()}
            >
              {busy ? '保存中…' : '保存'}
            </Button>
            <span className="text-[10.5px] text-faint">保存后不会立刻推送 —— 下次发布时一起推</span>
          </div>

          {error !== null && (
            <p className="rounded border border-bad/30 bg-[#241413] px-2 py-1.5 text-[10.5px] leading-relaxed text-bad">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
