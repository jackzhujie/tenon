import type { ReactNode } from 'react'

// 反面样本：只接 title/children，不透传 props → data-tenon-callsite 会丢在组件边界
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="card-body">{children}</div>
    </div>
  )
}
