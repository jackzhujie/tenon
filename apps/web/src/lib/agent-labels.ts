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
import type { TFunction } from './i18n.js'
import type { ChatKey } from './messages/chat.js'

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
const PHASE_KEY: Record<string, ChatKey> = {
  prepare: 'agent.phase.prepare',
  request: 'agent.phase.request',
  tools: 'agent.phase.tools',
  call: 'agent.phase.call',
  execute: 'agent.phase.execute',
}

export function statusText(node: TaskGraphNode, t: TFunction): string {
  switch (node.status) {
    case 'pending':
      return t('agent.status.pending')
    case 'running': {
      const key = PHASE_KEY[node.phase ?? '']
      return key === undefined ? t('agent.status.running') : t(key)
    }
    case 'waiting':
      return node.waitingOn.length > 0
        ? t('agent.status.waitingFor', { count: node.waitingOn.length })
        : t('agent.status.waiting')
    case 'sleeping':
      return t('agent.status.retrying')
    case 'completing':
      return t('agent.status.completing')
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

export function titleOf(node: TaskGraphNode, t: TFunction): string {
  if (node.kind === 'generation') {
    if (node.scope === 'root') return t('agent.title.root')
    return roleLabel(node.role) ?? t('agent.title.subagent')
  }
  if (node.kind === 'tool') {
    const label = roleLabel(node.role)
    return label === null ? t('agent.title.tool') : t('agent.title.delegated', { role: label })
  }
  return node.kind
}
