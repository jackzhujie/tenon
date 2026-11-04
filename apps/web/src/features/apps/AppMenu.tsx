import { useEffect, useRef, useState } from 'react'
import type { App } from '@tenon/protocol'
import { ChevronDownIcon, PlusIcon, TrashIcon } from '../../components/icons.js'
import { cn } from '../../lib/cn.js'

export interface AppMenuProps {
  apps: App[]
  activeApp: App | null
  onSelect(appId: string): void
  onCreate(): void
  /** 删除应用（代码 + 数据库 + 日志一起删）。M6 收口时补 —— 之前只有后端有这个方法 */
  onDelete(appId: string): Promise<void>
}

export function AppMenu({ apps, activeApp, onSelect, onCreate, onDelete }: AppMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  /** 正在等二次确认的那一行。删除是**不可逆**的，不做这一步的话一次误点就没了 */
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        setOpen(false)
        setPending(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Esc 先取消确认，再关菜单：不然"想取消删除"会顺手把菜单也关了
        if (pending !== null) setPending(null)
        else setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, pending])

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
        <span className="truncate text-ink">{activeApp?.name ?? '选择应用'}</span>
        <ChevronDownIcon className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div data-tenon-app-menu className="absolute top-full left-0 z-40 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-panel-2 shadow-xl shadow-black/40">
          <div className="max-h-72 overflow-y-auto py-1">
            {apps.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-faint">还没有应用</p>
            )}
            {apps.map((app) => {
              const isPending = pending === app.id
              return (
                <div key={app.id} className="group">
                  {isPending ? (
                    /*
                     * 二次确认**就地展开**，不弹对话框：删应用是"我知道我在删什么"的操作，
                     * 一个居中的模态框反而会让人下意识去点默认按钮。
                     */
                    <div className="bg-[#241413] px-3 py-2" data-tenon-confirm-delete>
                      <p className="text-[12px] leading-relaxed text-bad">
                        删除「{app.name}」？代码、数据库、日志和已发布的备份会一起删掉，不能恢复。
                      </p>
                      <div className="mt-1.5 flex justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={deleting}
                          data-tenon-action="cancel-delete"
                          onClick={() => setPending(null)}
                          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-ink disabled:opacity-40"
                        >
                          取消
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
                          {deleting ? '删除中…' : '删除'}
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
                        平时隐形、hover 或聚焦时出现：删除是低频操作，常驻一个红叉会让整列看起来
                        像"待清理的列表"。`opacity-0` 不影响 Tab 聚焦，键盘仍然够得到。
                      */}
                      <button
                        type="button"
                        title={`删除「${app.name}」`}
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
              新建应用
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
