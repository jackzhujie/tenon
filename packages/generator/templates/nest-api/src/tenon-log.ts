/**
 * 把页面里的异常送到 Tenon 的运行日志面板。
 *
 * 为什么是「模板里的一个文件」而不是一个 npm 包：
 * 生成的应用要在**任何机器上**装得起来，而 Tenon 的包没有发布到 npm。
 * 多一个依赖 = 多一个装不上的可能；一个 60 行的文件永远不会装不上。
 *
 * 为什么用相对路径 `/__tenon/log`：
 * 页面和这个接口同源（都在 App Gateway 上），所以**不需要任何配置**——
 * 不用知道端口、不用知道自己在桌面版还是 Web 版。这正是铁律 2 想要的样子：
 * 应用代码里没有一处"如果我在 X 环境里……"。
 *
 * 上报失败一律静默：这是观测通道，它坏了不该反过来把应用弄挂。
 */

/** App Gateway 截住的路径（它归平台，不转发给 Vite / Nest） */
const ENDPOINT = '/__tenon/log'

export type TenonLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface TenonLogPayload {
  level?: TenonLogLevel
  message: string
  /** 堆栈或任何长文本，面板里点开才看 */
  detail?: string | null
}

function post(body: string): void {
  try {
    // sendBeacon 在页面正在卸载时也能发出去（崩溃/跳转场景靠它）
    const blob = new Blob([body], { type: 'application/json' })
    if (navigator.sendBeacon?.(ENDPOINT, blob) === true) return
  } catch {
    // 某些环境禁用 Beacon，落到 fetch
  }
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // 上报通道本身绝不能再抛
  }
}

/** 主动上报一条。想在自己的 catch 里留痕时直接调它 */
export function reportLog(payload: TenonLogPayload): void {
  post(JSON.stringify({ source: 'web', level: 'error', ...payload }))
}

let installed = false

/**
 * 装上全局钩子：未捕获异常 + 未处理的 Promise 拒绝。
 * 重复调用是安全的（开发时热更新会重跑模块）。
 */
export function installTenonLog(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event) => {
    // 资源加载失败（<img> / <script>）也会走到这里，那时 event.error 是 null，
    // 消息里只有 `filename` 可用 —— 别指望它带堆栈
    const error: unknown = event.error
    const where =
      event.filename === '' || event.filename === undefined
        ? ''
        : `（${event.filename.split('/').pop() ?? event.filename}:${event.lineno ?? 0}）`
    const message =
      error instanceof Error
        ? error.message
        : event.message !== '' && event.message !== undefined
          ? event.message
          : '资源加载失败'

    reportLog({
      level: 'error',
      message: `未捕获异常：${message}${where}`,
      detail: error instanceof Error && typeof error.stack === 'string' ? error.stack : null,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    reportLog({
      level: 'error',
      message: `未处理的 Promise 拒绝：${reason instanceof Error ? reason.message : String(reason)}`,
      detail: reason instanceof Error && typeof reason.stack === 'string' ? reason.stack : null,
    })
  })
}
