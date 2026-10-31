import { useEffect, useRef, useState } from 'react'
import type { App } from '@tenon/protocol'
import { ChevronDownIcon, PlusIcon } from '../../components/icons.js'
import { cn } from '../../lib/cn.js'

export interface AppMenuProps {
  apps: App[]
  activeApp: App | null
  onSelect(appId: string): void
  onCreate(): void
}

export function AppMenu({ apps, activeApp, onSelect, onCreate }: AppMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
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
        <div className="absolute top-full left-0 z-40 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-panel-2 shadow-xl shadow-black/40">
          <div className="max-h-72 overflow-y-auto py-1">
            {apps.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-faint">还没有应用</p>
            )}
            {apps.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => {
                  onSelect(app.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-panel-3',
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
            ))}
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
