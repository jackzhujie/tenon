/**
 * 应用注册表。一条应用 = 一行 `apps` + 一个目录（DESIGN §6.1）。
 *
 * 建应用是**有副作用的多步操作**（建目录、git init、首个 commit），
 * 所以顺序是「先写库拿到 id → 再建盘 → 失败回滚库行」，保证不会出现半成品应用。
 */
import { rm } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { App, AppStatus } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'
import { commitAll, headSha, initRepo, isRepo } from '../git.js'
import { newId, slugify } from '../ids.js'
import type { TenonHome } from '../paths.js'
import { appPaths } from '../paths.js'

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

const APP_GITIGNORE = `# Tenon 管理的工作区：状态、数据库、导出物都在 repo 之外（DESIGN §6.1）
.tenon/
pgdata/
exports/
node_modules/
dist/
.DS_Store
`

export interface CreateAppInput {
  name: string
  templateId: string
  styleId: string | null
  description?: string
}

export class AppStore {
  constructor(
    private readonly db: TenonDatabase,
    private readonly home: TenonHome,
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
    if (app === undefined) throw new TenonError('APP_NOT_FOUND', `应用不存在：${id}`, { appId: id })
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
        `# ${input.name}\n\n由 Tenon 创建的应用工作区。\n`,
        'utf8',
      )
      await initRepo(paths.repoDir)
      await commitAll(paths.repoDir, `chore: 初始化应用「${input.name}」`, { appId: id })
    } catch (err) {
      // 建盘失败 → 把库行删掉，别留一个指向空目录的应用
      this.db.run('DELETE FROM apps WHERE id = ?', id)
      throw new TenonError('APP_HOME_MISSING', '创建应用目录失败', {
        appId: id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }

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
    if (!paths.dir.startsWith(`${this.home.appsDir}/`)) {
      throw new TenonError('INTERNAL', `拒绝删除越界路径：${paths.dir}`)
    }
    await rm(paths.dir, { recursive: true, force: true })
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
