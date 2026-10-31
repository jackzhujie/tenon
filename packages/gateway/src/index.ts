/**
 * `@tenon/gateway` —— 预览编排。
 *
 * 依赖方向：`server → gateway → {core, db-provisioner}`（用 `appPaths` 定位仓库、
 * 用 `scrubEnv` 洗环境、用 `DatabaseManager` 起应用库）。
 * 本包不碰 RPC：给它一个 appId + home，它把「数据库 + 网关 + dev server(+ 后端)」拉起来，
 * 通过 `publish` 回调把状态推给上层（上层转发成 SSE）。
 */
export { startGateway, type Gateway, type GatewayOptions, type GatewayStats, type Route } from './proxy.js'
export { findFreePort, findFreePorts } from './ports.js'
export { ensureDeps, type DepsResult, type EnsureDepsOptions } from './deps.js'
export {
  groupLaunched,
  nodeRunEnv,
  spawnLogged,
  type ExitInfo,
  type Launched,
  type SpawnOptions,
} from './child.js'
export { launchVite, type LaunchSpec, type Launcher } from './vite.js'
export { launchApi, resolveApiEntry, type ApiLaunchSpec, type ApiLauncher } from './api.js'
export { PreviewManager, type PreviewDatabase, type PreviewManagerOptions } from './preview.js'
