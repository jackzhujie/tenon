/**
 * `@tenon/gateway` —— 预览编排。
 *
 * 依赖方向：`server → gateway → core`（用 `appPaths` 定位仓库、用 `scrubEnv` 洗环境）。
 * 本包不碰数据库、不认识 RPC：给它一个 appId + home，它把「网关 + dev server」拉起来，
 * 通过 `publish` 回调把状态推给上层（上层转发成 SSE）。
 */
export { startGateway, type Gateway, type GatewayOptions, type GatewayStats, type Route } from './proxy.js'
export { findFreePort, findFreePorts } from './ports.js'
export { ensureDeps, type DepsResult, type EnsureDepsOptions } from './deps.js'
export { launchVite, type Launched, type Launcher, type LaunchSpec } from './vite.js'
export { PreviewManager, type PreviewManagerOptions } from './preview.js'
