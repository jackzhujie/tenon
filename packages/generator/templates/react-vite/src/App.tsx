import { useState } from 'react'

/**
 * 起始页。它只是**占位**：真正的内容由 Agent 在对话里长出来。
 *
 * 保留一个计数器不是为了好看 —— 它验证两件事：事件绑定通了（不是死页面）、
 * 以及 HMR 走的是 React Fast Refresh（改样式或改这个组件时计数不会归零）。
 */
export function App({ appName }: { appName: string }) {
  const [count, setCount] = useState(0)

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">Tenon · 起点</p>
        <h1>{appName}</h1>
        <p className="lede">
          这个页面由模板生成。在左侧对话里说清你要什么，Agent 会直接改这个工作区里的代码，
          保存即热更新。
        </p>
      </header>

      <section className="card">
        <h2>先确认预览链路是通的</h2>
        <p className="muted">
          点一下按钮；然后让 Agent 改这个文件，页面会热更新，而<b>计数不会丢</b>。
        </p>
        <button type="button" className="button" onClick={() => setCount((n) => n + 1)}>
          点了 {count} 次
        </button>
      </section>

      <ul className="hints">
        <li>
          <code>src/App.tsx</code> —— 页面主体
        </li>
        <li>
          <code>src/styles.css</code> —— 样式（普通 CSS，没有引入框架）
        </li>
        <li>
          <code>README.md</code> —— 这个工作区怎么跑起来
        </li>
      </ul>
    </main>
  )
}
