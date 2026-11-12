/**
 * 应用注册表。一条应用 = 一行 `apps` + 一个目录（DESIGN §6.1）。
 *
 * 建应用是**有副作用的多步操作**（建目录、git init、首个 commit），
 * 所以顺序是「先写库拿到 id → 再建盘 → 失败回滚库行」，保证不会出现半成品应用。
 */
import { rm } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { App, AppStatus } from '@tenon/protocol'
import { msg, TenonError, isTenonError } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'
import { commitAll, headSha, initRepo, isRepo } from '../git.js'
import { newId, slugify } from '../ids.js'
import type { TenonHome } from '../paths.js'
import { appPaths } from '../paths.js'

/**
 * `target` 是不是**在** `base` 里面（而不是等于它）。
 *
 * 原先这里写的是 `startsWith(`${base}/`)`。那个判断在 macOS/Linux 上一直是对的，
 * 在 Windows 上**永远为假** —— 因为分隔符是 `\`，拼出来的前缀是 `...\apps/`，
 * 而真实路径是 `...\apps\app_x`。表现不是"删错了"，而是"删应用永远失败"，
 * 且报的是一句看不懂的"拒绝删除越界路径"。（三平台 CI 第一次跑就是这样抓到的。）
 *
 * `relative` 按**运行平台**的分隔符算，而且天然处理 `..`：
 * 越界的相对路径不是以 `..` 开头就是绝对路径。
 */
function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 删一棵目录，**带退避重试**。
 *
 * Windows 上 rmdir 会因为"还有句柄没释放"拿到 `EBUSY` / `EPERM`，而占用的往往不是我们：
 * 杀软正在扫刚写出来的几百个文件、搜索索引器、或者某个刚退出的子进程还挂着。
 * 这类占用通常在**几秒内**消失，所以退避重试（150/300/600/1200/2400ms，合计约 4.6s）
 * 比"立即失败"和"立刻重试 5 次"都更接近现实。
 *
 * `fs.rm` 自带的 `maxRetries` 只做固定间隔的立即重试（对杀软扫描太短），所以这里自己写。
 * 重试用尽仍然抛 —— 那时该看到的是错误，而不是"删了一半还说成功"。
 * 对 POSIX 无副作用（那几个错误码在那边基本不会出现）。
 */
async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EMFILE'
      if (!transient || attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt))
    }
  }
}

interface AppRow {
  id: string
  name: string
  slug: string
  template_id: string
  style_id: string | null
  status: string
  created_at: number
  updated_at: number
  last_opened_at: number | null
}

function toApp(row: AppRow): App {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    templateId: row.template_id,
    styleId: row.style_id,
    status: row.status as AppStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  }
}

const APP_GITIGNORE = `# Workspace managed by Tenon: state, databases and exports live outside repo/ (DESIGN §6.1)
.tenon/
pgdata/
exports/
node_modules/
dist/
dist-server/
.DS_Store
`

export interface CreateAppInput {
  name: string
  templateId: string
  styleId: string | null
  description?: string
}

/**
 * 铺模板的钩子。
 *
 * 为什么是钩子而不是 `core` 直接依赖 `@tenon/generator`：依赖方向是
 * `server → core` 与 `server → generator`，两条边**平行**。让 core 依赖 generator
 * 之后，generator 想拿 `TenonError` 就得反着依赖 core，立刻成环。
 * 钩子的签名定义在这里（谁调用谁实现），core 只负责"在正确的时机调它"。
 */
export interface AppScaffoldContext {
  readonly repoDir: string
  readonly appId: string
  readonly appName: string
  readonly appSlug: string
  readonly templateId: string
}

export type AppScaffoldHook = (ctx: AppScaffoldContext) => Promise<void>

export class AppStore {
  constructor(
    private readonly db: TenonDatabase,
    private readonly home: TenonHome,
    private readonly hooks: { scaffold?: AppScaffoldHook } = {},
  ) {}

  list(includeArchived = false): App[] {
    const rows = includeArchived
      ? this.db.all<AppRow>('SELECT * FROM apps ORDER BY updated_at DESC')
      : this.db.all<AppRow>("SELECT * FROM apps WHERE status <> 'archived' ORDER BY updated_at DESC")
    return rows.map((row) => toApp({ ...row }))
  }

  find(id: string): App | undefined {
    const row = this.db.get<AppRow>('SELECT * FROM apps WHERE id = ?', id)
    return row === undefined ? undefined : toApp({ ...row })
  }

  require(id: string): App {
    const app = this.find(id)
    if (app === undefined) throw new TenonError('APP_NOT_FOUND', msg('error.app.notFound', { id }), { appId: id })
    return app
  }

  private allocateSlug(name: string): string {
    const base = slugify(name)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
      const taken = this.db.get<{ id: string }>('SELECT id FROM apps WHERE slug = ?', candidate)
      if (taken === undefined) return candidate
    }
    return `${base}-${newId('s').slice(2, 8)}`
  }

  async create(input: CreateAppInput): Promise<App> {
    const id = newId('app')
    const slug = this.allocateSlug(input.name)
    const now = Date.now()

    this.db.run(
      `INSERT INTO apps (id, name, slug, template_id, style_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
      id,
      input.name,
      slug,
      input.templateId,
      input.styleId,
      now,
      now,
    )

    try {
      const paths = appPaths(this.home, id)
      await mkdir(paths.repoDir, { recursive: true })
      await mkdir(paths.runtimeDir, { recursive: true })
      await mkdir(paths.cacheDir, { recursive: true })
      await writeFile(join(paths.repoDir, '.gitignore'), APP_GITIGNORE, 'utf8')
      await writeFile(
        join(paths.repoDir, 'README.md'),
        `# ${input.name}\n\nApp workspace created by Tenon.\n`,
        'utf8',
      )
      // 模板必须在 initRepo 之前铺完：铺模板与首次提交是同一个动作
      if (this.hooks.scaffold !== undefined) {
        await this.hooks.scaffold({
          repoDir: paths.repoDir,
          appId: id,
          appName: input.name,
          appSlug: slug,
          templateId: input.templateId,
        })
      }
      await initRepo(paths.repoDir)
      await commitAll(paths.repoDir, `chore: create app "${input.name}"`, { appId: id })
    } catch (err) {
      // 建盘失败 → 把库行删掉，别留一个指向空目录的应用
      this.db.run('DELETE FROM apps WHERE id = ?', id)
      // 模板自己的错误（未知模板 / 变量缺失）要原样上抛：
      // 统一包成 APP_HOME_MISSING 会让「模板名写错了」看起来像「磁盘坏了」
      if (isTenonError(err)) throw err
      throw new TenonError('APP_HOME_MISSING', msg('error.app.homeMissing'), {
        appId: id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }

    return this.require(id)
  }

  /**
   * 改显示名。
   *
   * **只改 `name`，不动 `slug` 与目录。** 目录名是 `appPaths` 的一部分，改它意味着
   * 搬 git 仓库、搬 `.tenon/`（含 PGlite 数据目录）、改所有在跑的子进程 cwd ——
   * 一次改名换来一次全链路迁移，而用户要的只是"列表里那行字换个说法"。
   *
   * 代价是名字与 slug 会不一致（`我的应用` / `wo-de-ying-yong`）。slug 从来没有
   * 展示给用户看过，它只在 `appPaths` 与备份库文件名里用 —— 所以这个不一致看不见。
   */
  rename(id: string, name: string): App {
    this.require(id)
    const trimmed = name.trim()
    // 协议层已经校过一遍（zod）；core 再判一次是给"绕过 RPC 直接调 core"的调用方兜底
    if (trimmed === '' || trimmed.length > 64) {
      throw new TenonError('VALIDATION_FAILED', msg('error.app.nameInvalid'), { appId: id })
    }
    this.db.run('UPDATE apps SET name = ?, updated_at = ? WHERE id = ?', trimmed, Date.now(), id)
    return this.require(id)
  }

  async delete(id: string, removeFiles = true): Promise<void> {
    this.require(id)
    this.db.transaction(() => {
      this.db.run('DELETE FROM releases WHERE app_id = ?', id)
      this.db.run('DELETE FROM apps WHERE id = ?', id)
    })
    if (!removeFiles) return
    const paths = appPaths(this.home, id)
    // 安全护栏：只允许删 appsDir 下面的目录（防 id 被污染成 ../..）
    if (!isInside(this.home.appsDir, paths.dir)) {
      throw new TenonError('INTERNAL', msg('error.app.refuseDelete', { path: paths.dir }))
    }
    await removeTree(paths.dir)
    /*
     * 发布用的备份裸库也跟着删（`<home>/backups/<appId>.git`）。
     *
     * 不删的话它会永远留在那里：应用已经不存在，界面上没有任何入口能 clone 它 ——
     * 一个没人能访问、但占着这个应用完整历史的孤儿裸库。删了几个试验应用之后
     * `backups/` 会变成一堆看不懂名字的目录。
     *
     * 这与"删除不可恢复"是同一件事，UI 的确认文案里已经写清楚了。
     */
    if (!isInside(this.home.backupsDir, paths.backupRepo)) {
      throw new TenonError('INTERNAL', msg('error.app.refuseDelete', { path: paths.backupRepo }))
    }
    await removeTree(paths.backupRepo)
  }

  touch(id: string): void {
    const now = Date.now()
    this.db.run('UPDATE apps SET updated_at = ?, last_opened_at = ? WHERE id = ?', now, now, id)
  }

  setStatus(id: string, status: AppStatus): void {
    this.db.run('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), id)
  }

  async lastCommit(id: string): Promise<string | undefined> {
    const paths = appPaths(this.home, id)
    if (!(await isRepo(paths.repoDir))) return undefined
    return headSha(paths.repoDir)
  }
}
