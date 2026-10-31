/**
 * 渲染期错误边界：兜住 React 组件树里抛出的异常。
 *
 * 为什么必须单独有一个：`window.onerror` 收不到 React 渲染期抛出的错误 ——
 * React 会自己接住并让整棵树卸载，页面上只剩一片空白，控制台之外没有任何痕迹。
 * 没有边界时，用户看到的是"白屏 + 一切正常"，最难排查的那一类。
 *
 * 边界只做三件事：兜住、报一条带组件栈的日志、给一个能重试的界面。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportLog } from './tenon-log'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

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
      <main className="page">
        <section className="card">
          <h2>页面出错了</h2>
          <p className="muted">{error.message}</p>
          <p className="muted">
            这条错误已经出现在 Tenon 的日志面板里，可以直接在对话里让助手修。
          </p>
          <button type="button" className="button" onClick={() => this.setState({ error: null })}>
            重试渲染
          </button>
        </section>
      </main>
    )
  }
}
