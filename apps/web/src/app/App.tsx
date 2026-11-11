import { useMemo, useState } from 'react'
import { Header } from './Header.js'
import { ChatPanel } from '../features/chat/ChatPanel.js'
import { PreviewPanel } from '../features/preview/PreviewPanel.js'
import { LogPanel } from '../features/logs/LogPanel.js'
import { NewAppDialog } from '../features/apps/NewAppDialog.js'
import { DiffPanel } from '../features/diff/DiffPanel.js'
import { ReleaseDialog } from '../features/release/ReleaseDialog.js'
import { useWorkspace } from '../hooks/useWorkspace.js'
import { useAppUpdate } from '../hooks/useAppUpdate.js'
import { useInspectorSelection } from '../hooks/useInspectorSelection.js'
import { UpdateBanner } from '../features/update/UpdateBanner.js'
import { cn } from '../lib/cn.js'
import { releaseHint } from '../lib/release-hint.js'
import { useT } from '../lib/i18n.js'

function BootScreen({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-[15px] font-medium text-[#20120a]">
          {/* i18n-ignore 品牌字，不是文案 */}
          榫
        </span>
        <p className="text-[12px] text-faint">{label}</p>
      </div>
    </div>
  )
}

function ErrorBar({ message, onDismiss }: { message: string; onDismiss(): void }) {
  const { t } = useT()
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center px-6">
      <div className="pointer-events-auto flex max-w-[80%] items-start gap-3 rounded-lg border border-bad/30 bg-[#241413] px-3.5 py-2 shadow-lg shadow-black/50">
        <p className="text-[12px] leading-relaxed text-bad">{message}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[11px] text-bad/60 hover:text-bad"
        >
          {t('common.gotIt')}
        </button>
      </div>
    </div>
  )
}

export function App() {
  const { t } = useT()
  const workspace = useWorkspace()
  const { state } = workspace
  const [creating, setCreating] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  /**
   * 从日志面板塞进输入框的文本。`seq` 递增而不是存字符串：
   * 同一行日志被点两次也要有反应（见 `Composer` 的 `prefill`）。
   */
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; seq: number } | null>(null)
  // 预览里"按住 Alt 点一下"选中的东西，从 iframe 发回来（跨源，靠 origin + token 认）
  const inspectorToken = useInspectorSelection(state.preview, workspace.setSelection)
  /* 自动更新：只有 Electron 壳里有桥，浏览器里 `state` 恒为 null，横幅整块不渲染 */
  const update = useAppUpdate()
  /* 顶栏那个数字：上次发布之后又改了几版（算法与边界见 lib/release-hint.ts） */
  const unreleased = useMemo(
    () => releaseHint(state.commits, state.releases),
    [state.commits, state.releases],
  )

  /**
   * 打开改动面板。默认看**最新一版** —— 用户点这个按钮想的通常是"刚才那轮改了什么"，
   * 而不是"翻历史"。翻历史是他看到最新一版之后才有的念头。
   */
  const openDiff = (): void => {
    setDiffOpen(true)
    const latest = state.commits[0]
    if (latest !== undefined && state.diff?.commit.sha !== latest.sha) {
      void workspace.showCommit(latest.sha)
    }
  }

  if (state.booting) {
    return (
      <BootScreen
        label={state.error === null ? t('boot.connecting') : t('boot.failed', { error: state.error })}
      />
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      <Header
        apps={state.apps}
        activeApp={workspace.activeApp}
        model={state.model}
        onModelChanged={workspace.refreshModel}
        stream={state.stream}
        usage={state.usage}
        budgetStopped={state.budgetStopped}
        onSetBudget={workspace.setBudget}
        onSelectApp={workspace.selectApp}
        onCreate={() => setCreating(true)}
        onDeleteApp={workspace.deleteApp}
        onRenameApp={workspace.renameApp}
        unreleased={unreleased}
        onRelease={() => setReleaseOpen(true)}
      />

      {/* 更新提示紧贴顶栏下方：它说的是"这个软件本身"的事，不属于任何一块业务面板 */}
      <UpdateBanner update={update} />

      <main className="flex min-h-0 flex-1">
        <section
          className={cn(
            'flex min-h-0 flex-col border-r border-line',
            fullscreen ? 'hidden' : 'w-[46%] max-w-[640px] min-w-[380px]',
          )}
        >
          <ChatPanel
            prefill={composerPrefill}
            graph={state.graph}
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

        {/* relative：改动面板 absolute 覆盖在这一块上，iframe 保持挂载（否则 HMR 连接会断） */}
        <section className="relative flex min-w-0 flex-1 flex-col">
          <PreviewPanel
            appId={state.activeAppId}
            preview={state.preview}
            fullscreen={fullscreen}
            inspectorToken={inspectorToken}
            onOpenDiff={openDiff}
            onStart={(restart) => void workspace.startPreview(restart)}
            onToggleFullscreen={() => setFullscreen((value) => !value)}
          />
          {diffOpen && state.activeAppId !== null && (
            <DiffPanel
              commits={state.commits}
              selectedSha={state.viewingSha}
              diff={state.diff}
              loading={state.diffLoading}
              reverting={state.reverting}
              onSelect={(sha) => void workspace.showCommit(sha)}
              onRevert={(sha, dbRestore) => void workspace.revertCommit(sha, dbRestore)}
              onClose={() => setDiffOpen(false)}
            />
          )}
          {/* 日志在预览下方：它解释的正是"上面这块为什么不动" */}
          {state.activeAppId !== null && (
            <LogPanel
              appId={state.activeAppId}
              logs={state.logs}
              onClear={() => void workspace.clearLogs()}
              /*
               * 把错误日志交给对话去修。**只塞进输入框、不自动发送** ——
               * 用户往往要补一句"只修这个，别动样式"。seq 保证同一行点两次也有反应。
               */
              onAskFix={(text) =>
                setComposerPrefill((current) => ({ text, seq: (current?.seq ?? 0) + 1 }))
              }
            />
          )}
        </section>
      </main>

      <NewAppDialog
        open={creating}
        templates={state.templates}
        onClose={() => setCreating(false)}
        onCreate={async (name, templateId, brief) => {
          await workspace.createApp(name, templateId, brief)
          /*
           * 把"要做什么"塞进输入框，**不自动发送**：
           * - 用户可能想先改两句（"先只做列表页"）
           * - 自动发送会在用户没准备好的时候开始烧用量
           * `seq` 递增保证同一句话点两次也有反应（与日志「发给 Agent」同一套机制）。
           */
          if (brief.trim() === '') return
          setComposerPrefill((current) => ({ text: brief.trim(), seq: (current?.seq ?? 0) + 1 }))
        }}
      />

      <ReleaseDialog
        open={releaseOpen}
        appName={workspace.activeApp?.name ?? null}
        appId={state.activeAppId}
        headCommit={state.commits[0] ?? null}
        releases={state.releases}
        publishing={state.publishing}
        onClose={() => setReleaseOpen(false)}
        onPublish={workspace.publish}
        onCheck={workspace.checkRelease}
      />

      {state.error !== null && !state.booting && (
        <ErrorBar message={state.error} onDismiss={workspace.clearError} />
      )}
    </div>
  )
}
