/**
 * 任务图服务（M4 第 2 步，DESIGN §5.5）。
 *
 * 把 pi 的 `watchTaskGraph` 包成"每个应用一份、可以随时问一句现在什么样"的东西，
 * 顺便把前端不认识的部分（`pi.` 前缀、角色）在这里处理掉。
 *
 * 三个不显然的点：
 *
 * 1. **必须 watch，不能只在 RPC 里查一次。** `harness.taskGraph()` 是快照，
 *    而一次派活会产生十几帧（pending → prepare → request → tools → 工具 execute →
 *    子会话 prepare → …）。前端要"实时"，只有 watch 拿得到这些中间态。
 *
 * 2. **角色要额外查一次 `getTask()`。** 图里只有 `kind: 'pi.tool'`，没有
 *    "这是 subagent、角色是 explore"。`checkpoint.arguments` 里有，但只在
 *    `phase: 'execute'` 之后才有 —— 所以判据是"工具 task 且已经拥有会话"
 *    （`tasksNeedingRole`），那个窗口里 arguments 一定齐了。
 *    查到结果（包括"查过但没有"）要缓存：帧很密，每帧重查就是把数据库当草稿纸。
 *
 * 3. **静止后图是空的。** 不是 bug，是 pi 的回收策略。所以这里也**不攒历史** ——
 *    攒了会给用户一个"看起来像最近活动"的假象，而它与真实发生过的事没有稳定关系。
 */
import type { Harness } from '@earendil-works/pi-durable'
import type { SseEventInput, TaskGraph } from '@tenon/protocol'
import { normalizeTaskGraph, tasksNeedingRole, type RawTaskGraph } from '@tenon/core'
import { agentContext as ctx } from './context.js'
import type { HarnessPool } from './harness-pool.js'

type GraphWatch = Awaited<ReturnType<Harness['watchTaskGraph']>>

interface Entry {
  readonly harness: Harness
  readonly rootConversationId: string
  readonly watch: GraphWatch
  /** taskId → 角色；`''` 表示"查过了，这个 task 没有角色"，别每帧重查 */
  readonly roles: Map<string, string>
  latest: TaskGraph
  /** 上次推出去的 JSON：一帧一推会有大量重复（工具 task 的 phase 不变但 checkpoint 在动） */
  published: string
  /** 串行链：watch 的投递是异步的，这里保证不会有两帧交叉写 latest */
  queue: Promise<void>
}

export interface TaskGraphServiceOptions {
  pool: HarnessPool
  publish: (event: SseEventInput) => void
}

/**
 * 从 tool task 的 checkpoint 里读角色。
 *
 * 一路 `unknown` 是故意的：这里读的是宿主的持久化结构，字段名变了我要的是
 * "没有角色"（面板显示成普通任务），而不是整个面板 500。
 */
async function readRole(harness: Harness, taskId: string): Promise<string | undefined> {
  try {
    const record: unknown = await harness.getTask(taskId as never, ctx)
    if (record === null || typeof record !== 'object') return undefined
    const state = (record as { state?: unknown }).state
    if (state === null || typeof state !== 'object') return undefined
    const checkpoint = (state as { checkpoint?: unknown }).checkpoint
    if (checkpoint === null || typeof checkpoint !== 'object') return undefined
    const args = (checkpoint as { arguments?: unknown }).arguments
    if (args === null || typeof args !== 'object') return undefined
    const role = (args as { role?: unknown }).role
    return typeof role === 'string' && role !== '' ? role : undefined
  } catch {
    return undefined
  }
}

export class TaskGraphService {
  private readonly entries = new Map<string, Promise<Entry>>()
  private closed = false

  constructor(private readonly options: TaskGraphServiceOptions) {}

  /**
   * 现在这一刻的图。
   *
   * 第一次调用会顺手把 watch 挂上（前端切应用时就会拉一次，所以"提交之前图已经开始看了"）。
   * 返回的可能是空图：静止时节点被回收，这是正确结果。
   */
  async snapshot(appId: string): Promise<TaskGraph> {
    const entry = await this.entry(appId)
    return entry.latest
  }

  /**
   * 提前把 watch 挂上，不关心返回值。
   *
   * `chat.submit` 之前调一次：用户可能在**还没切过应用布局**的情况下直接提交
   * （比如桌面版恢复上次会话），那时没有 `taskgraph.get` 打过前站，
   * 不预先挂 watch 就会漏掉这一轮的全部帧。
   */
  async ensure(appId: string): Promise<void> {
    await this.entry(appId)
  }

  private async entry(appId: string): Promise<Entry> {
    const existing = this.entries.get(appId)
    if (existing !== undefined) return existing
    const opening = this.open(appId)
    this.entries.set(appId, opening)
    try {
      return await opening
    } catch (err) {
      // 打开失败不要留下"永远失败"的缓存
      this.entries.delete(appId)
      throw err
    }
  }

  private async open(appId: string): Promise<Entry> {
    const session = await this.options.pool.acquire(appId)
    const watch = await session.harness.watchTaskGraph(ctx)
    const rootConversationId = String(session.conversationId)
    const entry: Entry = {
      harness: session.harness,
      rootConversationId,
      watch,
      roles: new Map(),
      latest: { rootConversationId, nodes: [] },
      published: '',
      queue: Promise.resolve(),
    }

    // watch.value 是"安装那一刻"的图：前端刷新页面时可能已经有节点在跑，先算这一份
    await this.apply(appId, entry, watch.value as unknown as RawTaskGraph)
    watch.start(async (value) => {
      await this.apply(appId, entry, value as unknown as RawTaskGraph)
    })
    return entry
  }

  private apply(appId: string, entry: Entry, raw: RawTaskGraph): Promise<void> {
    const next = entry.queue.then(async () => {
      if (this.closed) return
      for (const id of tasksNeedingRole(raw)) {
        if (entry.roles.has(id)) continue
        const role = await readRole(entry.harness, id)
        entry.roles.set(id, role ?? '')
      }
      const roles: Record<string, string> = {}
      for (const [id, role] of entry.roles) if (role !== '') roles[id] = role

      const graph = normalizeTaskGraph(raw, { rootConversationId: entry.rootConversationId, roles })
      const payload = JSON.stringify(graph)
      if (payload === entry.published) return
      entry.published = payload
      entry.latest = graph
      this.options.publish({ type: 'taskgraph.update', appId, graph })
    })
    // 单帧出错不能把整条链卡死：下一帧还得继续投递
    entry.queue = next.catch((err: unknown) => {
      console.error(`[tenon] task graph update failed (${appId}):`, err)
    })
    return entry.queue
  }

  /** 应用被删 / 重启 harness 时调用：不 stop 的话 watch 会拽着一个关掉的 session */
  async release(appId: string): Promise<void> {
    const pending = this.entries.get(appId)
    if (pending === undefined) return
    this.entries.delete(appId)
    try {
      const entry = await pending
      await entry.queue
      await entry.watch.stop()
    } catch {
      // 关闭阶段的失败不值得把调用方带崩
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.entries.keys()].map((appId) => this.release(appId)))
  }
}
