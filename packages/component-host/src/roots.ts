/**
 * 插件从哪来（DESIGN §21.4 的分发节奏）。
 *
 * | 阶段 | 目录 | 谁写 |
 * |---|---|---|
 * | Phase 1（M5） | `bundled`：随包发布的只读目录 | 安装包 |
 * | Phase 2（M6） | `hub`：`<TENON_HOME>/plugins/<id>/<version>/` | 下载器 |
 *
 * **加载器只有一条路径**：按 `hub > bundled` 的顺序解析，第一个版本满足装配声明的胜出。
 * 这条覆盖层机制带来一个实用能力 —— 内置插件也能热更新：官方修了 bug 推到 Hub，
 * 用户点更新即生效；把 hub 版删掉就自动回落到随包的那份，不会出现"应用缺组件"的悬空状态。
 *
 * `bundled` 的默认路径按 `import.meta.url` 找 `../../../plugins/bundled`（仓库布局）。
 * 打包后这个相对位置失效，所以桌面壳必须用 `TENON_PLUGINS_DIR` 指到
 * `<Resources>/plugins` —— 与 `TENON_TEMPLATES_DIR` 是同一套约定。
 */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PluginRootKind = 'bundled' | 'hub'

export interface PluginRoot {
  readonly kind: PluginRootKind
  readonly dir: string
}

export const BUNDLED_PLUGINS_DIR_ENV = 'TENON_PLUGINS_DIR'
export const HUB_PLUGINS_DIR_ENV = 'TENON_PLUGINS_HUB_DIR'

export function bundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[BUNDLED_PLUGINS_DIR_ENV]
  if (override !== undefined && override !== '') return resolve(override)
  // src/roots.ts → ../../../plugins/bundled（仓库根下的官方组件源）
  return resolve(fileURLToPath(new URL('../../../plugins/bundled', import.meta.url)))
}

export function hubPluginsDir(env: NodeJS.ProcessEnv, homeRoot: string): string {
  const override = env[HUB_PLUGINS_DIR_ENV]
  if (override !== undefined && override !== '') return resolve(override)
  return join(homeRoot, 'plugins')
}

/** 优先级顺序就是数组顺序：先 hub，后 bundled */
export function pluginRoots(input: {
  readonly env?: NodeJS.ProcessEnv
  readonly homeRoot: string
}): PluginRoot[] {
  const env = input.env ?? process.env
  return [
    { kind: 'hub', dir: hubPluginsDir(env, input.homeRoot) },
    { kind: 'bundled', dir: bundledPluginsDir(env) },
  ]
}
