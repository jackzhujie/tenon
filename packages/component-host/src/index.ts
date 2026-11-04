/**
 * `@tenon/component-host` — 组件体系的地基（M5）。
 *
 * 依赖方向：`protocol` ← `component-host` ← `server` / `generator` / 桌面壳。
 * 这一层不加载 chord、不碰 React，只回答四个问题：
 *
 * 1. 磁盘上有哪些组件？（`resolve.ts` / `roots.ts`）
 * 2. 这个应用的装配声明说了什么？（`assembly.ts`）
 * 3. 这份清单合不合法、权限认不认？（`manifest.ts`）
 * 4. 这次到底加载谁、按什么顺序、哪条装不上？（`plan.ts`）
 *
 * 真正的 `host.load()` 在壳生成器里（M5 第 3 步），因为那需要 chord 与应用的 Vite。
 */
export * from './agents-doc.js'
export * from './assembly.js'
export * from './install.js'
export * from './hub.js'
export * from './manifest.js'
export * from './plan.js'
export * from './resolve.js'
export * from './roots.js'
export * from './slots.js'
export * from './storage.js'
export * from './version.js'
