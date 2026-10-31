/**
 * 每应用一个 harness（DESIGN §4.3）。
 *
 * 三个必须记住的点：
 * 1. **`resume()` 每个进程启动必须调**。少了它，崩溃中断的任务永远不会继续（SPIKES §2）。
 * 2. 一个 storage 只能被一个进程独占，所以同应用重复 acquire 必须复用同一个会话。
 * 3. 模型换了（用户改了设置）要 `configure` 到根会话上，否则新会话仍用旧模型 ——
 *    但只在真的变了才写，避免每次启动都产生一次无意义的 commit。
 */
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { TenonHome } from '@tenon/core'
import { appPaths } from '@tenon/core'
import type { ModelChoice, ResolvedModel } from './models.js'

const ctx = BACKGROUND_CONTEXT

export type RootConversation = Awaited<ReturnType<Harness['root']>>

export interface HarnessSession {
  readonly appId: string
  readonly harness: Harness
  readonly root: RootConversation
  readonly conversationId: RootConversation['id']
  close(): Promise<void>
}

export interface HarnessPoolOptions {
  home: TenonHome
  model: ResolvedModel
}

export class HarnessPool {
  private readonly sessions = new Map<string, Promise<HarnessSession>>()

  constructor(private readonly options: HarnessPoolOptions) {}

  get modelChoice(): ModelChoice {
    return this.options.model.choice
  }

  async acquire(appId: string): Promise<HarnessSession> {
    const existing = this.sessions.get(appId)
    if (existing !== undefined) return existing
    const opening = this.open(appId)
    this.sessions.set(appId, opening)
    try {
      return await opening
    } catch (err) {
      // 打开失败不要留下"永远失败"的缓存
      this.sessions.delete(appId)
      throw err
    }
  }

  private async open(appId: string): Promise<HarnessSession> {
    const paths = appPaths(this.options.home, appId)
    await mkdir(paths.tenonDir, { recursive: true })
    await mkdir(paths.runtimeDir, { recursive: true })

    const storage = await openNodeSqliteStorage(paths.harnessDb, { prefix: 'pi_' })
    const harness = await Harness.open(
      storage,
      { models: this.options.model.models, registry: createRegistry() },
      ctx,
    )

    // ★ 崩溃恢复的唯一开关
    const resumed: unknown = harness.resume()
    if (resumed instanceof Promise) {
      resumed.catch((err: unknown) => {
        console.error(`[tenon] ${appId} resume() 失败：`, err)
      })
    }

    const choice = this.options.model.choice
    const root = await harness.root(ctx, {
      agent: { model: { provider: choice.provider, modelId: choice.modelId }, cwd: paths.repoDir },
    })

    // 用户换过模型/目录时同步到已有会话（同一会话历史保留）
    const agent = await root.agent(ctx)
    const currentModel = agent.model
    const drifted =
      currentModel === undefined ||
      currentModel.modelId !== choice.modelId ||
      currentModel.provider !== choice.provider ||
      agent.cwd !== paths.repoDir
    if (drifted) {
      await root.configure(
        { model: { provider: choice.provider, modelId: choice.modelId }, cwd: paths.repoDir },
        ctx,
      )
    }

    let closed = false
    return {
      appId,
      harness,
      root,
      conversationId: root.id,
      async close() {
        if (closed) return
        closed = true
        await harness.close(ctx)
      },
    }
  }

  async release(appId: string): Promise<void> {
    const session = this.sessions.get(appId)
    if (session === undefined) return
    this.sessions.delete(appId)
    await (await session).close()
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(all.map(async (session) => (await session).close()))
  }

  /** 诊断用：当前打开了哪些应用的 harness */
  openApps(): string[] {
    return [...this.sessions.keys()]
  }
}

export function harnessDbPath(home: TenonHome, appId: string): string {
  return join(appPaths(home, appId).tenonDir, 'harness.sqlite')
}
