import { useEffect, useRef, useState } from 'react'
import type { App } from '@tenon/protocol'
import { ChevronDownIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/icons.js'
import { cn } from '../../lib/cn.js'
import { useT } from '../../lib/i18n.js'

export interface AppMenuProps {
  apps: App[]
  activeApp: App | null
  onSelect(appId: string): void
  onCreate(): void
  /** 删除应用（代码 + 数据库 + 日志一起删）。M6 收口时补 —— 之前只有后端有这个方法 */
  onDelete(appId: string): Promise<void>
  /** 改显示名（不动目录与 slug）。同样曾经只有后端有 */
  onRename(appId: string, name: string): Promise<void>
}

export function AppMenu({ apps, activeApp, onSelect, onCreate, onDelete, onRename }: AppMenuProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  /** 正在等二次确认的那一行。删除是**不可逆**的，不做这一步的话一次误点就没了 */
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** 正在改名的那一行，以及输入框里的草稿 */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        setOpen(false)
        setPending(null)
        setRenaming(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 按"最近一层"取消：改名 → 删除确认 → 关菜单。
        // 不这么排的话，想取消改名会顺手把菜单也关了
        if (renaming !== null) setRenaming(null)
        else if (pending !== null) setPending(null)
        else setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, pending, renaming])

  const startRename = (app: App): void => {
    setPending(null)
    setRenaming(app.id)
    setDraft(app.name)
  }

  const commitRename = (appId: string): void => {
    const name = draft.trim()
    // 空名/没改都不发请求：前者会被服务端拒，后者只是白跑一趟
    if (name === '' || name === (apps.find((item) => item.id === appId)?.name ?? '')) {
      setRenaming(null)
      return
    }
    setSaving(true)
    void onRename(appId, name).finally(() => {
      setSaving(false)
      setRenaming(null)
    })
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-tenon-app-menu-trigger
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-7 max-w-[220px] items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors',
          'hover:bg-panel-3',
          open && 'bg-panel-3',
        )}
      >
        <span className="truncate text-ink">{activeApp?.name ?? t('apps.select')}</span>
        <ChevronDownIcon className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div data-tenon-app-menu className="absolute top-full left-0 z-40 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-panel-2 shadow-xl shadow-black/40">
          <div className="max-h-72 overflow-y-auto py-1">
            {apps.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-faint">{t('apps.empty')}</p>
            )}
            {apps.map((app) => {
              const isPending = pending === app.id
              const isRenaming = renaming === app.id
              return (
                <div key={app.id} className="group">
                  {isPending ? (
                    /*
                     * 二次确认**就地展开**，不弹对话框：删应用是"我知道我在删什么"的操作，
                     * 一个居中的模态框反而会让人下意识去点默认按钮。
                     */
                    <div className="bg-[#241413] px-3 py-2" data-tenon-confirm-delete>
                      <p className="text-[12px] leading-relaxed text-bad">
                        {t('apps.deleteConfirm', { name: app.name })}
                      </p>
                      <div className="mt-1.5 flex justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={deleting}
                          data-tenon-action="cancel-delete"
                          onClick={() => setPending(null)}
                          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-ink disabled:opacity-40"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          disabled={deleting}
                          data-tenon-action="confirm-delete"
                          onClick={() => {
                            setDeleting(true)
                            void onDelete(app.id).finally(() => {
                              setDeleting(false)
                              setPending(null)
                            })
                          }}
                          className="rounded bg-bad/90 px-2 py-0.5 text-[11px] font-medium text-[#1a0f0e] transition-colors hover:bg-bad disabled:opacity-40"
                        >
                          {deleting ? t('apps.deleting') : t('apps.delete')}
                        </button>
                      </div>
                    </div>
                  ) : isRenaming ? (
                    /* 改名就地展开：一个输入框 + 两个按钮，不弹模态 */
                    <div className="px-2 py-1.5" data-tenon-rename>
                      <input
                        autoFocus
                        value={draft}
                        data-tenon-rename-input
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          // 自己处理 Esc：不然文档级那个 handler 会把菜单一起关了
                          if (event.key === 'Escape') {
                            event.stopPropagation()
                            setRenaming(null)
                          }
                          if (event.key === 'Enter') commitRename(app.id)
                        }}
                        maxLength={64}
                        className="w-full rounded border border-line bg-panel px-1.5 py-1 text-[12.5px] text-ink outline-none focus:border-brand"
                      />
                      <div className="mt-1 flex justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={saving}
                          data-tenon-action="cancel-rename"
                          onClick={() => setRenaming(null)}
                          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-ink disabled:opacity-40"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          disabled={saving || draft.trim() === ''}
                          data-tenon-action="confirm-rename"
                          onClick={() => commitRename(app.id)}
                          className="rounded bg-brand/90 px-2 py-0.5 text-[11px] font-medium text-[#20120a] transition-colors hover:bg-brand disabled:opacity-40"
                        >
                          {saving ? t('apps.saving') : t('apps.save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center">
                      <button
                        type="button"
                        data-tenon-app={app.id}
                        onClick={() => {
                          onSelect(app.id)
                          setOpen(false)
                        }}
                        className={cn(
                          'flex flex-1 items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-panel-3',
                          app.id === activeApp?.id ? 'text-brand-soft' : 'text-ink',
                        )}
                      >
                        <span
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            app.status === 'running'
                              ? 'bg-brand tenon-pulse'
                              : app.status === 'error'
                                ? 'bg-bad'
                                : 'bg-line',
                          )}
                        />
                        <span className="truncate">{app.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                          {app.templateId}
                        </span>
                      </button>
                      {/*
                        平时隐形、hover 或聚焦时出现：这两个都是低频操作，常驻一行图标会让整列
                        看起来像"待清理的列表"。`opacity-0` 不影响 Tab 聚焦，键盘仍然够得到。
                      */}
                      <button
                        type="button"
                        title={t('apps.renameTitle', { name: app.name })}
                        data-tenon-action="rename-app"
                        onClick={() => startRename(app)}
                        className="shrink-0 rounded p-1 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink focus:opacity-100"
                      >
                        <PencilIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        title={t('apps.deleteTitle', { name: app.name })}
                        data-tenon-action="delete-app"
                        onClick={() => setPending(app.id)}
                        className="mr-2 shrink-0 rounded p-1 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-bad focus:opacity-100"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="border-t border-line-soft p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted transition-colors hover:bg-panel-3 hover:text-ink"
            >
              <PlusIcon className="size-3.5" />
              {t('apps.new')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
