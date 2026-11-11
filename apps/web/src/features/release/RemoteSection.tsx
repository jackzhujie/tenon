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
import { useT } from '../../lib/i18n.js'
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
  const { t } = useT()
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
        {/* ---- */}
        <span className="text-[11.5px] text-muted">{t('remote.title')}</span>
        {remote === null ? (
          <span className="text-[10.5px] text-faint">{t('remote.notConfigured')}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink">
            {shortUrl(remote.url)}
            <span className="ml-1.5 text-faint">
              {remote.branch}
              {remote.hasToken
                ? t('remote.branchToken', { branch: '', hint: remote.tokenHint ?? '' })
                : t('remote.branchNoToken', { branch: '' })}
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
              {t('remote.clear')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            data-tenon-action="remote-toggle"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t('remote.toggle.collapse') : remote === null ? t('remote.toggle.configure') : t('remote.toggle.edit')}
          </Button>
        </div>
      </div>

      {remote !== null && !open && (
        <p className="text-[10.5px] leading-relaxed text-faint">
          {t('remote.note')}
        </p>
      )}

      {open && (
        <div className="space-y-2 rounded-lg border border-line bg-panel px-2.5 py-2">
          <label className="block space-y-1">
            <span className="text-[10.5px] text-muted">{t('remote.urlLabel')}</span>
            <input
              value={url}
              disabled={disabled || busy}
              placeholder={t('remote.urlPlaceholder')}
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
              className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
          </label>

          <div className="flex gap-2">
            <label className="block min-w-0 flex-1 space-y-1">
              <span className="text-[10.5px] text-muted">{t('remote.usernameLabel')}</span>
              <input
                value={username}
                disabled={disabled || busy}
                placeholder={t('remote.usernamePlaceholder')}
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
              />
            </label>
            <label className="block w-24 space-y-1">
              <span className="text-[10.5px] text-muted">{t('remote.branchLabel')}</span>
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
              {t('remote.tokenLabel')}
              {remote?.hasToken === true && (
                <span className="ml-1 text-faint">{t('remote.tokenSaved', { hint: remote.tokenHint ?? '' })}</span>
              )}
            </span>
            <input
              value={token}
              type="password"
              disabled={disabled || busy}
              placeholder={remote?.hasToken === true ? t('remote.tokenKeep') : t('remote.tokenNew')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              className="w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-brand/50 disabled:opacity-60"
            />
          </label>

          <p className="text-[10.5px] leading-relaxed text-faint">
            {t('remote.encrypt.before')}
            <span className="text-muted">{t('remote.encrypt.emphasis')}</span>
            {t('remote.encrypt.after')}
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || busy || url.trim() === ''}
              data-tenon-action="remote-save"
              onClick={() => void save()}
            >
              {busy ? t('remote.saveSaving') : t('remote.save')}
            </Button>
            <span className="text-[10.5px] text-faint">{t('remote.savedHint')}</span>
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
