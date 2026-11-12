/**
 * 组件链路（M5 第 3 步 b）：把网关的 `/__tenon/component` 接到 chord host 上。
 *
 * 这里是**唯一**同时认识 ws 与 chord 的地方：
 * - 网关不认识 chord（它只把 socket 交出来）；
 * - `@tenon/gateway` 不认识 `ws`（它连依赖都不带）；
 * - 组件不认识传输（它只认 `Host`）。
 *
 * 两个必须做对的地方：
 *
 * 1. **脚本要现取**。组件可能在预览起来之后才激活完（激活是异步的、跟着 preview.start 走）。
 *    所以 `script()` 每次都 `ensure()` 一次（幂等），而不是在网关构造时定死一份。
 * 2. **`?appId=` 写在脚本地址上**。脚本是静态文件，它自己不知道身在哪个应用；
 *    而装配声明是**每应用一份**，同一份 web.js 必须能服务所有应用。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { webSocketLink } from '@earendil-works/chord'
import { COMPONENT_SCRIPT_PATH, type ComponentBridge } from '@tenon/gateway'
import { getLocale } from '@tenon/protocol'
import type { ComponentRuntime } from './components.js'

export interface ComponentBridgeOptions {
  readonly appId: string
  readonly runtime: ComponentRuntime
  readonly log?: (line: string) => void
}

export interface AppComponentBridge extends ComponentBridge {
  close(): Promise<void>
}

export function createComponentBridge(options: ComponentBridgeOptions): AppComponentBridge {
  const log = options.log ?? ((line: string): void => void process.stderr.write(`${line}\n`))
  /*
   * `noServer: true`：握手由我们自己从网关转来的原始 socket 上做。
   * 我们不需要它监听任何端口 —— 网关已经在听，而且必须由网关听（同源）。
   */
  const wss = new WebSocketServer({ noServer: true })
  /** 缓存"上次读到的那份 web facet"，装���改了指向就重读 */
  let cached: { file: string; code: string } | null = null

  /** 这个应用的 web facet：磁盘上的绝对路径（没有就 null） */
  async function webFacetFile(): Promise<string | null> {
    const activated = await options.runtime.ensure(options.appId).catch((error: unknown) => {
      log(`[components] ${options.appId} failed to activate: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (activated === null) return null
    const target = activated.plan.targets.find((item) => item.facets.web !== null)
    return target === undefined || target.facets.web === null ? null : join(target.dir, target.facets.web)
  }

  return {
    scriptUrl: `${COMPONENT_SCRIPT_PATH}?appId=${encodeURIComponent(options.appId)}`,

    /*
     * 每次注入 HTML 时现读一次。
     *
     * 不从 `options` 传：语言是**进程级偏好**，真相在 `@tenon/protocol` 的 locale
     * 内核里（服务端启动时读设置、`settings.set` 时更新）。这里再存一份副本，
     * 就会在"切了语言但这份副本没跟上"的时候给页面注入旧语言 —— 而这种错
     * 只在刷新预览时才看得见，很容易被当成"没实现"。
     */
    get locale() {
      return getLocale()
    },

    async script() {
      const file = await webFacetFile()
      if (file === null) return null
      if (cached?.file === file) return cached.code
      const code = await readFile(file, 'utf8')
      cached = { file, code }
      return code
    },

    async upgrade(req, socket, head) {
      const activated = await options.runtime.ensure(options.appId).catch(() => null)
      if (activated === null) return false
      // 没有 web facet 的组件不需要链路：接管了也没人说话，只会白占一个 socket
      if (!activated.plan.targets.some((item) => item.facets.web !== null)) return false

      return await new Promise<boolean>((resolve) => {
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          /*
           * `principal` 是这个应用的用户身份。装配声明与 host 都是按应用分的，
           * 所以这里不需要更多信息 —— 但也正因为如此，**绝不能**把别的 appId 放进 principal：
           * 组件的 factory 里有一道 `input.appId === principal.appId` 的守卫。
           */
          activated.host.accept(webSocketLink(ws), { principal: { appId: options.appId } })
          resolve(true)
        })
      })
    },

    async close() {
      cached = null
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
        // 已建立的连接要主动关：wss.close 只停监听，不会替我们断现有 socket
        for (const client of wss.clients) client.terminate()
      })
    },
  }
}
