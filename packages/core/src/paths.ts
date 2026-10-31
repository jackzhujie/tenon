/**
 * `TENON_HOME` 布局（DESIGN §6.1）。
 *
 * 所有路径只在这里算，别处不许拼字符串——换目录（测试隔离、便携模式）只改这一处。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface TenonHome {
  readonly root: string
  readonly dbFile: string
  readonly appsDir: string
  readonly secretKeyFile: string
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): TenonHome {
  const override = env['TENON_HOME']
  const root = override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.tenon')
  return {
    root,
    dbFile: join(root, 'tenon.db'),
    appsDir: join(root, 'apps'),
    secretKeyFile: join(root, 'secret.key'),
  }
}

export interface AppPaths {
  readonly id: string
  readonly dir: string
  /** ★ Git 工作区：应用全部代码与文档 */
  readonly repoDir: string
  readonly tenonDir: string
  /** pi-durable 状态（会话、任务、文档） */
  readonly harnessDb: string
  readonly runtimeDir: string
  readonly telemetryDb: string
  readonly cacheDir: string
  /** 应用数据库目录（pglite 默认档；M2 才真正创建） */
  readonly pgdataDir: string
  readonly exportsDir: string
}

export function appPaths(home: TenonHome, appId: string): AppPaths {
  const dir = join(home.appsDir, appId)
  const tenonDir = join(dir, '.tenon')
  return {
    id: appId,
    dir,
    repoDir: join(dir, 'repo'),
    tenonDir,
    harnessDb: join(tenonDir, 'harness.sqlite'),
    runtimeDir: join(tenonDir, 'runtime'),
    telemetryDb: join(tenonDir, 'telemetry.db'),
    cacheDir: join(tenonDir, 'cache'),
    pgdataDir: join(dir, 'pgdata'),
    exportsDir: join(dir, 'exports'),
  }
}
