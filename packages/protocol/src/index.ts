/**
 * `@tenon/protocol` — 跨进程契约的唯一事实来源。
 *
 * 依赖方向（DESIGN §3.2）：`protocol` ← 全部。本包不得 import 任何其他 `@tenon/*`。
 */
export * from './errors.js'
export * from './domain.js'
export * from './transport.js'
export * from './rpc.js'
export * from './events.js'
export * from './result.js'
export * from './selection-text.js'
export * from './usage-format.js'
