/**
 * 应用级结构化状态（DESIGN §6.3）。
 *
 * 这些 doc 与 transcript 并列、存在同一个 `harness.sqlite` 里，可以在同一个 commit 里
 * 和对话一起原子写。**它们是 Agent 的长期记忆**，不是 UI 的缓存。
 */
import { defineDoc } from '@earendil-works/pi-durable'

/**
 * `tenon.app`：应用名称、风格、路由清单、技术选型。
 * 用 `type` 而不是 `interface`：pi-durable 要求 `T extends JsonObject`，
 * 而只有类型别名会获得隐式索引签名（interface 不会）。
 */
export type AppDocShape = {
  name: string
  description: string
  styleId: string | null
  routes: string[]
  stack: { frontend: string; backend: string }
}

export const AppDoc = defineDoc<AppDocShape>({
  kind: 'tenon.app',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({
    /* 默认名是**存下来的数据**（不是文案），英文：它可能被写进提交信息、导出目录名 */
    name: 'Untitled app',
    description: '',
    styleId: null,
    routes: [],
    stack: { frontend: 'react19-vite7', backend: 'nestjs11-typeorm' },
  }),
  checkpointWhen: () => false,
})

/** `tenon.plan`：任务清单（rewindable = 任意历史版本的计划都可读回） */
export type PlanDocTask = {
  id: string
  title: string
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed'
  ownerConversationId: string | null
  commitSha: string | null
}

export type PlanDocShape = {
  tasks: PlanDocTask[]
  updatedAt: number
}

export const PlanDoc = defineDoc<PlanDocShape>({
  kind: 'tenon.plan',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ tasks: [], updatedAt: 0 }),
  checkpointWhen: () => false,
})
