/**
 * 插槽（slot）= 组件能挂的位置。**稀缺资源，V1 只开放六个。**
 *
 * 为什么不开放任意位置：插槽一多，组件的"挂在哪儿"就变成了自由排版问题 ——
 * Agent 每次装组件都要自己找插入点，出错只是时间问题；而生成的应用之间也没法比较。
 * 固定六个位置，Agent 只需要选一个名字。
 *
 * **宿主（web / server）由插槽决定，装配声明里不再写 `host`。**
 * 让声明自己写 host 等于留下第二种错法：`app.api` 挂到 web、`app.shell.overlay` 挂到 server
 * 都是没有意义的组合，却都能写出来。这里把「哪个插槽在哪一边」变成唯一事实来源。
 */

export type SlotHost = 'web' | 'server'

export interface SlotSpec {
  readonly id: string
  readonly host: SlotHost
  /** 界面/文档里给人看的名字 */
  readonly label: string
  readonly description: string
}

export const COMPONENT_SLOTS = [
  {
    id: 'app.shell.overlay',
    host: 'web',
    label: '全屏浮层',
    description: '悬浮球、全局 AI 助手这类覆盖在应用之上、不占布局的组件',
  },
  {
    id: 'app.shell.sidebar.bottom',
    host: 'web',
    label: '侧边栏底部',
    description: '帮助、反馈、版本信息',
  },
  {
    id: 'app.page.header',
    host: 'web',
    label: '页面标题右侧',
    description: '导出、打印、分享',
  },
  {
    id: 'app.page.toolbar',
    host: 'web',
    label: '列表工具栏',
    description: '批量操作、字段设置',
  },
  {
    id: 'app.detail.panel',
    host: 'web',
    label: '详情页侧栏',
    description: '关联数据、评论、审批记录',
  },
  {
    id: 'app.api',
    host: 'server',
    label: '后端路由前缀',
    description: '组件的服务端能力，挂在应用后端的某个前缀下',
  },
] as const satisfies readonly SlotSpec[]

export type ComponentSlotId = (typeof COMPONENT_SLOTS)[number]['id']

const BY_ID = new Map<string, SlotSpec>(COMPONENT_SLOTS.map((s) => [s.id, s]))

export function findSlot(id: string): SlotSpec | undefined {
  return BY_ID.get(id)
}

export function isComponentSlot(id: string): id is ComponentSlotId {
  return BY_ID.has(id)
}

/** 插槽对应的宿主。插槽不认识时返回 null —— 调用方要转成 problem，不能给个默认值 */
export function slotHost(id: string): SlotHost | null {
  return BY_ID.get(id)?.host ?? null
}

/** 界面上的插槽下拉框直接吃这份 */
export function slotChoices(): ReadonlyArray<{ id: string; label: string; description: string }> {
  return COMPONENT_SLOTS.map((s) => ({ id: s.id, label: s.label, description: s.description }))
}
