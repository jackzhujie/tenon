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

import { msg, type ComponentMessageKey } from '@tenon/protocol'

export type SlotHost = 'web' | 'server'

export interface SlotSpec {
  readonly id: string
  readonly host: SlotHost
  /**
   * 界面/文档里给人看的名字。存**键**不存句子：这两行会出现在商店的挂载点下拉里，
   * 要跟着界面语言走，而模块级常量在 import 时就固化了语言。
   */
  readonly labelKey: ComponentMessageKey
  readonly descriptionKey: ComponentMessageKey
}

export const COMPONENT_SLOTS = [
  {
    id: 'app.shell.overlay',
    host: 'web',
    labelKey: 'component.slot.overlay.label',
    descriptionKey: 'component.slot.overlay.description',
  },
  {
    id: 'app.shell.sidebar.bottom',
    host: 'web',
    labelKey: 'component.slot.sidebar.label',
    descriptionKey: 'component.slot.sidebar.description',
  },
  {
    id: 'app.page.header',
    host: 'web',
    labelKey: 'component.slot.header.label',
    descriptionKey: 'component.slot.header.description',
  },
  {
    id: 'app.page.toolbar',
    host: 'web',
    labelKey: 'component.slot.toolbar.label',
    descriptionKey: 'component.slot.toolbar.description',
  },
  {
    id: 'app.detail.panel',
    host: 'web',
    labelKey: 'component.slot.detail.label',
    descriptionKey: 'component.slot.detail.description',
  },
  {
    id: 'app.api',
    host: 'server',
    labelKey: 'component.slot.api.label',
    descriptionKey: 'component.slot.api.description',
  },
] as const satisfies readonly SlotSpec[]

export type ComponentSlotId = (typeof COMPONENT_SLOTS)[number]['id']

const BY_ID = new Map<string, SlotSpec>(COMPONENT_SLOTS.map((s) => [s.id, s]))

/**
 * 挂载点的名字与说明（商店里那个下拉）。
 *
 * 存键、调用时才取句子：模块级常量在 import 那一刻就把语言定死了，
 * 而用户可以在运行中切语言 —— 那之后所有"缓存下来的句子"都是错的。
 */
export function slotLabel(spec: SlotSpec): string {
  return msg(spec.labelKey)
}

export function slotDescription(spec: SlotSpec): string {
  return msg(spec.descriptionKey)
}

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

/** 界面上的插槽下拉框直接吃这份（每次调用都按当前语言取一次） */
export function slotChoices(): ReadonlyArray<{ id: string; label: string; description: string }> {
  return COMPONENT_SLOTS.map((s) => ({ id: s.id, label: slotLabel(s), description: slotDescription(s) }))
}
