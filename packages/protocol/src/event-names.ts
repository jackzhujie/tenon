/**
 * SSE 事件名的运行时清单。**零运行时依赖**（`SseEventType` 是 type-only import，编译后消失）。
 *
 * 为什么需要这份清单：服务端给每条事件都发了 `event: <type>`，而 `EventSource` **只有**
 * 不带 `event:` 的帧才会触发 `onmessage` —— 所以客户端必须逐个 `addEventListener(type, ...)`。
 * 少列一种，那一类事件就会静默消失（典型症状：对话在流，但工具卡片永远不出现）。
 *
 * 为什么单独成文件：浏览器要用它，而 `events.ts` 顶层有 `z.object(...)` 求值，
 * 一旦从 `events.ts` 拿，整张 zod 表就会被打进前端产物（见 `transport.ts` 的注释）。
 * 一致性由 `events.ts` 里的两道编译期闸门保证：`satisfies` 防拼错、`_exhaustive` 防遗漏。
 */
import type { SseEventType } from './events.js'

export const sseEventTypes = [
  'message.delta',
  'message.end',
  'tool.start',
  'tool.output',
  'task.update',
  'usage',
  'app.status',
  'git.commit',
  'preview.ready',
  'preview.status',
  'app.log',
  'taskgraph.update',
  'error',
  'stream.reset',
] as const satisfies readonly SseEventType[]
