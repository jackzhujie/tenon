/**
 * `@tenon/protocol/browser` — 浏览器只需要的那一小撮东西。
 *
 * 主入口带着整张 zod 校验表（`z.object(...)` 全在模块顶层求值，rollup 没法 tree-shake），
 * 而渲染器只用到传输常量与事件名清单。走这个子路径能把 zod 完全挡在产物之外。
 *
 * 规则：**这里只许放零运行时依赖的导出**。哪天有人往这儿加 schema，产物就会悄悄胖回去。
 */
export * from './transport.js'
export * from './event-names.js'
export * from './selection-text.js'
