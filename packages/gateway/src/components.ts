/**
 * 组件的浏览���半边接入网关（M5 第 3 步 b）。
 *
 * 为什么走网关而不直连 Tenon server：**页面在网关的源上**。同源省掉一整类问题 ——
 * 不用发 token、不用配 CORS、不用担心 iframe 的 origin 校验；而网关本来就在这个进程里，
 * 它可以直接把 socket 交给宿主（`ComponentBridge.upgrade`）。
 *
 * 网关对 chord 一无所知：它只负责"两条路径归平台、别转给 Vite"和"往 HTML 里插一行脚本"。
 * 真正的 WS 握手与链路在 server 那一侧（`packages/server/src/components-link.ts`），
 * 这样网关的测试不需要一个 chord host，宿主的测试也不需要起一个网关。
 */
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import {
  COMPONENT_LOCALE_EVENT,
  COMPONENT_LOCALE_GLOBAL,
  COMPONENT_LOCALE_MESSAGE,
  type Locale,
} from '@tenon/protocol'

/** 页面加载的组件脚本（同源，所以相对路径就够） */
export const COMPONENT_SCRIPT_PATH = '/__tenon/component.js'
/** chord 链路的 WebSocket */
export const COMPONENT_WS_PATH = '/__tenon/component'

/*
 * 「组件怎么知道语言」的三个名字放在 `@tenon/protocol`：这套约定的三个使用方
 * （网关注入、界面广播、组件自己读）在两个包里，各写一份字符串迟早漂移 ——
 * 而漂移的表现是"组件永远停在英文"，看不出是拼错了。
 */
export { COMPONENT_LOCALE_EVENT, COMPONENT_LOCALE_GLOBAL, COMPONENT_LOCALE_MESSAGE }

/**
 * 注入标记，判重用。
 *
 * 与页面通道（`data-tenon-page`）同一个道理：重复注入会让同一个组件被挂两次，
 * 事件监听也翻倍 —— 切一次语言会重渲染两遍。它今天还没发生过，但注入点在
 * 代理的 HTML 改写里，上游缓存、重试、嵌套代理都可能让它跑第二遍。
 */
const INJECT_MARK = 'data-tenon-component-script'

export interface ComponentBridge {
  /**
   * 注入到页面里的脚本地址。给了 `<script type="module" src>` 就用它 ——
   * 带 `?appId=` 是因为脚本自己不知道身在哪个应用（网关是一个应用一个实例，但脚本是静态文件）。
   */
  readonly scriptUrl: string
  /**
   * 页面此刻该用的语言。
   *
   * 做成 getter 而不是构造时定死：用户在会话中途切语言，下一次注入 HTML
   * （刷新、换页）就该用新语言。已经挂上的组件不靠这个值 —— 那条路是
   * `postMessage`（见 `injectComponentScript`），因为重新拉一次 HTML 会丢掉页面状态。
   */
  readonly locale: Locale
  /**
   * `GET /__tenon/component.js` 的内容。
   *
   * 返回 null 表示"这个应用现在没有要注入的组件"（没装、被关掉、只装了服务端半边）——
   * 那时页面原样返回，一个字节都不多。**不要返回一个空脚本**：空脚本会让页面多一次
   * 请求、也会让"到底装没装"这个问题变得没有答案。
   */
  script(): Promise<string | null>
  /**
   * 接一条链路。返回 false = 不认这个升级请求（网关会把 socket 销毁）。
   *
   * 异步是必须的：组件可能在预览起来之后才激活完，这里要等它（幂等）。
   */
  upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean>
  /** 网关关闭时调（预览停了）。不给就等于"链路跟着进程走" */
  close?(): Promise<void>
}

/**
 * 往 HTML 里插组件脚本。
 *
 * 与页面通道那行脚本同一个插法（`</body>` 之前），但**独立一行**：两者可以都在，
 * 也可以只有一个（组件没装时这一行根本不出现）。
 *
 * ★ 前面那行小脚本是**错误捕手**，不是装饰：组件是模块脚本，它加载失败时浏览器只在控制台
 * 留一行，页面照常可用 —— 而"组件没出现"这个现象没有任何别的线索。M5 第 8 步就在这上面
 * 卡了半天：注入成功、端点 200、球却不在。所以从第一天起就把失败记到
 * `window.__tenonComponentErrors` 里，排查和端到端都读它。
 *
 * ★ 同一行脚本还负责**语言**，而且分两半：
 * - `window.__tenonLocale = "zh"` —— 首屏那一份。不另发一次 RPC 去问，
 *   是因为注入这一刻服务端就知道答案（语言就存在 `settings` 里）。
 * - `message` 监听 —— 用户切语言后，Tenon 界面往这个 iframe 发一条
 *   `{type: 'tenon:locale', locale}`，这里改全局并派发 `tenon:locale` 事件。
 *
 * 为什么语言要热更新而不能"下次刷新再说"：切语言是个立刻能看见的动作，
 * 用户切完盯着预览，孤零零一个中文球挂在英文界面上 —— 那比不支持双语更糟。
 * 而重载 iframe 会丢掉页面上正在填的表单，不能作为手段。
 */
export function injectComponentScript(
  html: string,
  scriptUrl: string,
  locale: Locale = 'en',
): string {
  if (html.includes(INJECT_MARK)) return html
  const name = COMPONENT_LOCALE_GLOBAL
  const catcher = [
    '<script>',
    'window.__tenonComponentErrors=[];',
    `window.${name}=${JSON.stringify(locale)};`,
    "addEventListener('message',function(e){var d=e&&e.data;",
    `if(!d||d.type!==${JSON.stringify(COMPONENT_LOCALE_MESSAGE)})return;`,
    "if(d.locale!=='en'&&d.locale!=='zh')return;",
    `if(window.${name}===d.locale)return;`,
    `window.${name}=d.locale;`,
    `try{dispatchEvent(new CustomEvent(${JSON.stringify(COMPONENT_LOCALE_EVENT)},{detail:d.locale}))}catch(_){}});`,
    "addEventListener('error',function(e){(window.__tenonComponentErrors||[]).push('error: '+(e&&e.message?e.message:String(e)));});",
    "addEventListener('unhandledrejection',function(e){(window.__tenonComponentErrors||[]).push('reject: '+(e&&e.reason&&e.reason.message?e.reason.message:String(e&&e.reason)));});",
    '</script>',
  ].join('')
  const tag = `${catcher}<script ${INJECT_MARK} type="module" src="${scriptUrl}"></script>`
  const at = html.lastIndexOf('</body>')
  if (at === -1) return `${html}\n${tag}\n`
  return `${html.slice(0, at)}${tag}\n${html.slice(at)}`
}
