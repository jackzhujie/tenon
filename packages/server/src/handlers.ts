/**
 * RPC 处理器表。
 *
 * 用 `satisfies HandlerMap` 让**契约与方法表在编译期强制对齐**：
 * 声明了方法却忘了实现，tsc 直接报错。运行期再叠一层 zod 输入/输出校验，
 * 防止「handler 返回了契约外的形状」这种更隐蔽的漂移。
 */
import { lastCheckKey, readLastCheck, type CoreServices } from '@tenon/core'
import { join } from 'node:path'
import {
  SETTING_KEYS,
  ZERO_USAGE,
  appPaths,
  breached,
  budgetKey,
  currentMonth,
  files,
  gitops,
  isSchemaChange,
  levelOf,
  readBudget,
  readGlobalBudget,
  writeGlobalBudget,
} from '@tenon/core'
import {
  ASSEMBLY_FILE,
  buildPlan,
  fetchHubIndex,
  hubKeyFingerprint,
  installComponentWithHub,
  installFromHubIndex,
  listAvailable,
  listInstalledHubComponents,
  planHubUpdates,
  readAssembly,
  satisfiesRange,
  setComponentEnabled,
  uninstallComponent,
  type HubConfig,
  type HubConfigOrigin,
  type HubDeclaration,
  type PluginRoot,
} from '@tenon/component-host'
import type { ComponentRuntime } from './components.js'
import type { AgentRuntime } from '@tenon/agent'
import type { PreviewManager } from '@tenon/gateway'
import { exportStamp, exportStatic } from './export.js'
import { cleanStorage, reportStorage } from './storage.js'
import { applyApiFeature, applyAuthFeature, listTemplates } from '@tenon/generator'
import type {
  ComponentProblem,
  InstalledComponent,
  ModelState,
  RpcArgs,
  RpcMethod,
  RpcMethods,
  RpcOutput,
  UsageSnapshot,
} from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
import { pickSnapshot, type PickedSnapshot } from './revert-data.js'
import { inspectRelease, publishRelease, pushReleaseToRemote } from './release.js'
import type { SseBus } from './sse.js'

export interface ServerDeps {
  core: CoreServices
  agent: AgentRuntime
  preview: PreviewManager
  /** 组件宿主（M5 第 3 步）：应用一运行就把它的 server facet 挂起来 */
  components: ComponentRuntime
  /**
   * 官方 Hub（M6）。`config` 为 null 是**正常状态** —— 官方 Hub 上线前就是它，
   * 界面显示「筹备中」而不是报错。
   *
   * `origin` / `note` 是 M6 第 5 步补的：配置可能来自环境变量，也可能来自安装包里的
   * `hub.json`。界面必须说得出来自哪 —— 否则「商店是空的」只能靠猜（是没配？配错了？
   * 还是网络不通？）。
   */
  hub: {
    readonly config: HubConfig | null
    readonly dir: string
    readonly origin: HubConfigOrigin | null
    readonly note: string | null
  }
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
    // 没有模型就没有价格可言：这一格为 false 时界面不该显示 "$0.00"，那是在骗人
    priced: false,
  }
}

/** 往应用的日志面板推一条（依赖准备这类"不在对话里"的事，只有这里能说清） */
function pushTenonLog(
  bus: ServerDeps['bus'],
  appId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  detail: string | null = null,
): void {
  const now = Date.now()
  bus.publish({
    type: 'app.log',
    appId,
    entry: {
      id: `tenon-${appId}-${now}`,
      appId,
      at: now,
      source: 'tenon',
      level,
      message,
      detail,
      repeat: 1,
    },
  })
}

/** 重新算一遍装配计划（"现在这个应用到底是什么状态"的唯一来源） */
async function readPlan(
  core: CoreServices,
  deps: ServerDeps,
  appId: string,
): Promise<{ components: InstalledComponent[]; problems: ComponentProblem[] }> {
  const plan = await buildPlan({
    repoDir: appPaths(core.home, appId).repoDir,
    roots: deps.plugins.roots,
    tenonVersion: deps.version,
  })
  // readonly → 可变：出参会被 JSON 序列化，不该带 readonly
  return { components: [...plan.components], problems: [...plan.problems] }
}

/**
 * 所有应用装配声明里的组件条目。
 *
 * "哪些应用受影响"这个问题只能从这里答：组件装在本机是全局的，但**用不用它**由每个
 * 应用自己的 `app.components.json` 与版本区间决定。
 */
async function collectDeclarations(core: CoreServices): Promise<HubDeclaration[]> {
  const out: HubDeclaration[] = []
  for (const app of core.apps.list()) {
    const read = await readAssembly(appPaths(core.home, app.id).repoDir)
    if (read.kind !== 'ok') continue
    for (const entry of read.assembly.components) {
      out.push({ appId: app.id, id: entry.id, range: entry.version })
    }
  }
  return out
}

/**
 * 把「设置改了」这件事翻译成界面能直接显示的一句话。
 *
 * 之所以两个分支都回 `ModelState` 而不是抛错：**设置本身已经写进去了**（磁盘上是新值），
 * 换不过去只说明"这回还用不了"。抛错会让用户以为保存失败，从而反复保存。
 */
async function applyAndReport(agent: AgentRuntime, options: { force?: boolean } = {}): Promise<ModelState> {
  const result = await agent.applyModel(options)
  if (!result.ok) return { model: null, error: result.error, changed: false }
  return {
    model: { mode: result.mode, providerId: result.providerId, modelId: result.modelId },
    error: null,
    changed: result.changed,
  }
}

/**
 * 改价格之后让模型重新解析。
 *
 * 有应用正在跑就**不拆**：重解析会关掉 harness 会话，正在跑的那一轮直接断。
 * 这时候把话说明白（"这一轮结束后重启生效"），比悄悄不生效好。
 */
async function applyPriceChange(agent: AgentRuntime, core: CoreServices): Promise<ModelState> {
  const busy = core.apps.list().some((app) => app.status !== 'idle')
  if (busy) {
    const plan = agent.plan
    return {
      model:
        plan === undefined
          ? null
          : { mode: plan.mode, providerId: plan.choice.provider, modelId: plan.choice.modelId },
      error: '价格已保存，但有应用正在跑：这一轮结束后重启服务才生效',
      changed: false,
    }
  }
  return applyAndReport(agent, { force: true })
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
      /*
       * 建完就把依赖装上，**不等它**：装 React 要十几秒，建应用不该卡这么久。
       * 但也不放任它失败 —— 让 Agent 在第一轮跑 `tsc` 时撞上一堆 TS2688 更糟
       * （它会开始"修"一个不存在的类型错误，实测能烧掉好几轮）。
       * 失败写进日志面板，typecheck 那边另有一道"依赖没装好就别信类型错误"的守卫。
       */
      void deps.preview
        .ensureDeps(app.id)
        .then(async (result) => {
          if (!result.installed) return
          /*
           * install 会生成 `pnpm-lock.yaml`。**单独提交一次**，别让它掉进第一轮对话的 diff：
           * 一千多行的锁文件会把真正的改动挤出评审视图（`git_diff` 有 48KB 上限），
           * 而"这一轮改了什么"是评审唯一的输入。
           */
          const repoDir = appPaths(core.home, app.id).repoDir
          const committed = await gitops.commitAll(repoDir, 'chore: 锁定依赖版本')
          if (committed !== undefined) {
            bus.publish({
              type: 'git.commit',
              appId: app.id,
              sha: committed.sha,
              message: committed.message,
            })
          }
        })
        .catch((error: unknown) => {
          pushTenonLog(
            bus,
            app.id,
            'warn',
            '依赖没装好（不影响写代码，但类型检查会不准）',
            error instanceof Error ? error.message : String(error),
          )
        })
      return { app }
    },

    /* 改名只动库里的 `name`：目录与 slug 不变（见 `core.apps.rename` 的注释） */
    'app.rename': async (input) => ({ app: core.apps.rename(input.id, input.name) }),

    /*
     * 给已有应用加后端。
     *
     * 顺序是有讲究的，反过来每一步都会坏：
     * 1. 写文件（含 package.json 的 tenon.api）—— 之后网关才认为这个应用"有后端"
     * 2. 装依赖 —— Nest/TypeORM 都是新依赖，不装的话预览起来就报"找不到 @nestjs/core"
     * 3. 提交一次 —— 用户看得见"加了什么"，回滚也有落点（这不是 Agent 的一轮对话，
     *    没人会替它提交）
     * 4. 如果预览正开着就重启 —— 后端进程只在 `start` 时按 tenon.api 决定起不起，
     *    不重启的话用户看到的是"加了后端但 /api 还是 502"
     */
    'app.addBackend': async (input) => {
      const app = core.apps.require(input.id)
      const paths = appPaths(core.home, app.id)
      const result = await applyApiFeature({ repoDir: paths.repoDir })

      if (!result.applied) {
        return {
          applied: false,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          files: [],
          addedScripts: [],
          addedDependencies: [],
          notes: [],
          deps: null,
        }
      }

      for (const note of result.notes) pushTenonLog(bus, app.id, 'info', '加后端', note)

      let depsResult: { installed: boolean; command: string; durationMs: number } | null = null
      if (input.installDeps) {
        depsResult = await deps.preview.ensureDeps(app.id).catch((error: unknown) => {
          // 装不上不该回滚文件：代码是对的，网络/镜像的事修好之后重装就行
          pushTenonLog(
            bus,
            app.id,
            'warn',
            '后端依赖没装好（代码已写入，重装一次即可）',
            error instanceof Error ? error.message : String(error),
          )
          return null
        })
      }

      const committed = await gitops.commitAll(paths.repoDir, 'chore: 加上后端（NestJS + PostgreSQL）')
      if (committed !== undefined) {
        bus.publish({ type: 'git.commit', appId: app.id, sha: committed.sha, message: committed.message })
      }

      /*
       * 只在预览**本来就在跑**时重启。用户没开预览就不用起 —— 加个后端不该让界面
       * 突然弹出一个预览窗口（`start` 会占端口、起 vite 和 nest，代价不小）。
       */
      const state = preview.status(app.id).state
      if (state === 'ready' || state === 'starting') {
        await preview.start(app.id, { restart: true }).catch((error: unknown) => {
          pushTenonLog(
            bus,
            app.id,
            'warn',
            '重启预览失败，请手动点一次启动',
            error instanceof Error ? error.message : String(error),
          )
        })
      }

      return {
        applied: true,
        files: [...result.files],
        addedScripts: [...result.addedScripts],
        addedDependencies: [...result.addedDependencies],
        notes: [...result.notes],
        deps: depsResult,
      }
    },

    /*
     * 给已有应用加账号体系。步骤与加后端同构（写文件 → 装依赖 → 提交 → 重启预览），
     * 只有一处不同：`wired` 可能为 false（main.tsx 形状不匹配）。那不是失败 ——
     * 文件已经写好、接口已经开始 401 —— 但必须让调用方知道"页面上还没有登录框"。
     */
    'app.addAuth': async (input) => {
      const app = core.apps.require(input.id)
      const paths = appPaths(core.home, app.id)
      const result = await applyAuthFeature({ repoDir: paths.repoDir })

      if (!result.applied) {
        return {
          applied: false,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          addedBackend: false,
          files: [],
          wired: true,
          notes: [],
          deps: null,
        }
      }

      for (const note of result.notes) pushTenonLog(bus, app.id, 'info', '加登录', note)
      if (!result.wired) {
        pushTenonLog(
          bus,
          app.id,
          'warn',
          '登录页没自动接上',
          'src/main.tsx 的形状和模板不一样：请把 <App/> 包进 <AuthGate>。在那之前接口会 401，而页面上没有登录框。',
        )
      }

      let depsResult: { installed: boolean; command: string; durationMs: number } | null = null
      if (input.installDeps) {
        depsResult = await deps.preview.ensureDeps(app.id).catch((error: unknown) => {
          pushTenonLog(
            bus,
            app.id,
            'warn',
            '账号体系依赖没装好（代码已写入，重装一次即可）',
            error instanceof Error ? error.message : String(error),
          )
          return null
        })
      }

      const committed = await gitops.commitAll(paths.repoDir, 'chore: 加上登录与用户体系')
      if (committed !== undefined) {
        bus.publish({ type: 'git.commit', appId: app.id, sha: committed.sha, message: committed.message })
      }

      const state = preview.status(app.id).state
      if (state === 'ready' || state === 'starting') {
        await preview.start(app.id, { restart: true }).catch((error: unknown) => {
          pushTenonLog(
            bus,
            app.id,
            'warn',
            '重启预览失败，请手动点一次启动',
            error instanceof Error ? error.message : String(error),
          )
        })
      }

      return {
        applied: true,
        addedBackend: result.addedBackend,
        files: [...result.files],
        wired: result.wired,
        notes: [...result.notes],
        deps: depsResult,
      }
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
      /*
       * 装依赖是**建应用时就不等它**开始的后台任务（`app.create` 里 fire-and-forget）。
       * 它是个以 `repo/` 为 CWD 的子进程，所以删目录之前必须先掐掉它 ——
       * 否则 Windows 上目录直接删不掉（EBUSY），POSIX 上会留下半装的 node_modules。
       */
      await preview.cancelDeps(input.id)
      // 预览必须先停：dev server 还在写 node_modules / .vite 时删目录会留下半截图
      await preview.stop(input.id)
      // 日志缓冲跟着应用一起丢，否则删掉的应用还在内存里留着几百行
      preview.forget(input.id)
      // 预检存档也一起走：应用都没了，留着那条"上次检查没过"只是垃圾
      core.settings.remove(lastCheckKey(input.id))
      await core.apps.delete(input.id, input.removeFiles)
      return { deleted: true }
    },

    'chat.submit': async (input) => {
      const chat = requireChat(agent)
      /*
       * 等依赖就绪再开跑。这一等基本是零成本的：建应用时已经在装了，
       * 用户打字的时间通常够它装完；装不完也只是"第一句慢一点"，而不是
       * 让模型对着一个没有 node_modules 的工作区瞎猜。
       * 失败不拦这一轮 —— 写代码不需要 node_modules，只有类型检查需要。
       */
      await deps.preview.ensureDeps(input.appId).catch((error: unknown) => {
        pushTenonLog(
          bus,
          input.appId,
          'warn',
          '依赖没装好（不影响写代码，但类型检查会不准）',
          error instanceof Error ? error.message : String(error),
        )
      })
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

    'usage.total': async () => {
      /*
       * 应用列表在这里取，不让前端传上来：前端手上的列表可能是旧的（刚删过一个应用），
       * 而"合计对不上"是最难查的一类问题 —— 与其相信调用方，不如自己列一次。
       */
      const apps = core.apps.list().map((app) => ({ id: app.id, name: app.name }))
      if (agent.usage === undefined) {
        // 没配模型：没有账本，但额度照读（与 zeroUsage 同一个理由）
        return {
          totals: ZERO_USAGE,
          apps: apps.map((app) => {
            const budget = readBudget(core.settings, app.id)
            return {
              appId: app.id,
              name: app.name,
              totals: ZERO_USAGE,
              budget,
              level: levelOf(ZERO_USAGE, budget),
              known: false,
            }
          }),
          failed: [] as Array<{ appId: string; name: string; error: string }>,
          priced: false,
          generatedAt: Date.now(),
        }
      }
      return agent.usage.total(apps)
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

    /*
     * 全局额度（两道闸）。没配模型时也要能读能写：
     * 用户可以先设好上限，等接上模型立刻生效 —— 与 `budget.set` 同一条原则。
     * 只是没模型就没有账本，本月/累计一律回 0。
     */
    'budget.global': async () => {
      if (agent.usage === undefined) {
        return {
          budget: readGlobalBudget(core.settings),
          month: currentMonth(new Date()),
          monthUsed: ZERO_USAGE,
          totalUsed: ZERO_USAGE,
          unreadable: 0,
        }
      }
      return agent.usage.globalStatus()
    },

    'budget.global.set': async (input) => {
      const budget = { monthly: input.monthly, lifetime: input.lifetime }
      if (agent.usage === undefined) {
        writeGlobalBudget(core.settings, budget)
        return { budget: readGlobalBudget(core.settings) }
      }
      return { budget: await agent.usage.setGlobalBudget(budget) }
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
      const result = await inspectRelease({ core, app })
      /*
       * 存下来（v1.2.23）：预检是**真跑**测试，几十秒。门禁没过的时候用户会反复打开
       * 对话框看"还差什么" —— 每次重跑 30 秒才看到同样的三行，那才是真痛点。
       *
       * **只在真的跑了门禁时存**（`gate !== null`）：`blocked` 有值那种（工作区脏、
       * 没提交、正在生成）是**瞬时状态**，几分钟后就变了，存下来只会让下次打开
       * 看到一句已经过时的"工作区有未提交的改动"。
       */
      if (result.gate !== null) {
        core.settings.set({
          [lastCheckKey(app.id)]: {
            commitSha: result.commitSha,
            ready: result.ready,
            blocked: result.blocked,
            gate: result.gate,
            elapsedMs: result.elapsedMs,
            checkedAt: Date.now(),
          },
        })
      }
      return result
    },

    'release.lastCheck': async (input) => {
      const app = core.apps.require(input.appId)
      const check = readLastCheck(core.settings, app.id)
      if (check === null) return { check: null, reusable: false }
      /*
       * "能不能直接复用这份存档" —— 三条判据，全在这里算，因为前端既看不到工作区
       * 也看不到 HEAD。
       *
       * 第 2 条（工作区干净）是最容易被忘的那条：用户改了一半没提交时 HEAD 没变，
       * 只比 sha 会拿"上一版通过"去证明"这一版"。
       */
      const paths = appPaths(core.home, app.id)
      const head = await gitops.headSha(paths.repoDir).catch(() => null)
      const dirty = await gitops.uncommittedChanges(paths.repoDir).catch(() => ['?'])
      const reusable = head !== null && head === check.commitSha && dirty.length === 0
      return { check, reusable }
    },

    'release.publish': async (input) => {
      const app = core.apps.require(input.appId)
      const result = await publishRelease({ core, app, notes: input.notes, force: input.force === true })
      /*
       * 发布成功 = 那份预检存档"用掉了"。留着它会显示"上次检查：通过"，而那条结论讲的是
       * **已经发出去的那一版** —— 下一个版本的检查是全新的，从"还没查过"开始才对。
       */
      core.settings.remove(lastCheckKey(app.id))
      return result
    },

    /*
     * 远端仓库。四个方法的分工是刻意的：
     * - `release.remote` 读（永远不带令牌明文）
     * - `release.remote.set` 写（token 留空 = 不动已有的）
     * - `release.remote.clear` 删（和"保存一个空 token"必须是两件事）
     * - `release.push` 补推（本地那次发布已经成功了，别重跑门禁）
     */
    'release.remote': async (input) => {
      const app = core.apps.require(input.appId)
      return { remote: core.remotes.get(app.id) }
    },

    'release.remote.set': async (input) => {
      const app = core.apps.require(input.appId)
      // 地址校验在 store 里（`assertSafeRemoteUrl`）：只收 https、拒绝 url 里带凭据。
      // 放在那里而不是这里，是因为"能不能安全地存"是存储层的知识
      const remote = core.remotes.upsert({
        appId: app.id,
        url: input.url,
        username: input.username ?? null,
        token: input.token ?? null,
        branch: input.branch,
      })
      return { remote }
    },

    'release.remote.clear': async (input) => {
      const app = core.apps.require(input.appId)
      const existed = core.remotes.get(app.id) !== null
      core.remotes.clear(app.id)
      return { cleared: existed }
    },

    'release.push': async (input) => {
      const app = core.apps.require(input.appId)
      const outcome = await pushReleaseToRemote({ core, app, version: input.version })
      return { outcome }
    },

    /*
     * 导出静态包。构建与装依赖都在这里同步跑完（几十秒到几分钟），进度推到应用日志面板 ——
     * 否则用户会盯着一个不动的转圈，而"卡住"和"在编译"在界面上分不出来。
     */
    'export.static': async (input) => {
      const app = core.apps.require(input.appId)
      const paths = appPaths(core.home, app.id)
      /*
       * 产物按时间戳分目录，不按版本号：同一版代码可能导两次（改了配置、换机器），
       * 按版本号会让第二次覆盖第一次，而用户手上那份可能已经在服务器上了。
       */
      const outDir = join(paths.exportsDir, exportStamp())
      return exportStatic({
        repoDir: paths.repoDir,
        outDir,
        appName: app.name,
        appId: app.id,
        installDeps: input.installDeps,
        onLog: (line) => pushTenonLog(bus, app.id, 'info', '导出', line),
      })
    },

    /* Docker 构建上下文：同一份静态包 + 三个容器文件，依赖留给镜像里装 */
    'export.docker': async (input) => {
      const app = core.apps.require(input.appId)
      const paths = appPaths(core.home, app.id)
      return exportStatic({
        repoDir: paths.repoDir,
        outDir: join(paths.exportsDir, `${exportStamp()}-docker`),
        appName: app.name,
        appId: app.id,
        target: 'docker',
        port: input.port,
        onLog: (line) => pushTenonLog(bus, app.id, 'info', '导出', line),
      })
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

    'component.install': async (input) => {
      const app = core.apps.require(input.appId)
      const run = await installComponentWithHub({
        repoDir: appPaths(core.home, app.id).repoDir,
        roots: deps.plugins.roots,
        tenonVersion: deps.version,
        id: input.id,
        ...(input.version === undefined ? {} : { version: input.version }),
        // 本机没有就先去 Hub 拿。未配置时退化成"只装本机"，不报错
        hub: deps.hub,
      })

      // 下载失败优先报：装的问题在这种情况下根本没机会发生
      if (run.downloadError !== null) {
        throw new TenonError(run.downloadError.code, run.downloadError.message, {
          hint: run.downloadError.hint,
        })
      }

      // 装上之后立刻重新激活：否则用户点了"装"，界面上什么也没有（要等下次预览）
      await deps.components.reload(app.id)
      const plan = await readPlan(core, deps, app.id)
      return {
        components: plan.components,
        // 装失败时把"为什么装不上"而不是"现在有哪些问题"交回去
        problems: run.result.ok ? plan.problems : [...run.result.problems],
        downloaded: run.downloaded,
      }
    },

    'component.remove': async (input) => {
      const app = core.apps.require(input.appId)
      const result = await uninstallComponent({
        repoDir: appPaths(core.home, app.id).repoDir,
        roots: deps.plugins.roots,
        tenonVersion: deps.version,
        id: input.id,
      })
      await deps.components.reload(app.id)
      return { components: [...result.remaining], removed: result.removed }
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

    'hub.status': async () => {
      const config = deps.hub.config
      return {
        configured: config !== null,
        hubUrl: config?.hubUrl ?? null,
        keyFingerprint: config === null ? null : hubKeyFingerprint(config.publicKey),
        // 来源与"为什么没配上"（M6 第 5 步）：界面第一句就能回答"商店为什么是空的"
        origin: deps.hub.origin,
        note: deps.hub.note,
      }
    },

    'hub.check': async () => {
      const config = deps.hub.config
      const checkedAt = Date.now()
      if (config === null) {
        // 未配置是**正常状态**：官方 Hub 上线前就是它。返回空清单而不是抛错。
        return { reachable: false, error: null, checkedAt, keyFingerprint: null, components: [] }
      }

      const fetched = await fetchHubIndex({ config })
      if (!fetched.ok) {
        /*
         * 连不上**不是错误**：内置组件不需要 Hub，插件页要照常能用。
         * 把原因原文带回去，界面显示一行灰字就够 —— 抛错会让离线用户看到红屏，
         * 而"现在没网"完全不是故障。
         */
        return {
          reachable: false,
          error: fetched.problem.message,
          checkedAt,
          keyFingerprint: hubKeyFingerprint(config.publicKey),
          components: [],
        }
      }

      const installed = await listInstalledHubComponents(deps.hub.dir)
      return {
        reachable: true,
        error: null,
        checkedAt,
        keyFingerprint: fetched.value.keyFingerprint,
        // readonly → 可变（协议里的数组是可变的，出参会被 JSON 序列化，不该带 readonly）
        components: planHubUpdates({
          index: fetched.value.index,
          installed,
          declarations: await collectDeclarations(core),
        }).map((item) => ({ ...item, blockedBy: [...item.blockedBy] })),
      }
    },

    'hub.install': async (input) => {
      const config = deps.hub.config
      if (config === null) {
        throw new TenonError(
          'HUB_NOT_CONFIGURED',
          '官方 Hub 还没配置。设 TENON_HUB_URL 与 TENON_HUB_PUBLIC_KEY 之后才能从 Hub 安装组件。',
        )
      }

      // 地址来自**签名索引**，不由调用方给（否则"装的是不是用户以为的那个"没人管）
      const result = await installFromHubIndex({
        hubDir: deps.hub.dir,
        config,
        id: input.id,
        ...(input.version === undefined ? {} : { version: input.version }),
      })
      if (!result.ok) {
        // 三种分开：签名不对是安全问题，付费是"产品没做"，其余是"包/网络不对"
        const code =
          result.problem.code === 'bad-signature'
            ? 'HUB_BAD_SIGNATURE'
            : result.problem.code === 'paid-not-available'
              ? 'HUB_PAID_NOT_AVAILABLE'
              : 'HUB_BAD_BUNDLE'
        throw new TenonError(code, result.problem.message, {
          hint: result.problem.hint,
          reason: result.problem.code,
        })
      }

      /*
       * 装完只重新激活**真正会用上这一版**的应用：声明了这个组件，且区间接受新版本。
       * 不判区间的话，声明 ^1.0.0 的应用在装 2.0.0 之后被重载一次、结果版本没变 ——
       * 用户看到"更新了但没更新"，而日志里什么也没有。
       */
      let reloadedApps = 0
      for (const declaration of await collectDeclarations(core)) {
        if (declaration.id !== result.value.id) continue
        let accepts = false
        try {
          accepts = satisfiesRange(result.value.version, declaration.range)
        } catch {
          accepts = false
        }
        if (!accepts) continue
        try {
          await deps.components.reload(declaration.appId)
          reloadedApps += 1
        } catch {
          // 单个应用重载失败不该让"装好了"这个事实变成错误
        }
      }

      return {
        id: result.value.id,
        version: result.value.version,
        dir: result.value.dir,
        keyFingerprint: result.value.keyFingerprint,
        reloadedApps,
      }
    },

    'price.list': async (input) => ({ prices: core.prices.list(input.profileId) }),

    /*
     * 改价格为什么要把模型重新解析一遍：`model.cost` 是在 `resolveModel` 那一刻
     * 烤进 provider 的，pi 之后只用这份快照算钱。不重解析的话，用户填了价、
     * 面板还是 $0.00 —— 而"填了没反应"比没有这个功能更让人怀疑。
     */
    'price.set': async (input) => {
      const price = core.prices.upsert({
        profileId: input.profileId,
        modelId: input.modelId,
        inputPerMTok: input.inputPerMTok,
        outputPerMTok: input.outputPerMTok,
        cacheReadPerMTok: input.cacheReadPerMTok,
        cacheWritePerMTok: input.cacheWritePerMTok,
      })
      return { price, applied: await applyPriceChange(agent, core) }
    },

    'price.remove': async (input) => {
      const removed = core.prices.remove(input.id)
      return { removed, applied: await applyPriceChange(agent, core) }
    },

    'provider.delete': async (input) => {
      const wasActive = core.settings.get(SETTING_KEYS.activeProviderId) === input.id
      // 价格跟着 provider 走：留着孤儿行只会在"同一家再建一个 provider"时张冠李戴
      core.prices.removeByProfile(input.id)
      core.providers.delete(input.id)
      // 删掉的正好是当前用的那个：把选中项也清掉，否则下次启动会报"提供商已不存在"
      if (wasActive) core.settings.set({ [SETTING_KEYS.activeProviderId]: null })
      return { deleted: true, applied: await applyAndReport(agent) }
    },

    /*
     * `~/.tenon` 的体积（BACKLOG 3.3）。
     *
     * 名字优先从 store 取，取不到就退回 appId —— 后者不是兜底洁癖：删除失败的
     * 应用会留下一个没有记录的目录，而它恰恰是"不知道为什么占了 200MB"的常见来源。
     * 只认 store 的话，这种残骸在界面上会直接消失。
     */
    'storage.report': async () => {
      const labels = new Map(core.apps.list(true).map((app) => [app.id, app.name]))
      return reportStorage(core.home, labels)
    },
    'storage.clean': async (input) => {
      if (input.kind === 'deps') {
        /*
         * 删依赖前先看预览：正在跑的应用删掉 node_modules 会当场崩，
         * 而用户看到的是一句"预览挂了"，不会联想到自己刚点了清理。
         */
        const targets =
          input.appId === undefined || input.appId === null
            ? core.apps.list(true).map((app) => app.id)
            : [input.appId]
        for (const appId of targets) {
          const state = deps.preview.status(appId).state
          if (state === 'ready' || state === 'starting') {
            throw new TenonError(
              'APP_BUSY',
              `「${appId}」的预览正在运行。先停掉预览再清理依赖 —— 否则它会在下一次请求时突然报找不到模块。`,
            )
          }
        }
      }
      return cleanStorage(core.home, {
        kind: input.kind,
        ...(input.appId === undefined ? {} : { appId: input.appId }),
        ...(input.keep === undefined ? {} : { keep: input.keep }),
      })
    },
  } satisfies HandlerMap
}

export type { RpcMethods }
