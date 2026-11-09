/**
 * `~/.tenon` 的体积盘点与清理（BACKLOG 3.3）。
 *
 * 为什么值得一个独立模块：**盘点与清理的判据不一样**。
 * 盘点要"把每一块都算出来"（否则用户看见 226MB 而说不清是什么），
 * 清理要"只动我确定能再生的东西"。两者混在一起写，最后一定会为了提高回收率
 * 而删掉不该删的东西。
 *
 * ## 什么可以删，什么绝对不删
 *
 * | 目录 | 能否清理 | 理由 |
 * |---|---|---|
 * | `repo/node_modules` | ✅ 删 | 纯缓存，下次预览/对话前会重装（`ensureDeps`） |
 * | `exports/db/<sha>/` | ✅ 按份数留 | 回滚用的库快照，留最近几份就够；旧的不影响代码回滚 |
 * | `backups/<appId>.git` | ⚠️ 只 gc | 那是"发布过的东西"，不能删；gc 只是打包松散对象 |
 * | `pgdata/` | ❌ | 应用正在用的数据 |
 * | `repo/`（除上面两个） | ❌ | 用户写的代码 |
 * | `.tenon/` | ❌ | 会话、任务、遥测：删了等于失忆 |
 *
 * ## 为什么清理只收"明确动作"而不是"目标策略"
 *
 * 一个自动保留策略（比如"快照只留 7 天"）在没有用户在场时删数据，是错误的默认：
 * 用户可能在两周后想回到某个版本。所以这里只提供**用户点了才执行**的三个动作，
 * 且每个动作的返回里带"这次释放了多少" —— 没有静默删除。
 */
import { execFile } from 'node:child_process'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { appPaths, type TenonHome } from '@tenon/core'

/** 盘点的分块。`reclaimable` 为真的才允许出现在清理动作里 */
export type StorageCategoryKey = 'git' | 'deps' | 'code' | 'database' | 'snapshots' | 'exports' | 'metadata'

export interface StorageCategory {
  readonly key: StorageCategoryKey
  readonly bytes: number
  readonly files: number
  readonly reclaimable: boolean
}

export interface StorageApp {
  readonly appId: string
  readonly name: string
  readonly dir: string
  readonly bytes: number
  readonly categories: StorageCategory[]
  /** 依赖（可回收，删了会重装） */
  readonly depsBytes: number
  /** 库快照（可回收，按份数留） */
  readonly snapshotBytes: number
  readonly snapshotCount: number
}

export interface StorageBackup {
  readonly appId: string
  readonly bytes: number
}

export interface StorageReport {
  readonly root: string
  readonly totalBytes: number
  readonly apps: StorageApp[]
  readonly backups: StorageBackup[]
  readonly backupsBytes: number
  /** `~/.tenon` 根下除 `apps/` 与 `backups/` 之外的部分（产品库、密钥、Hub 包） */
  readonly sharedBytes: number
  readonly scannedAt: number
}

export type StorageActionKind = 'deps' | 'snapshots' | 'backups-gc'

export interface StorageCleanRequest {
  readonly kind: StorageActionKind
  /** `deps` 专用：只清这个应用；不给就是全部应用 */
  readonly appId?: string | null
  /** `snapshots` 专用：每个应用保留最近几份（0 = 全清） */
  readonly keep?: number
}

export interface StorageCleanResult {
  readonly freedBytes: number
  /** 真删掉/压缩了的路径（给界面列出来，别让"释放了 177MB"成为一句不可核对的话） */
  readonly removed: string[]
  readonly notes: string[]
}

interface Usage {
  bytes: number
  files: number
}

/**
 * 递归量一个目录。
 *
 * 三条刻意的做法：
 * - **不跟符号链接**：跟出去就绕开了下面的越界护栏，也可能成环。
 * - **读不到就跳过**（权限、正在被删）—— 盘点是只读操作，为一个读不到的目录整页报错不值。
 * - `skip` 是**绝对路径集合**，由调用方给出：这样"代码 = repo 减去 .git 与 node_modules"
 *   这件事在调用处一眼能看懂，而不是在这里堆 if。
 */
async function usage(target: string, skip?: ReadonlySet<string>): Promise<Usage> {
  const stack: string[] = [target]
  let bytes = 0
  let files = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (skip?.has(full) === true) continue
      if (entry.isSymbolicLink()) {
        files += 1
        continue
      }
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(full).catch(() => null)
      if (info === null) continue
      bytes += info.size
      files += 1
    }
  }
  return { bytes, files }
}

async function listDir(target: string): Promise<string[]> {
  try {
    const entries = await readdir(target, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 越界护栏。
 *
 * 为什么用 `relative` 而不是 `startsWith`：`/a/bc` 以 `/a/b` 开头但不在它里面 ——
 * 这类判断写错一次就是"删到别人目录"。`relative` 的产物以 `..` 开头即越界。
 */
function outside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel)
}

interface SnapshotDir {
  path: string
  mtimeMs: number
  bytes: number
}

async function listSnapshots(snapshotsDir: string): Promise<SnapshotDir[]> {
  const names = await listDir(snapshotsDir)
  const out: SnapshotDir[] = []
  for (const name of names) {
    const path = join(snapshotsDir, name)
    const info = await stat(path).catch(() => null)
    if (info === null) continue
    const measured = await usage(path)
    out.push({ path, mtimeMs: info.mtimeMs, bytes: measured.bytes })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 盘点。
 *
 * `labels` 让界面能显示"小米记账"而不是 `app_7q1pz671hkq0y0ow`；不给就退回 appId
 * （测试里不需要为了一个名字去起一个 store）。
 */
export async function reportStorage(
  home: TenonHome,
  labels?: ReadonlyMap<string, string>,
): Promise<StorageReport> {
  const appIds = (await listDir(home.appsDir)).sort()
  const apps: StorageApp[] = []

  for (const appId of appIds) {
    const paths = appPaths(home, appId)
    const gitDir = join(paths.repoDir, '.git')
    const depsDir = join(paths.repoDir, 'node_modules')
    const snapshotsDir = join(paths.exportsDir, 'db')

    const [git, deps, code, database, snapshots, exportsRest, metadata] = await Promise.all([
      usage(gitDir),
      usage(depsDir),
      usage(paths.repoDir, new Set([gitDir, depsDir])),
      usage(paths.pgdataDir),
      usage(snapshotsDir),
      usage(paths.exportsDir, new Set([snapshotsDir])),
      usage(paths.tenonDir),
    ])

    const snapshotDirs = await listDir(snapshotsDir)
    const categories: StorageCategory[] = [
      { key: 'code', bytes: code.bytes, files: code.files, reclaimable: false },
      { key: 'git', bytes: git.bytes, files: git.files, reclaimable: false },
      { key: 'database', bytes: database.bytes, files: database.files, reclaimable: false },
      { key: 'metadata', bytes: metadata.bytes, files: metadata.files, reclaimable: false },
      { key: 'deps', bytes: deps.bytes, files: deps.files, reclaimable: deps.bytes > 0 },
      {
        key: 'snapshots',
        bytes: snapshots.bytes,
        files: snapshots.files,
        reclaimable: snapshotDirs.length > 0,
      },
      { key: 'exports', bytes: exportsRest.bytes, files: exportsRest.files, reclaimable: false },
    ]

    apps.push({
      appId,
      name: labels?.get(appId) ?? appId,
      dir: paths.dir,
      bytes: categories.reduce((sum, item) => sum + item.bytes, 0),
      categories,
      depsBytes: deps.bytes,
      snapshotBytes: snapshots.bytes,
      snapshotCount: snapshotDirs.length,
    })
  }

  const backups: StorageBackup[] = []
  for (const name of (await listDir(home.backupsDir)).sort()) {
    if (!name.endsWith('.git')) continue
    const measured = await usage(join(home.backupsDir, name))
    backups.push({ appId: name.slice(0, -'.git'.length), bytes: measured.bytes })
  }

  const shared = await usage(home.root, new Set([home.appsDir, home.backupsDir]))
  const backupsBytes = backups.reduce((sum, item) => sum + item.bytes, 0)

  return {
    root: home.root,
    totalBytes: apps.reduce((sum, item) => sum + item.bytes, 0) + backupsBytes + shared.bytes,
    apps,
    backups,
    backupsBytes,
    sharedBytes: shared.bytes,
    scannedAt: Date.now(),
  }
}

function runGit(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: 120_000 }, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

/**
 * 执行一个清理动作。
 *
 * **只处理本次请求点名的东西**，且每个删除前都过一遍越界护栏。返回里带上具体路径：
 * 用户点"清理"之后看到的应该是一串可核对的路径，而不是一句"已释放 177MB"。
 */
export async function cleanStorage(
  home: TenonHome,
  request: StorageCleanRequest,
): Promise<StorageCleanResult> {
  const removed: string[] = []
  const notes: string[] = []
  let freedBytes = 0

  if (request.kind === 'deps') {
    const targets =
      request.appId === undefined || request.appId === null
        ? await listDir(home.appsDir)
        : [request.appId]
    for (const appId of targets) {
      const depsDir = join(appPaths(home, appId).repoDir, 'node_modules')
      if (outside(home.appsDir, depsDir)) {
        notes.push(`${appId}：依赖目录不在 apps 之下，已跳过`)
        continue
      }
      const info = await stat(depsDir).catch(() => null)
      if (info === null || !info.isDirectory()) continue
      const measured = await usage(depsDir)
      await rm(depsDir, { recursive: true, force: true })
      freedBytes += measured.bytes
      removed.push(depsDir)
    }
    if (removed.length === 0) notes.push('没有可清理的依赖（都已清过或应用还没装过依赖）')
    return { freedBytes, removed, notes }
  }

  if (request.kind === 'snapshots') {
    const keep = Math.max(0, Math.floor(request.keep ?? 3))
    for (const appId of await listDir(home.appsDir)) {
      const snapshotsDir = join(appPaths(home, appId).exportsDir, 'db')
      if (outside(home.appsDir, snapshotsDir)) continue
      const snapshots = await listSnapshots(snapshotsDir)
      // 按 mtime 倒序，前 keep 份留下：**新的是"最近回滚可能用到"的**，
      // 按 sha 排会变成"字典序"，与"哪一份更近"无关
      for (const item of snapshots.slice(keep)) {
        await rm(item.path, { recursive: true, force: true })
        freedBytes += item.bytes
        removed.push(item.path)
      }
    }
    if (removed.length === 0) notes.push(`每个应用都只留下了 ${keep} 份以内的快照，无需清理`)
    return { freedBytes, removed, notes }
  }

  // backups-gc
  const names = (await listDir(home.backupsDir)).filter((name) => name.endsWith('.git'))
  if (names.length === 0) {
    notes.push('还没有备份裸库（发布过一次才会有）')
    return { freedBytes, removed, notes }
  }
  for (const name of names) {
    const repo = join(home.backupsDir, name)
    if (outside(home.backupsDir, repo)) continue
    const before = await usage(repo)
    try {
      /*
       * 用 `git gc` 而不是 `git gc --prune=now`：后者会连**不可达对象**一起删掉，
       * 而那些恰恰是"回滚/强推之后还能捞回来"的东西。备份库是最后一道保险，
       * 在这里追求那几个 MB 不划算。
       */
      await runGit(['gc', '--quiet'], repo)
    } catch (error) {
      notes.push(`${name}：gc 失败（${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    const after = await usage(repo)
    const saved = Math.max(0, before.bytes - after.bytes)
    freedBytes += saved
    if (saved > 0) removed.push(repo)
  }
  if (freedBytes === 0 && notes.length === 0) notes.push('备份库已经是最紧凑的状态')
  return { freedBytes, removed, notes }
}
