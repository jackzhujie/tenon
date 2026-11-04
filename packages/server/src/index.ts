/**
 * 启动编排：core → 总线 → agent → HTTP。
 *
 * 顺序不能换：agent 的事件必须能立刻进总线，而总线要先存在。
 * **Electron 只负责 spawn 这个入口并读 `TENON_READY` 那行**，业务一律在这里面。
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { openCore, type CoreServices } from '@tenon/core'
import { pluginRoots, type PluginRoot } from '@tenon/component-host'
import { createAgentRuntime, type AgentRuntime, type PageDriverProvider } from '@tenon/agent'
import { PreviewManager, type PreviewManagerOptions } from '@tenon/gateway'
import { scaffoldApp } from '@tenon/generator'
import { buildServer, type TenonServer } from './app.js'
import { hubPluginsDir, resolveHubConfig } from '@tenon/component-host'
import { ComponentRuntime } from './components.js'
import { createComponentBridge, type AppComponentBridge } from './components-link.js'
import { SseBus } from './sse.js'

export { buildServer, dispatch, type BuildServerOptions, type TenonServer } from './app.js'
export { SseBus } from './sse.js'
export { createHandlers, type HandlerMap, type ServerDeps } from './handlers.js'
export {
  ComponentRuntime,
  activateComponents,
  type ActivatedComponents,
  type FacetActivation,
  type Principal,
} from './components.js'
export { requireBearer, extractToken } from './auth.js'

export interface StartServerOptions {
  env?: NodeJS.ProcessEnv
  host?: string
  /** 0 = 让系统分配（默认）。桌面版必须用 0，避免和别的实例打架 */
  port?: number
  token?: string
  version?: string
  logger?: boolean
  /** 给了就把渲染器产物同源发出去并注入 Token（Electron 壳 / Web 模式） */
  webDir?: string
  /** 测试用：库进内存，不碰真实 HOME */
  inMemoryDb?: boolean
  /**
   * 预览的可注入项。测试给一个 `launch`（stub 上游）+ `installDeps: false`
   * 就能把编排逻辑验完，不需要真的装 React。
   */
  preview?: Pick<
    PreviewManagerOptions,
    'launch' | 'launchApi' | 'database' | 'installDeps' | 'readyTimeoutMs' | 'apiReadyTimeoutMs' | 'log'
  >
  /**
   * 测试注入：页面通道（M4 第 4 步）。
   *
   * 给了就不走 `preview.pages(appId)`。集成测试验的是"子 Agent 能不能把断言发到页面、
   * 结果会不会回到对话里"，不该为了这个先装一遍 React、再起一个浏览器。
   * 真 DOM 由 `pnpm e2e:e2e` 在 Electron 里验。
   */
  pageDriver?: PageDriverProvider
  /**
   * 组件来源覆盖（M5）。不传就按 `TENON_HOME` 与环境算：`<home>/plugins` + `plugins/bundled`。
   * 测试给临时目录，免得"组件列表"依赖测试机上有没有真插件。
   */
  pluginRoots?: readonly PluginRoot[]
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly app: FastifyInstance
  readonly server: TenonServer
  readonly core: CoreServices
  readonly agent: AgentRuntime
  readonly preview: PreviewManager
  readonly components: ComponentRuntime
  close(): Promise<void>
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(24).toString('hex')

  // 建应用时铺模板：钩子由 server 注入，core 不认识 @tenon/generator（依赖方向见 DESIGN §3.2）
  const core = openCore({
    env,
    ...(options.inMemoryDb === true ? { inMemoryDb: true } : {}),
    scaffold: async (ctx) => {
      await scaffoldApp({
        repoDir: ctx.repoDir,
        appId: ctx.appId,
        appName: ctx.appName,
        appSlug: ctx.appSlug,
        templateId: ctx.templateId,
        env,
      })
    },
  })
  const bus = new SseBus()
  /*
   * preview 先于 agent 建：`onSchemaCommit` 要指向 `preview.snapshotDatabase`，
   * 而 `PreviewManager` 自己只依赖 core（不依赖 agent），换个顺序没有副作用。
   */
  const preview = new PreviewManager({
    home: core.home,
    env,
    publish: (event) => {
      bus.publish(event)
    },
    /*
     * 组件的浏览器半边（M5 第 3 步 b）：每个应用一个网关，所以这里按 appId 现建一个桥。
     * 桥自己不认识装配声明 —— 它每次都问 `ComponentRuntime`（幂等），
     * 这样"组件在预览之后才激活完"也能被接上。
     */
    components: (appId) => {
      const bridge = createComponentBridge({ appId, runtime: components })
      bridges.set(appId, bridge)
      return bridge
    },
    ...(options.preview ?? {}),
  })
  /*
   * 组件宿主要在 agent **之前**能拿到句柄：装组件这个工具需要"装完立刻生效"，
   * 而那时 ComponentRuntime 还没建（它依赖 agent）。用一个后填的引用即可 ——
   * 回调真正被调用时（用户装组件那一刻）它早已就位。
   */
  let componentsRef: ComponentRuntime | undefined
  const resolvedRoots = options.pluginRoots ?? pluginRoots({ env, homeRoot: core.home.root })
  /*
   * Hub 配置（M6）：`env > 随包 hub.json > 未配置`，见 `resolveHubConfig`。
   * **必须在建 agent 之前算**，因为 `install_component` 也要用它（本机没有就去 Hub 拿）。
   * 装到哪里与加载器的 hub 根**必须同一个** —— 否则"装成功了却加载不到"。
   */
  const hub = resolveHubConfig({ env })
  const hubConfig = hub.config
  const hubDir = hubPluginsDir(env, core.home.root)
  // 配了但不对（只给了一半、文件坏了）要说出来：静默当"未配置"会让排障停在"商店是空的"
  if (hub.note !== null) process.stderr.write(`[tenon] Hub 配置有问题，按未配置处理：${hub.note}\n`)
  const agent = createAgentRuntime({
    core,
    env,
    publish: (event) => {
      bus.publish(event)
    },
    /*
     * 一轮提交改了 schema 就给库打一份快照（判据在 `@tenon/core` 的 `hasSchemaChange`）。
     * 这里**吞掉返回值**：调用方只关心"存了没有"，失败会由 ChatService 转成一条 error 事件 ——
     * 存不了快照不该让一轮对话失败。
     */
    onSchemaCommit: async ({ appId, sha }) => {
      await preview.snapshotDatabase(appId, sha)
    },
    /*
     * e2e 子 Agent 的预览工具从这里拿到"那个应用的页面通道"。
     * 传的是**函数**不是快照：预览会在应用生命周期里反复起停，每次起都是新的一条通道。
     */
    getPageDriver: options.pageDriver ?? ((appId) => preview.pages(appId)),
    // 装/卸组件后重新激活：不这么做，用户装完看到的是"什么都没发生"
    components: {
      roots: resolvedRoots,
      tenonVersion: options.version ?? '0.0.0',
      onChanged: async (appId) => {
        await componentsRef?.reload(appId)
      },
      /*
       * 让 Agent 也能装"本机还没有"的组件（否则它只能说"请去插件页点一下"）。
       * 只给 config/dir：`origin`/`note` 是给界面解释"配置打哪来"的，工具不需要。
       */
      hub: { config: hubConfig, dir: hubDir },
    },
  })
  /** 每个应用的组件链路：进程退出/预览重起时要能收干净（wss 不会自己关） */
  const bridges = new Map<string, AppComponentBridge>()
  const components = new ComponentRuntime({
    home: core.home,
    agent,
    roots: resolvedRoots,
    // 组件的键值存储（M6 第 4 步）：命名空间由宿主按 (appId, 组件 id) 绑定
    store: core.components,
    tenonVersion: options.version ?? '0.0.0',
  })
  componentsRef = components
  const server = buildServer({
    core,
    agent,
    preview,
    bus,
    token,
    ...(options.version === undefined ? {} : { version: options.version }),
    pluginRoots: options.pluginRoots ?? pluginRoots({ env, homeRoot: core.home.root }),
    components,
    hub: { config: hubConfig, dir: hubDir, origin: hub.origin, note: hub.note },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.webDir === undefined ? {} : { web: { dir: options.webDir } }),
  })

  await server.app.listen({ host, port: options.port ?? 0 })
  const address = server.app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0)

  let closed = false
  return {
    url: `http://${host}:${port}`,
    port,
    token,
    app: server.app,
    server,
    core,
    agent,
    preview,
    components,
    async close() {
      if (closed) return
      closed = true
      await server.app.close()
      // 先停预览：dev server 是我们 spawn 的，进程别留在外面
      await preview.close()
      for (const bridge of bridges.values()) await bridge.close().catch(() => {})
      bridges.clear()
      await components.close()
      await agent.close()
      core.close()
    },
  }
}
