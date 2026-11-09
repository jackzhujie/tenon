/**
 * `~/.tenon` 盘点与清理（BACKLOG 3.3）。
 *
 * 这组用例的重点不是"函数能跑通"，而是**删得对不对**：
 * - 只删点名的东西（删依赖不能碰到代码与数据库）
 * - 快照按"最近"留，不是按 sha 字典序留
 * - `appId` 被构造成 `../..` 时一个字节都不能少
 *
 * 所以用真实的临时目录，而不是 mock `fs` —— 路径护栏这种逻辑，mock 出来的
 * 结果是"我写的 mock 对我的实现满意"，什么也证明不了。
 */
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveHome } from '@tenon/core'
import { cleanStorage, reportStorage } from '../src/storage.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenon-storage-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const home = () => resolveHome({ TENON_HOME: root })

/** 造一个"看起来像真应用"的目录：代码、依赖、git、库、三份快照 */
async function seedApp(appId: string): Promise<void> {
  const dir = join(root, 'apps', appId)
  await mkdir(join(dir, 'repo', 'src'), { recursive: true })
  await mkdir(join(dir, 'repo', '.git', 'objects'), { recursive: true })
  await mkdir(join(dir, 'repo', 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(join(dir, 'pgdata'), { recursive: true })
  await mkdir(join(dir, '.tenon'), { recursive: true })

  await writeFile(join(dir, 'repo', 'src', 'main.ts'), 'x'.repeat(100))
  await writeFile(join(dir, 'repo', '.git', 'objects', 'blob'), 'x'.repeat(50))
  await writeFile(join(dir, 'repo', 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(4096))
  await writeFile(join(dir, 'pgdata', 'base'), 'x'.repeat(2048))
  await writeFile(join(dir, '.tenon', 'harness.sqlite'), 'x'.repeat(64))

  // 三份快照，mtime 依次变新：a 最旧、c 最新
  const stamps: [string, number][] = [
    ['aaa', 1_600_000_000],
    ['bbb', 1_700_000_000],
    ['ccc', 1_800_000_000],
  ]
  for (const [sha, seconds] of stamps) {
    const dir2 = join(dir, 'exports', 'db', sha)
    await mkdir(dir2, { recursive: true })
    await writeFile(join(dir2, 'db.tar.gz'), 'x'.repeat(1024))
    await utimes(dir2, seconds, seconds)
  }
}

describe('reportStorage', () => {
  it('把 226MB 拆成可核对的几块', async () => {
    await seedApp('app_one')
    const report = await reportStorage(home(), new Map([['app_one', '记账']]))

    expect(report.apps).toHaveLength(1)
    const app = report.apps[0]
    expect(app?.name).toBe('记账')
    // 依赖 4096 + 代码 100 + git 50 + 库 2048 + 快照 3×1024 + 元数据 64
    expect(app?.depsBytes).toBe(4096)
    expect(app?.snapshotCount).toBe(3)
    expect(app?.snapshotBytes).toBe(3072)
    expect(app?.bytes).toBe(4096 + 100 + 50 + 2048 + 3072 + 64)
    // 总额包含应用本身；`backups/` 与根下的产品库另算
    expect(report.totalBytes).toBeGreaterThanOrEqual(app?.bytes ?? 0)
    expect(report.root).toBe(root)
  })

  it('store 里没有记录的应用也照样列出来', async () => {
    // 删除失败留下的残骸目录：界面上不能因为它"没登记"就消失
    await seedApp('app_orphan')
    const report = await reportStorage(home(), new Map())
    expect(report.apps.map((app) => app.appId)).toEqual(['app_orphan'])
    expect(report.apps[0]?.name).toBe('app_orphan')
  })

  it('备份裸库单独一块（不是应用的一部分）', async () => {
    await mkdir(join(root, 'backups', 'app_one.git', 'objects'), { recursive: true })
    await writeFile(join(root, 'backups', 'app_one.git', 'objects', 'pack'), 'x'.repeat(512))
    const report = await reportStorage(home())
    expect(report.backups).toEqual([{ appId: 'app_one', bytes: 512 }])
    expect(report.backupsBytes).toBe(512)
  })
})

describe('cleanStorage', () => {
  it('删依赖只删 node_modules，代码与数据库一个字节都不动', async () => {
    await seedApp('app_one')
    const result = await cleanStorage(home(), { kind: 'deps', appId: 'app_one' })

    expect(result.freedBytes).toBe(4096)
    expect(result.removed).toEqual([join(root, 'apps', 'app_one', 'repo', 'node_modules')])

    const dir = join(root, 'apps', 'app_one')
    const left = await readdir(join(dir, 'repo'))
    expect(left.sort()).toEqual(['.git', 'src'])
    // 库与快照必须还在 —— "清理"不等于"重置"
    expect(await stat(join(dir, 'pgdata', 'base'))).toBeTruthy()
    expect(await stat(join(dir, 'exports', 'db', 'ccc', 'db.tar.gz'))).toBeTruthy()
  })

  it('快照按"最近"留，不是按 sha 字典序', async () => {
    await seedApp('app_one')
    const result = await cleanStorage(home(), { kind: 'snapshots', keep: 1 })

    expect(result.freedBytes).toBe(2048)
    const left = await readdir(join(root, 'apps', 'app_one', 'exports', 'db'))
    // ccc 的 mtime 最新 → 留下；字典序会留下 aaa，那是错的
    expect(left).toEqual(['ccc'])
  })

  it('keep=0 清空快照', async () => {
    await seedApp('app_one')
    const result = await cleanStorage(home(), { kind: 'snapshots', keep: 0 })
    expect(result.freedBytes).toBe(3072)
    expect(await readdir(join(root, 'apps', 'app_one', 'exports', 'db'))).toEqual([])
  })

  it('appId 带 ../.. 时一个字节都不能少', async () => {
    await seedApp('app_one')
    const outside = join(root, '..', 'tenon-should-not-touch')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep.txt'), 'x'.repeat(1024))
    try {
      const result = await cleanStorage(home(), { kind: 'deps', appId: '../../../tenon-should-not-touch' })
      expect(result.freedBytes).toBe(0)
      expect(result.removed).toEqual([])
      // 外面那个文件必须原样在
      expect(await stat(join(outside, 'keep.txt'))).toBeTruthy()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('没有备份裸库时说清楚，而不是静默成功', async () => {
    const result = await cleanStorage(home(), { kind: 'backups-gc' })
    expect(result.freedBytes).toBe(0)
    expect(result.notes.join('')).toContain('备份裸库')
  })
})

/**
 * Handler 接线：`storage.report` / `storage.clean` 真的挂上了没有。
 *
 * 单测只证明"函数对"，证明不了"RPC 表里那条通到它"。这类漏接的表现是
 * 界面上一切正常、点下去报「未知方法」—— 而这个项目已经因为"新工具只挂了四处
 * 中的三处"红过一次。
 */
describe('RPC 接线', () => {
  it('storage.report 能列出刚 seed 的应用，storage.clean 能删掉它的依赖', async () => {
    const { boot, rpc } = await import('./support.js')
    const server = await boot(root)
    try {
      await seedApp('app_rpc')
      const report = await rpc<{ apps: { appId: string; depsBytes: number }[]; root: string }>(
        server,
        'storage.report',
      )
      expect(report.root).toBe(root)
      expect(report.apps.map((app) => app.appId)).toContain('app_rpc')

      const cleaned = await rpc<{ freedBytes: number; removed: string[] }>(server, 'storage.clean', {
        kind: 'deps',
        appId: 'app_rpc',
      })
      expect(cleaned.freedBytes).toBe(4096)
      expect(cleaned.removed).toEqual([join(root, 'apps', 'app_rpc', 'repo', 'node_modules')])
    } finally {
      await server.close()
    }
  })
})
