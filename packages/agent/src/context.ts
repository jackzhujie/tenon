/**
 * pi 的 `Context` 只有两种：前台（可交互）与后台（`BACKGROUND_CONTEXT`）。
 *
 * 我们全链路都是后台语义 —— server 是本地进程，等结果的是 HTTP 请求，没有"前台 UI 能打断当前步骤"
 * 这回事。把它从这里导出去，是为了让**上层（server / 测试）不必 import pi**：
 * 铁律 3 说的是"上游一次 minor 升级只在 adapter 里修"，导出这个常量也算 adapter 的一部分。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

export const agentContext = BACKGROUND_CONTEXT

export type AgentContext = typeof agentContext
