/**
 * 子 Agent / 任务状态的展示文案。
 *
 * 从原来那个独立面板（`TaskGraphPanel`）里搬过来的：面板拆掉之后，这几张表还要用在
 * 对话里的子 Agent 卡片上。**不放回组件里**是因为它是纯映射，测试与复用都不该依赖 JSX。
 *
 * 一句提醒：`ROLE_LABEL` 别改成从 `@tenon/agent` import —— 那是服务端包，
 * 会把整个 pi 打进前端产物（体积从 300KB 跳到 3MB 那种）。
 */
import type { TaskGraphNode } from '@tenon/protocol'

const ROLE_LABEL: Record<string, string> = {
  builder: 'Builder',
  explore: 'Explore',
  librarian: 'Librarian',
  codeact: 'CodeAct',
  e2e: 'E2E',
  reviewer: 'Reviewer',
}

export function roleLabel(role: string | null): string | null {
  if (role === null) return null
  return ROLE_LABEL[role] ?? role
}

/** pi 的细阶段是宿主枚举，直接显示等于让用户读内部实现 */
const PHASE_TEXT: Record<string, string> = {
  prepare: '准备上下文',
  request: '等模型',
  tools: '串工具',
  call: '调度工具',
  execute: '执行中',
}

export function statusText(node: TaskGraphNode): string {
  switch (node.status) {
    case 'pending':
      return '排队'
    case 'running':
      return PHASE_TEXT[node.phase ?? ''] ?? '运行中'
    case 'waiting':
      return node.waitingOn.length > 0 ? `等 ${node.waitingOn.length} 个子任务` : '等待'
    case 'sleeping':
      return '等重试'
    case 'completing':
      return '收尾'
  }
}

export function dotClass(status: TaskGraphNode['status']): string {
  switch (status) {
    case 'pending':
      return 'bg-faint'
    case 'running':
      return 'bg-brand tenon-pulse'
    case 'waiting':
      return 'bg-warn'
    case 'sleeping':
      return 'bg-warn'
    case 'completing':
      return 'bg-ok'
  }
}

export function titleOf(node: TaskGraphNode): string {
  if (node.kind === 'generation') {
    if (node.scope === 'root') return '主对话'
    return roleLabel(node.role) ?? '子 Agent'
  }
  if (node.kind === 'tool') {
    const label = roleLabel(node.role)
    return label === null ? '工具调用' : `派活 ${label}`
  }
  return node.kind
}
