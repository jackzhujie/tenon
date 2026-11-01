/**
 * RPC 处理器表。
 *
 * 用 `satisfies HandlerMap` 让**契约与方法表在编译期强制对齐**：
 * 声明了方法却忘了实现，tsc 直接报错。运行期再叠一层 zod 输入/输出校验，
 * 防止「handler 返回了契约外的形状」这种更隐蔽的漂移。
 */
import type { CoreServices } from '@tenon/core'
import { appPaths, files, gitops, isSchemaChange } from '@tenon/core'
import type { AgentRuntime } from '@tenon/agent'
import type { PreviewManager } from '@tenon/gateway'
import { listTemplates } from '@tenon/generator'
import type { RpcArgs, RpcMethod, RpcMethods, RpcOutput } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
import { pickSnapshot, type PickedSnapshot } from './revert-data.js'
import type { SseBus } from './sse.js'

export interface ServerDeps {
  core: CoreServices
  agent: AgentRuntime
  preview: PreviewManager
  bus: SseBus
  version: string
}

export type Handler<M extends RpcMethod> = (input: RpcArgs<M>) => Promise<RpcOutput<M>>
export type HandlerMap = { [M in RpcMethod]: Handler<M> }

function requireChat(agent: AgentRuntime): NonNullable<AgentRuntime['chat']> {
  if (agent.chat === undefined) {
    throw new TenonError(
      'AGENT_NO_MODEL',
      '还没有可用的模型。请在设置里添加提供商并填入 API Key；开发调试可设 TENON_FAUX=1。',
    )
  }
  return agent.chat
}

export function createHandlers(deps: ServerDeps): HandlerMap {
  const { core, agent, preview, bus } = deps

  return {
    health: async () => ({
      ok: true,
      version: deps.version,
      tenonHome: core.home.root,
      model:
        agent.plan === undefined
          ? null
          : {
              mode: agent.plan.mode,
              providerId: agent.plan.choice.provider,
              modelId: agent.plan.choice.modelId,
            },
      openApps: agent.pool?.openApps() ?? [],
      sseSubscribers: bus.subscriberCount,
    }),

    'app.list': async (input) => ({ apps: core.apps.list(input.includeArchived) }),

    'app.get': async (input) => {
      const app = core.apps.require(input.id)
      const commits = await gitops.log(appPaths(core.home, app.id).repoDir, 1)
      return {
        app,
        releases: core.releases.list(app.id),
        lastCommit: commits[0] ?? null,
      }
    },

    'app.create': async (input) => {
      const app = await core.apps.create({
        name: input.name,
        templateId: input.templateId,
        styleId: input.styleId,
        ...(input.description === undefined ? {} : { description: input.description }),
      })
      bus.publish({ type: 'app.status', appId: app.id, status: app.status })
      return { app }
    },

    'app.delete': async (input) => {
      await agent.chat?.close()
      await agent.pool?.release(input.id)
      // 预览必须先停：dev server 还在写 node_modules / .vite 时删目录会留下半截图
      await preview.stop(input.id)
      // 日志缓冲跟着应用一起丢，否则删掉的应用还在内存里留着几百行
      preview.forget(input.id)
      await core.apps.delete(input.id, input.removeFiles)
      return { deleted: true }
    },

    'chat.submit': async (input) => {
      const chat = requireChat(agent)
      const { appId, ...rest } = input
      const result = await chat.submit(appId, rest)
      return result
    },

    'chat.stop': async (input) => {
      const chat = requireChat(agent)
      return { stopped: await chat.stop(input.appId) }
    },

    'chat.history': async (input) => {
      const chat = requireChat(agent)
      return chat.history(input.appId, input.limit)
    },

    'template.list': async () => {
      const templates = await listTemplates()
      return {
        templates: templates.map((template) => ({
          id: template.id,
          label: template.label,
          description: template.description,
          entry: template.entry,
          variables: [...template.variables],
          notes: [...template.notes],
        })),
      }
    },

    'preview.start': async (input) => {
      core.apps.require(input.appId)
      return { preview: await preview.start(input.appId, { restart: input.restart }) }
    },

    'preview.stop': async (input) => ({ preview: await preview.stop(input.appId) }),

    'preview.status': async (input) => ({ preview: preview.status(input.appId) }),

    /*
     * 日志缓冲在 `PreviewManager` 里（跟着应用走，不跟着预览跑），
     * 所以这两个处理器只是转发 —— 但**不能省**：SSE 只推连上之后发生的事，
     * 切回一个早就跑着的应用时，历史日志只能靠 `logs.list` 拿。
     */
    'logs.list': async (input) => ({
      entries: preview.logs(input.appId, {
        limit: input.limit,
        ...(input.sources === undefined ? {} : { sources: input.sources }),
        ...(input.minLevel === undefined ? {} : { minLevel: input.minLevel }),
      }),
    }),

    'logs.clear': async (input) => ({ cleared: preview.clearLogs(input.appId) }),

    'plan.get': async (input) => {
      const chat = requireChat(agent)
      return { tasks: await chat.plan(input.appId) }
    },

    'files.tree': async (input) => {
      const app = core.apps.require(input.appId)
      const nodes = await files.filesTree(appPaths(core.home, app.id).repoDir, input.depth)
      return { nodes }
    },

    'files.read': async (input) => {
      const app = core.apps.require(input.appId)
      return files.readWorkspaceFile(appPaths(core.home, app.id).repoDir, input.path)
    },

    'git.log': async (input) => {
      const app = core.apps.require(input.appId)
      return { commits: await gitops.log(appPaths(core.home, app.id).repoDir, input.limit) }
    },

    'git.diff': async (input) => {
      const app = core.apps.require(input.appId)
      return gitops.diff(appPaths(core.home, app.id).repoDir, input.from, input.to)
    },

    'git.show': async (input) => {
      const app = core.apps.require(input.appId)
      const repoDir = appPaths(core.home, app.id).repoDir
      const shown = await gitops.showCommit(repoDir, input.sha)
      return {
        ...shown,
        schemaChanged: shown.changes.some((change) => isSchemaChange(change.path)),
        hasSnapshot: (await preview.findDatabaseSnapshot(app.id, shown.commit.sha)) !== null,
      }
    },

    'git.revert': async (input) => {
      const app = core.apps.require(input.appId)
      const repoDir = appPaths(core.home, app.id).repoDir

      /*
       * 顺序是刻意的：**检查 → 还原数据 → 回滚代码**。
       *
       * 覆盖数据库不可逆，回滚代码可逆（再回滚一次就回来了）。所以凡是可能失败、
       * 且失败后不该动任何东西的判断，都要挤在最前面做完 —— 不能出现
       * "库已经被旧数据覆盖了，然后发现这个提交根本没法回滚"。
       */
      const plan = await gitops.planRevert(repoDir, input.sha)

      let restore: PickedSnapshot | null = null
      if (input.dbRestore) {
        // 目标提交动了 schema 才值得还原；但用户勾了就该照做 —— 也可能是他知道
        // 那一版虽然没改 schema，却写坏了数据。所以这里不按 schemaChanged 卡。
        restore = await pickSnapshot(plan.ancestors, (sha) =>
          preview.findDatabaseSnapshot(app.id, sha),
        )
        if (restore === null) {
          throw new TenonError(
            'DB_SNAPSHOT_MISSING',
            '这一版之前没有可用的数据库快照（只有改过表结构的提交才会存快照），所以数据没有动。' +
              '取消勾选「连数据一起回滚」可以只回滚代码。',
            { sha: plan.targetSha },
          )
        }

        // 先停预览：还原会销毁 PGlite 实例，Nest 还连着的话会刷一屏断连错误
        await preview.stop(app.id)
        await preview.restoreDatabase(app.id, restore.snapshot)
      }

      const result = await gitops.revert(repoDir, input.sha, { appId: app.id })
      const commits = await gitops.log(repoDir, 1)
      const commit = commits[0]
      if (commit === undefined) {
        throw new TenonError('GIT_REVERT_FAILED', '回滚提交已写入但读不回来')
      }
      bus.publish({ type: 'git.commit', appId: app.id, sha: result.sha, message: result.message })
      return {
        commit,
        data: {
          requested: input.dbRestore,
          restored: restore !== null,
          fromSha: restore?.sha ?? null,
          skippedCommits: restore?.skipped ?? 0,
        },
      }
    },

    'settings.get': async () => ({ values: core.settings.all() }),

    'settings.set': async (input) => ({ values: core.settings.set(input.values) }),

    'provider.list': async () => ({ profiles: core.providers.list() }),

    'provider.upsert': async (input) => ({
      profile: core.providers.upsert({
        id: input.id,
        label: input.label,
        kind: input.kind,
        baseUrl: input.baseUrl,
        tier: input.tier,
        modelId: input.modelId,
        paramsJson: input.paramsJson,
        apiKey: input.apiKey,
      }),
    }),

    'provider.delete': async (input) => {
      core.providers.delete(input.id)
      return { deleted: true }
    },
  } satisfies HandlerMap
}

export type { RpcMethods }
