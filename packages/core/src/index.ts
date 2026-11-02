/**
 * `@tenon/core` —— 领域服务。
 *
 * 依赖方向（DESIGN §3.2）：`server → core`。core 不认识 HTTP，也不认识 Fastify：
 * 换掉传输层（Electron IPC / 测试直调）时这一层不动。
 */
import { TenonDatabase } from './db.js'
import { resolveHome, type TenonHome } from './paths.js'
import { SecretBox } from './secrets.js'
import type { AppScaffoldHook } from './stores/apps.js'
import { AppStore } from './stores/apps.js'
import { ProviderStore } from './stores/providers.js'
import { ReleaseStore } from './stores/releases.js'
import { SettingsStore } from './stores/settings.js'

export * from './paths.js'
export * from './pnpm.js'
export * from './db.js'
export * from './env.js'
export * from './ids.js'
export * from './secrets.js'
export * as files from './files.js'
export * as gitops from './git.js'
export * from './schema-change.js'
export * from './release.js'
export * from './taskgraph.js'
export * from './typecheck.js'
export * from './usage.js'
export * from './stores/apps.js'
export * from './stores/providers.js'
export * from './stores/releases.js'
export * from './stores/settings.js'
export { SETTING_KEYS, budgetKey, readBudget, NO_BUDGET } from './setting-keys.js'
export type { SettingKey } from './setting-keys.js'

export interface CoreServices {
  readonly home: TenonHome
  readonly db: TenonDatabase
  readonly box: SecretBox
  readonly apps: AppStore
  readonly releases: ReleaseStore
  readonly settings: SettingsStore
  readonly providers: ProviderStore
  close(): void
}

export interface OpenCoreOptions {
  env?: NodeJS.ProcessEnv
  /** 测试用：直接用内存库，不碰用户 HOME */
  inMemoryDb?: boolean
  /** 建应用时铺模板（`@tenon/generator` 的 `scaffoldApp`）。不传就只建空工作区 */
  scaffold?: AppScaffoldHook
}

export function openCore(options: OpenCoreOptions = {}): CoreServices {
  const home = resolveHome(options.env ?? process.env)
  const db = TenonDatabase.open(options.inMemoryDb === true ? ':memory:' : home.dbFile)
  const box = SecretBox.open(home.secretKeyFile)
  const hooks = options.scaffold === undefined ? {} : { scaffold: options.scaffold }
  return {
    home,
    db,
    box,
    apps: new AppStore(db, home, hooks),
    releases: new ReleaseStore(db),
    settings: new SettingsStore(db),
    providers: new ProviderStore(db, box),
    close() {
      db.close()
    },
  }
}
