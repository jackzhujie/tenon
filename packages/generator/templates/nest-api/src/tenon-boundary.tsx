/**
 * 渲染期错误边界：兜住 React 组件树里抛出的异常。
 *
 * 为什么必须单独有一个：`window.onerror` 收不到 React 渲染期抛出的错误 ——
 * React 会自己接住并让整棵树卸载，页面上只剩一片空白，控制台之外没有任何痕迹。
 * 没有边界时，用户看到的是"白屏 + 一切正常"，最难排查的那一类。
 *
 * 边界只做三件事：兜住、报一条带组件栈的日志、给一个能重试的界面。
 *
 * 为什么降级 UI 用 inline style：这份文件会被**逐字节拷进不同模板**
 * （`packages/runtime-sdk/scripts/sync-templates.mjs`），一旦依赖某个模板的
 * css 类名，两个模板就没法共用同一份代码。错误态是兜底，不是门面，能看清就够。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportLog } from './tenon-log'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

const MAIN = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '12px',
  minHeight: '100vh',
  padding: '24px',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
  color: '#1f2328',
  background: '#ffffff',
  textAlign: 'center',
} as const

const TITLE = { margin: 0, fontSize: '20px', fontWeight: 600 } as const
const BODY = { margin: 0, fontSize: '14px', lineHeight: 1.6, color: '#59636e', maxWidth: '46em' } as const
const MESSAGE = {
  margin: 0,
  padding: '10px 14px',
  maxWidth: '46em',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  color: '#b42318',
  background: '#fff5f4',
  border: '1px solid #ffd8d2',
  borderRadius: '6px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const
const BUTTON = {
  padding: '7px 16px',
  font: 'inherit',
  fontSize: '14px',
  color: '#1f2328',
  background: '#f3f4f6',
  border: '1px solid #d0d7de',
  borderRadius: '6px',
  cursor: 'pointer',
} as const

export class TenonErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportLog({
      level: 'error',
      message: `渲染出错：${error.message}`,
      detail: [error.stack ?? '', `组件栈：${info.componentStack ?? '（没有）'}`]
        .filter((part) => part !== '')
        .join('\n\n'),
    })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <main style={MAIN}>
        <h1 style={TITLE}>页面出错了</h1>
        <p style={MESSAGE}>{error.message}</p>
        <p style={BODY}>这条错误已经出现在 Tenon 的日志面板里，可以直接在对话里让助手修。</p>
        <button
          type="button"
          style={BUTTON}
          onClick={() => {
            this.setState({ error: null })
          }}
        >
          重试渲染
        </button>
      </main>
    )
  }
}
