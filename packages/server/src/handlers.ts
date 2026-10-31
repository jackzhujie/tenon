/**
 * RPC 处理器表。
 *
 * 用 `satisfies HandlerMap` 让**契约与方法表在编译期强制对齐**：
 * 声明了方法却忘了实现，tsc 直接报错。运行期再叠一层 zod 输入/输出校验，
 * 防止「handler 返回了契约外的形状」这种更隐蔽的漂移。
 */
import type { CoreServices } from '@tenon/core'
import { appPaths, files, gitops } from '@tenon/core'
import type { AgentRuntime } from '@tenon/agent'
import type { PreviewManager } from '@tenon/gateway'
import { listTemplates } from '@tenon/generator'
import type { RpcArgs, RpcMethod, RpcMethods, RpcOutput } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
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

    'git.revert': async (input) => {
      const app = core.apps.require(input.appId)
      const result = await gitops.revert(appPaths(core.home, app.id).repoDir, input.sha, {
        appId: app.id,
      })
      const commits = await gitops.log(appPaths(core.home, app.id).repoDir, 1)
      const commit = commits[0]
      if (commit === undefined) {
        throw new TenonError('GIT_REVERT_FAILED', '回滚提交已写入但读不回来')
      }
      bus.publish({ type: 'git.commit', appId: app.id, sha: result.sha, message: result.message })
      return { commit }
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
