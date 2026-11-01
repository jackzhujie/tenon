import { useState } from 'react'
import { Header } from './Header.js'
import { ChatPanel } from '../features/chat/ChatPanel.js'
import { PreviewPanel } from '../features/preview/PreviewPanel.js'
import { LogPanel } from '../features/logs/LogPanel.js'
import { NewAppDialog } from '../features/apps/NewAppDialog.js'
import { useWorkspace } from '../hooks/useWorkspace.js'
import { useInspectorSelection } from '../hooks/useInspectorSelection.js'
import { cn } from '../lib/cn.js'

function BootScreen({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-[15px] font-medium text-[#20120a]">
          榫
        </span>
        <p className="text-[12px] text-faint">{label}</p>
      </div>
    </div>
  )
}

function ErrorBar({ message, onDismiss }: { message: string; onDismiss(): void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center px-6">
      <div className="pointer-events-auto flex max-w-[80%] items-start gap-3 rounded-lg border border-bad/30 bg-[#241413] px-3.5 py-2 shadow-lg shadow-black/50">
        <p className="text-[12px] leading-relaxed text-bad">{message}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[11px] text-bad/60 hover:text-bad"
        >
          知道了
        </button>
      </div>
    </div>
  )
}

export function App() {
  const workspace = useWorkspace()
  const { state } = workspace
  const [creating, setCreating] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  // 预览里"按住 Alt 点一下"选中的东西，从 iframe 发回来（跨源，靠 origin + token 认）
  const inspectorToken = useInspectorSelection(state.preview, workspace.setSelection)

  if (state.booting) {
    return (
      <BootScreen
        label={state.error === null ? '正在连接本地服务…' : `连不上本地服务：${state.error}`}
      />
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      <Header
        apps={state.apps}
        activeApp={workspace.activeApp}
        model={state.model}
        stream={state.stream}
        onSelectApp={workspace.selectApp}
        onCreate={() => setCreating(true)}
      />

      <main className="flex min-h-0 flex-1">
        <section
          className={cn(
            'flex min-h-0 flex-col border-r border-line',
            fullscreen ? 'hidden' : 'w-[46%] max-w-[640px] min-w-[380px]',
          )}
        >
          <ChatPanel
            app={workspace.activeApp}
            status={state.status}
            messages={state.messages}
            live={state.live}
            commits={state.commits}
            stream={state.stream}
            submitting={state.submitting}
            hasApps={state.apps.length > 0}
            selection={state.selection}
            onSend={(content) => void workspace.submit(content)}
            onStop={() => void workspace.stop()}
            onCreate={() => setCreating(true)}
            onClearSelection={() => workspace.setSelection(null)}
          />
        </section>

        <section className="flex min-w-0 flex-1 flex-col">
          <PreviewPanel
            appId={state.activeAppId}
            preview={state.preview}
            fullscreen={fullscreen}
            inspectorToken={inspectorToken}
            onStart={(restart) => void workspace.startPreview(restart)}
            onToggleFullscreen={() => setFullscreen((value) => !value)}
          />
          {/* 日志在预览下方：它解释的正是"上面这块为什么不动" */}
          {state.activeAppId !== null && (
            <LogPanel
              appId={state.activeAppId}
              logs={state.logs}
              onClear={() => void workspace.clearLogs()}
            />
          )}
        </section>
      </main>

      <NewAppDialog
        open={creating}
        templates={state.templates}
        onClose={() => setCreating(false)}
        onCreate={workspace.createApp}
      />

      {state.error !== null && !state.booting && (
        <ErrorBar message={state.error} onDismiss={workspace.clearError} />
      )}
    </div>
  )
}
