/**
 * 审批流的服务端半边。
 *
 * **数据存在哪**（M6 第 4 步）：宿主注入的 `storage`（按 `(应用, 组件)` 命名的键值空间）。
 * 整个审批状态（`items` + `nextId`）存成**一个键** `state`，理由是原子性：
 * 拆成两个键的话，"单子写进去了但 nextId 没写"会造出重复编号，而那种数据只有
 * 用户点开才发现。
 *
 * 两个必须处理好的点：
 * 1. **对象会被重建**（`linger` 过期、`reload`、真正的重启）。`self.state` 的初值
 *    只能来自激活那一刻的快照，所以这里维护一份进程内 `cache`：每次写存储时同步更新它。
 *    少了这一步，2 小时后的第一个请求会看到 2 小时前的数据 —— 而磁盘上明明是对的。
 * 2. **没有存储权限时要降级**：清单里没有 `db:read` / `db:write` 时 `storage` 是
 *    undefined，这时只在内存里跑，并**写进日志**。假装持久化才是真问题。
 *
 * 两条业务规则写在方法里（而不是提示词里）：
 * 1. 空标题不许提交；
 * 2. 只有 `submitted` 的单子能通过/驳回 —— 已决的再审一次是典型的并发 bug。
 */
import { Type } from 'typebox'
import { invalid, type Host } from '@earendil-works/chord'
import { Approval, Item, type Principal } from './contract.js'

/** 宿主注入的存储（与 `@tenon/component-host` 的 `ComponentStorage` 结构一致） */
export interface StorageLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<boolean>
  keys(prefix?: string): Promise<string[]>
  update(key: string, fn: (old: string | null) => string): Promise<string>
}

export interface ActivateInput {
  readonly host: Host<Principal>
  readonly appId: string
  readonly brain: { complete(input: { appId: string; text: string }): Promise<string> }
  /** 清单里没声明 `db:read` / `db:write` 时是 undefined */
  readonly storage?: StorageLike
  readonly log?: (line: string) => void
  /**
   * 当前界面语言。**传的是 getter，不是值** —— 激活结果跟着应用缓存
   * （`components.ts`：预览反复起停不该重建对象），而语言随时会被改。
   * 快照的后果是"切到中文之后，组件的报错还是英文"，直到应用重启。
   */
  readonly getLocale?: () => string
}

/*
 * ── 语言 ────────────────────────────────────────────────
 *
 * 浏览器半边从 `window.__tenonLocale` 拿语言（见 `web.ts`），服务端半边拿不到 ——
 * 它在服务器进程里，跨端只有 `activate` 那一次调用，所以语言由宿主递一个 getter 进
 * （`ActivateInput.getLocale`），每次报错时现取。
 *
 * 组件是**独立分发单元**：不 import 宿主的文案表（那会把几十 KB 塞进每个组件），
 * 各带一张 en/zh 小表 —— 与 `web.ts` 同一套做法。
 */
type Locale = 'en' | 'zh'

const TEXT = {
  principal: {
    en: (appId: string, other: string) => `this component belongs to app ${appId}, not ${other}`,
    zh: (appId: string, other: string) => `这个组件属于应用 ${appId}，不是 ${other}`,
  },
  emptyTitle: {
    en: () => 'the title cannot be empty',
    zh: () => '标题不能为空',
  },
  missing: {
    en: (id: string) => `no item with id ${id}`,
    zh: (id: string) => `没有编号为 ${id} 的单子`,
  },
  settled: {
    en: (id: string, state: string) => `${id} is already ${state} and cannot be reviewed again`,
    zh: (id: string, state: string) => `${id} 已经是「${state}」，不能再审一次`,
  },
}

const LINGER_MS = 2 * 60 * 60_000
const STATE_KEY = 'state'

interface Snapshot {
  readonly items: { id: string; title: string; state: string }[]
  readonly nextId: number
}

const EMPTY: Snapshot = { items: [], nextId: 1 }

/**
 * 从存储里恢复。**任何异常都退化成空状态并记一条日志** ——
 * 一条坏掉的历史数据不该让整个组件从此装不上（那会连"重置"都点不到）。
 */
async function restore(storage: StorageLike | undefined, log?: (line: string) => void): Promise<Snapshot> {
  if (storage === undefined) return EMPTY
  let raw: string | null
  try {
    raw = await storage.get(STATE_KEY)
  } catch (error) {
    log?.(`[approval] failed to read storage; starting with an empty state: ${error instanceof Error ? error.message : String(error)}`)
    return EMPTY
  }
  if (raw === null || raw === '') return EMPTY
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot>
    const items = Array.isArray(parsed.items) ? parsed.items : []
    /*
     * `nextId` 不从存储里盲信：历史数据里它可能缺、可能比现有编号小。
     * 取「存储值」与「现有最大编号 + 1」的较大者，宁可跳号也不重号。
     */
    const maxUsed = items.reduce((max, item) => {
      const match = /^AP-(\d+)$/.exec(item.id)
      return match === null ? max : Math.max(max, Number(match[1]))
    }, 0)
    const nextId = Math.max(typeof parsed.nextId === 'number' ? parsed.nextId : 1, maxUsed + 1)
    return { items, nextId }
  } catch (error) {
    log?.(`[approval] stored data is not valid JSON; starting with an empty state: ${String(error)}`)
    return EMPTY
  }
}

export async function activate(input: ActivateInput): Promise<void> {
  const { host, appId } = input
  /** 现取，不快照 —— 见 TEXT 上面那段 */
  const locale = (): Locale => (input.getLocale?.() === 'zh' ? 'zh' : 'en')

  if (input.storage === undefined) {
    input.log?.('[approval] no db:read / db:write permission; approvals live in memory only (lost on restart)')
  }
  let cache = await restore(input.storage, input.log)

  host.serve(
    Approval,
    ({ appId: inputAppId }, principal, self) => {
      if (inputAppId !== appId || principal.appId !== appId) {
        throw invalid('principal', TEXT.principal[locale()](appId, inputAppId))
      }
      const phase = self.state('phase', Type.String(), 'idle')
      /*
       * 待审计数的初值要**从恢复出来的单子算**。
       * 写死 0 的话，重启后徽标显示 0 而清单里明明有待审的 —— 用户会以为东西丢了，
       * 然后可能重复提交一次（这正是"数据在、但界面说没有"最坏的一种）。
       */
      const pending = self.state(
        'pending',
        Type.Number(),
        cache.items.filter((item) => item.state === 'submitted').length,
      )
      // 初值来自 `cache`（不是磁盘）：对象重建时它是最新的那份，见文件头第 1 点
      const items = self.state('items', Type.Array(Item), cache.items)
      let nextId = cache.nextId

      const recount = (ctx: Parameters<typeof pending.replace>[0]): void => {
        pending.replace(ctx, items.value.filter((item) => item.state === 'submitted').length)
      }

      /** 写回存储，并同步进程内快照 */
      const persist = async (): Promise<void> => {
        cache = { items: [...items.value], nextId }
        if (input.storage !== undefined) {
          await input.storage.set(STATE_KEY, JSON.stringify(cache))
        }
      }

      return {
        variant: 'user',
        phase,
        pending,
        items,

        submit: async ({ title }, ctx) => {
          const text = title.trim()
          if (text === '') throw invalid('empty', TEXT.emptyTitle[locale()]())
          const id = `AP-${nextId++}`
          items.change(ctx, (list) => [...list, { id, title: text, state: 'submitted' }])
          phase.replace(ctx, 'submitted')
          recount(ctx)
          await persist()
          return { id }
        },

        decide: async ({ id, approve }, ctx) => {
          const item = items.value.find((entry) => entry.id === id)
          if (item === undefined) throw invalid('missing', TEXT.missing[locale()](id))
          if (item.state !== 'submitted') {
            throw invalid('settled', TEXT.settled[locale()](id, item.state))
          }
          items.change(ctx, (list) =>
            list.map((entry) =>
              entry.id === id ? { ...entry, state: approve ? 'approved' : 'rejected' } : entry,
            ),
          )
          phase.replace(ctx, approve ? 'approved' : 'rejected')
          recount(ctx)
          await persist()
        },

        reset: async (ctx) => {
          items.replace(ctx, [])
          pending.replace(ctx, 0)
          phase.replace(ctx, 'idle')
          // 重置也要落盘，否则"清空过的"在重启后会全部回来
          cache = { items: [], nextId }
          if (input.storage !== undefined) await input.storage.delete(STATE_KEY)
        },
      }
    },
    { linger: LINGER_MS },
  )
}
