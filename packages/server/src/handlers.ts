/**
 * RPC 处理器表。
 *
 * 用 `satisfies HandlerMap` 让**契约与方法表在编译期强制对齐**：
 * 声明了方法却忘了实现，tsc 直接报错。运行期再叠一层 zod 输入/输出校验，
 * 防止「handler 返回了契约外的形状」这种更隐蔽的漂移。
 */
import type { CoreServices } from '@tenon/core'
import {
  SETTING_KEYS,
  ZERO_USAGE,
  appPaths,
  breached,
  budgetKey,
  files,
  gitops,
  isSchemaChange,
  levelOf,
  readBudget,
} from '@tenon/core'
import {
  ASSEMBLY_FILE,
  buildPlan,
  listAvailable,
  setComponentEnabled,
  type PluginRoot,
} from '@tenon/component-host'
import type { ComponentRuntime } from './components.js'
import type { AgentRuntime } from '@tenon/agent'
import type { PreviewManager } from '@tenon/gateway'
import { listTemplates } from '@tenon/generator'
import type {
  ModelState,
  RpcArgs,
  RpcMethod,
  RpcMethods,
  RpcOutput,
  UsageSnapshot,
} from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
import { pickSnapshot, type PickedSnapshot } from './revert-data.js'
import { inspectRelease, publishRelease } from './release.js'
import type { SseBus } from './sse.js'

export interface ServerDeps {
  core: CoreServices
  agent: AgentRuntime
  preview: PreviewManager
  /** 组件宿主（M5 第 3 步）：应用一运行就把它的 server facet 挂起来 */
  components: ComponentRuntime
  bus: SseBus
  version: string
  /**
   * 组件从哪里加载（`hub > bundled`）。由 `startServer` 按 `TENON_HOME` 与环境算出来，
   * 测试可以直接给一个临时目录 —— 组件加载不该要求测试机器上真装了官方插件。
   */
  plugins: { roots: readonly PluginRoot[] }
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

/**
 * 没配模型时的账本：用量为零，但**额度照读**。
 *
 * 关键在于额度是设置而不是账本 —— 用户完全可以先设好上限，再把 provider 配上。
 * 这里返回 level 也算出来，是因为拦截文案与面板都吃这一份形状，少一个字段前端就要分支。
 */
async function zeroUsage(appId: string, core: CoreServices): Promise<UsageSnapshot> {
  const budget = readBudget(core.settings, appId)
  return {
    appId,
    totals: ZERO_USAGE,
    models: {},
    tools: {},
    turn: ZERO_USAGE,
    budget,
    level: levelOf(ZERO_USAGE, budget),
    exceeded: breached(ZERO_USAGE, budget),
  }
}

/**
 * 把「设置改了」这件事翻译成界面能直接显示的一句话。
 *
 * 之所以两个分支都回 `ModelState` 而不是抛错：**设置本身已经写进去了**（磁盘上是新值），
 * 换不过去只说明"这回还用不了"。抛错会让用户以为保存失败，从而反复保存。
 */
async function applyAndReport(agent: AgentRuntime): Promise<ModelState> {
  const result = await agent.applyModel()
  if (!result.ok) return { model: null, error: result.error, changed: false }
  return {
    model: { mode: result.mode, providerId: result.providerId, modelId: result.modelId },
    error: null,
    changed: result.changed,
  }
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
      // 只停这一个应用的 watcher。这里**不能**调 `chat.close()` ——
      // 那会把 closed 置上，之后所有应用的 `app.status` 都不再落库也不再推事件
      // （表现：删掉一个应用之后，别的应用对话照跑，但界面永远转圈）
      await agent.chat?.detach(input.id)
      // 任务图的 watch 拽着 session，必须先停 —— 反过来会让 watch 回调踩到已关闭的 harness
      await agent.taskGraph?.release(input.id)
      await agent.usage?.release(input.id)
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
      // 先把任务图看起来：这一轮会产生十几帧，晚挂一步就漏掉开头（也会让面板在
      // 用户根本没切过布局的情况下一直空着）
      await agent.taskGraph?.ensure(input.appId)
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
      const started = await preview.start(input.appId, { restart: input.restart })
      /*
       * 组件挂载**在预览起来之后**做，且不等它：
       * 预览能不能打开是用户第一眼要看的东西，而组件加载再快也要 import 一堆代码。
       * 失败也不影响这次返回 —— 装不上的原因会进 `component.list` 的 problems。
       */
      void deps.components.ensure(input.appId).catch((error: unknown) => {
        process.stderr.write(
          `[components] ${input.appId} 激活失败：${error instanceof Error ? error.message : String(error)}\n`,
        )
      })
      return { preview: started }
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

    'taskgraph.get': async (input) => {
      core.apps.require(input.appId)
      // 没配模型时没有 harness，也就没有图。返回空图而不是报错：
      // 面板在"还没配模型"的状态下应该安静地不存在，而不是弹一条红色错误
      if (agent.taskGraph === undefined) {
        return { graph: { rootConversationId: '', nodes: [] } }
      }
      return { graph: await agent.taskGraph.snapshot(input.appId) }
    },

    'usage.get': async (input) => {
      core.apps.require(input.appId)
      // 同 taskgraph：没模型时给一份零账本，面板不显示、也不报错
      if (agent.usage === undefined) {
        return { snapshot: await zeroUsage(input.appId, core) }
      }
      return { snapshot: await agent.usage.snapshot(input.appId) }
    },

    'budget.set': async (input) => {
      core.apps.require(input.appId)
      const budget = { maxCostUsd: input.maxCostUsd, maxTokens: input.maxTokens }
      if (agent.usage === undefined) {
        // 没模型也能设额度（配好模型之后立刻生效），只是这里没有账本可读
        core.settings.set({ [budgetKey(input.appId)]: budget })
        return { snapshot: await zeroUsage(input.appId, core) }
      }
      return { snapshot: await agent.usage.setBudget(input.appId, budget) }
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

    'release.list': async (input) => {
      const app = core.apps.require(input.appId)
      return { releases: core.releases.list(app.id, input.limit) }
    },

    // 预检是只读的：不打 tag、不写记录、不消耗版本号。它跑得慢（真跑测试），
    // 但门禁的全部价值在于"发之前就知道"，而点了才知道等于没有
    'release.check': async (input) => {
      const app = core.apps.require(input.appId)
      return inspectRelease({ core, app })
    },

    'release.publish': async (input) => {
      const app = core.apps.require(input.appId)
      return publishRelease({ core, app, notes: input.notes, force: input.force === true })
    },

    'component.list': async (input) => {
      const app = core.apps.require(input.appId)
      const plan = await buildPlan({
        repoDir: appPaths(core.home, app.id).repoDir,
        roots: deps.plugins.roots,
        tenonVersion: deps.version,
      })
      /*
       * `installed` 只认装配声明 —— 不是"加载成功的那些"。开关关掉、装不上的，都算装过：
       * 插件页上它们已经在那份列表里了，再在"可安装"里出现一次会让人以为装了两份。
       */
      const installed = (plan.assembly?.components ?? []).map((c) => c.id)
      const available = await listAvailable({ roots: deps.plugins.roots, installed })
      return {
        components: [...plan.components],
        problems: [...plan.problems],
        available,
        assemblyFile: ASSEMBLY_FILE,
        tenonVersion: deps.version,
      }
    },

    'component.setEnabled': async (input) => {
      const app = core.apps.require(input.appId)
      const result = await setComponentEnabled({
        repoDir: appPaths(core.home, app.id).repoDir,
        roots: deps.plugins.roots,
        tenonVersion: deps.version,
        id: input.id,
        enabled: input.enabled,
      })
      // 关掉/打开都要让宿主重新激活：否则"关了但球还在"，直到重启
      await deps.components.reload(app.id)
      return { components: [...result.components], reloaded: true as const }
    },

    'settings.get': async () => ({ values: core.settings.all() }),

    'settings.set': async (input) => ({
      values: core.settings.set(input.values),
      applied: await applyAndReport(agent),
    }),

    'provider.list': async () => ({ profiles: core.providers.list() }),

    'provider.upsert': async (input) => {
      const profile = core.providers.upsert({
        id: input.id,
        label: input.label,
        kind: input.kind,
        baseUrl: input.baseUrl,
        tier: input.tier,
        modelId: input.modelId,
        paramsJson: input.paramsJson,
        apiKey: input.apiKey,
      })
      /*
       * 第一个提供商自动选中。用户刚填完 key 却什么都没发生，是这类设置页最常见的
       * 挫败感来源 —— 他没有理由知道"还要再去点一下启用"。
       */
      // 注意是 `== null`：`settings.get` 没这个键时返回 **undefined**（不是 null）
      if (core.settings.get(SETTING_KEYS.activeProviderId) == null) {
        core.settings.set({ [SETTING_KEYS.activeProviderId]: profile.id })
      }
      return { profile, applied: await applyAndReport(agent) }
    },

    'provider.test': async (input) => {
      const profile = core.providers.find(input.id)
      if (profile === undefined) return { ok: false, latencyMs: 0, message: '这个提供商不存在（可能刚被删掉）' }
      const apiKey = core.providers.revealApiKey(input.id)
      const base = (profile.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
      const started = Date.now()
      try {
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
          },
          // 只发"一句话、回几个字"：测的是端点与凭据，不是模型水平
          body: JSON.stringify({
            model: profile.modelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 16,
            stream: false,
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const latencyMs = Date.now() - started
        if (!response.ok) {
          const body = await response.text()
          // 提供商的原文比"连接失败"有用得多：401 是 key，404 多半是模型 id
          return { ok: false, latencyMs, message: `${response.status} ${body.slice(0, 400)}` }
        }
        return { ok: true, latencyMs, message: `端点与凭据都通（${profile.modelId}）` }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },

    'provider.delete': async (input) => {
      const wasActive = core.settings.get(SETTING_KEYS.activeProviderId) === input.id
      core.providers.delete(input.id)
      // 删掉的正好是当前用的那个：把选中项也清掉，否则下次启动会报"提供商已不存在"
      if (wasActive) core.settings.set({ [SETTING_KEYS.activeProviderId]: null })
      return { deleted: true, applied: await applyAndReport(agent) }
    },
  } satisfies HandlerMap
}

export type { RpcMethods }
