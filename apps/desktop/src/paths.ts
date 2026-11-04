/**
 * 打包前后资源路径的**唯一**算法。
 *
 * 两种形态的差别只有一层目录，但搞混就会得到一个"开发能跑、装完白屏"的应用：
 *
 * | 形态 | 基线 | server.mjs | web | templates | plugins |
 * |---|---|---|---|---|---|
 * | 开发（`pnpm dev:desktop`） | `apps/desktop/dist` | `<base>/server/server.mjs` | `<base>/web` | `<base>/templates` | `<base>/plugins` |
 * | 打包（electron-builder） | `Contents/Resources` | 同上 | 同上 | 同上 | 同上 |
 *
 * 所以 `apps/desktop/build.mjs` 把三样东西铺成**同构的** `dist/{server,web,templates}`，
 * 打包时整体作为 `extraResources` 放进去 —— 主进程不需要知道自己在哪。
 *
 * `templates` 还有个隐性约定：`packages/generator/src/registry.ts` 在不设
 * `TENON_TEMPLATES_DIR` 时按 `import.meta.url` 找 `../templates`，也就是
 * `dist/server/server.mjs` → `dist/templates`。所以这里的目录名不能改。
 */
import { join } from 'node:path'

export interface DesktopPaths {
  readonly serverEntry: string
  readonly webDir: string
  readonly templatesDir: string
  /**
   * 官方组件（`resources/plugins/<id>/`）。M5 起是真实目录 —— 加载器按目录扫描，
   * 所以它必须像 templates 一样**在 asar 外面**，且开发态与打包态同构。
   */
  readonly pluginsDir: string
  /**
   * 随包分发的 Hub 配置（`hub.json`，M6 第 5 步）。
   *
   * **可能不存在** —— 本地开发、或者打包时没给 Hub 地址就是没有。存在与不存在的区别
   * 只是"商店能不能从官方源装组件"，不是故障，所以这里不判存在性。
   */
  readonly hubConfigFile: string
  /** 打包后的应用资源根（日志里打得出来，排查"到底读的哪份"） */
  readonly base: string
}

export interface ResolvePathsInput {
  /** 打包后传 `process.resourcesPath` */
  readonly resourcesPath: string
  /** 开发时传 `app.getAppPath()`（= apps/desktop） */
  readonly appPath: string
  readonly isPackaged: boolean
}

export function resolveDesktopPaths(input: ResolvePathsInput): DesktopPaths {
  const base = input.isPackaged ? input.resourcesPath : join(input.appPath, 'dist')
  return {
    base,
    serverEntry: join(base, 'server', 'server.mjs'),
    webDir: join(base, 'web'),
    templatesDir: join(base, 'templates'),
    pluginsDir: join(base, 'plugins'),
    hubConfigFile: join(base, 'hub.json'),
  }
}
