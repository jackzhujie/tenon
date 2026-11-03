/**
 * 审批流的服务端半边。
 *
 * **一个必须说清的限制**：v1 的审批数据只活在服务端对象里（chord state），进程重启即失。
 * 组件清单的权限是空的 —— 它没有数据库能力，宿主也没有给它 kv。这不是偷懒：
 * 要持久化就得先有"组件的存储"这个能力（M6 的 `db:*` 权限 + 命名空间隔离），
 * 在那之前假装持久化才是真问题。
 *
 * 两条业务规则写在方法里（而不是提示词里）：
 * 1. 空标题不许提交；
 * 2. 只有 `submitted` 的单子能通过/驳回 —— 已决的再审一次是典型的并发 bug。
 */
import { Type } from 'typebox'
import { invalid, type Host } from '@earendil-works/chord'
import { Approval, Item, type Principal } from './contract.js'

export interface ActivateInput {
  readonly host: Host<Principal>
  readonly appId: string
  readonly brain: { complete(input: { appId: string; text: string }): Promise<string> }
  readonly log?: (line: string) => void
}

const LINGER_MS = 2 * 60 * 60_000

export function activate(input: ActivateInput): void {
  const { host, appId } = input

  host.serve(
    Approval,
    ({ appId: inputAppId }, principal, self) => {
      if (inputAppId !== appId || principal.appId !== appId) {
        throw invalid('principal', `这个组件属于应用 ${appId}，不是 ${inputAppId}`)
      }
      const phase = self.state('phase', Type.String(), 'idle')
      const pending = self.state('pending', Type.Number(), 0)
      const items = self.state('items', Type.Array(Item), [])
      let nextId = 1

      const recount = (ctx: Parameters<typeof pending.replace>[0]): void => {
        pending.replace(ctx, items.value.filter((item) => item.state === 'submitted').length)
      }

      return {
        variant: 'user',
        phase,
        pending,
        items,

        submit: async ({ title }, ctx) => {
          const text = title.trim()
          if (text === '') throw invalid('empty', '标题不能为空')
          const id = `AP-${nextId++}`
          items.change(ctx, (list) => [...list, { id, title: text, state: 'submitted' }])
          phase.replace(ctx, 'submitted')
          recount(ctx)
          return { id }
        },

        decide: async ({ id, approve }, ctx) => {
          const item = items.value.find((entry) => entry.id === id)
          if (item === undefined) throw invalid('missing', `没有编号为 ${id} 的单子`)
          if (item.state !== 'submitted') {
            throw invalid('settled', `${id} 已经是「${item.state}」，不能再审一次`)
          }
          items.change(ctx, (list) =>
            list.map((entry) =>
              entry.id === id ? { ...entry, state: approve ? 'approved' : 'rejected' } : entry,
            ),
          )
          phase.replace(ctx, approve ? 'approved' : 'rejected')
          recount(ctx)
        },

        reset: async (ctx) => {
          items.replace(ctx, [])
          pending.replace(ctx, 0)
          phase.replace(ctx, 'idle')
        },
      }
    },
    { linger: LINGER_MS },
  )
}
