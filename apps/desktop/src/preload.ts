/**
 * 预加载脚本：把"壳里才知道的事"递给页面一层**最小的**桥。
 *
 * 为什么需要它：自动更新只有主进程能做（换安装包靠 Squirrel / NSIS），
 * 而界面是 `http://127.0.0.1:<port>` 上的普通网页 —— 它连 `process` 都没有
 * （`contextIsolation: true` + `sandbox: true`）。没有这层桥，
 * 「有新版本」这件事就只能靠 console 日志让人看见。
 *
 * 为什么只暴露这四个方法：页面永远不该有能力"执行任意 IPC"。
 * 每多一个通道，渲染进程被 XSS 时能碰到的东西就多一件（虽然页面是本机 server 发的，
 * 但生成的应用也在同一个窗口里跑）。
 *
 * 为什么打包成 CJS：沙箱化 preload 只支持 CJS，且只允许 `require('electron')`。
 * 所以 `build.mjs` 把它单独打一份 `dist/preload.cjs`，不并进 `main.mjs`（那是 ESM）。
 */
import { contextBridge, ipcRenderer } from 'electron'

interface BridgeState {
  phase: string
  currentVersion: string
  version: string | null
  percent: number | null
  message: string
  hint: string | null
}

const CHANNEL_CHANGED = 'tenon:update:changed'

const bridge = {
  /** 当前状态（页面刚打开时先拉一次，之后靠 `onState` 推） */
  state: (): Promise<BridgeState> => ipcRenderer.invoke('tenon:update:state') as Promise<BridgeState>,
  check: (): Promise<void> => ipcRenderer.invoke('tenon:update:check') as Promise<void>,
  download: (): Promise<void> => ipcRenderer.invoke('tenon:update:download') as Promise<void>,
  install: (): Promise<void> => ipcRenderer.invoke('tenon:update:install') as Promise<void>,
  /**
   * 订阅状态变化。返回取消订阅的函数 —— React 的 effect 清理必须能真的摘掉监听，
   * 否则每次热更新都叠一个，最后一次事件会触发 N 次 setState。
   */
  onState: (listener: (state: BridgeState) => void): (() => void) => {
    const handler = (_event: unknown, state: BridgeState): void => {
      listener(state)
    }
    ipcRenderer.on(CHANNEL_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(CHANNEL_CHANGED, handler)
    }
  },
}

contextBridge.exposeInMainWorld('__TENON_UPDATE__', bridge)
