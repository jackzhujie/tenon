/**
 * 库快照与还原（M3 第 7b 步：回滚的数据侧）。
 *
 * 这里要钉住的是**四条会静默出错的约定**：
 *
 * 1. **快照是按 commit sha 归档的**。改成时间戳命名的话，回滚时还得反查
 *    "哪个文件对应哪个提交"，等于把同一个关系存两遍，且两遍迟早对不上。
 * 2. **数据目录不存在时不存快照**（返回 `null`）。存一份空库会让"有快照"
 *    变成一个骗人的信号 —— 回滚时以为能还原，实际把用户的库换成了空的。
 * 3. **存完要把库按原状放回去**。为了打快照把用户的 PGlite 一直挂在那里，
 *    等于每提交一次就泄漏 38MB。
 * 4. **档位不匹配必须拒绝**。拿 PGlite 的 tar.gz 去喂 `pg_restore` 只会得到
 *    一句看不懂的报错，不如在这里说清楚。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { appPaths, resolveHome } from '@tenon/core'
import { DatabaseManager } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined)
})

async function makeManager(): Promise<{ manager: DatabaseManager; home: ReturnType<typeof resolveHome> }> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-snapshot-'))
  const home = resolveHome({ TENON_HOME: dir })
  const manager = new DatabaseManager({ home, mode: 'pglite' })
  cleanups.push(() => manager.closeAll(), () => rm(dir, { recursive: true, force: true }))
  return { manager, home }
}

async function exec(manager: DatabaseManager, appId: string, sql: string): Promise<void> {
  const provider = await manager.acquire(appId)
  const client = new Client({ connectionString: provider.connectionString() })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

async function query<T extends Record<string, unknown>>(
  manager: DatabaseManager,
  appId: string,
  sql: string,
): Promise<T[]> {
  const provider = await manager.acquire(appId)
  const client = new Client({ connectionString: provider.connectionString() })
  await client.connect()
  try {
    const result = await client.query<T>(sql)
    return result.rows
  } finally {
    await client.end()
  }
}

describe('DatabaseManager 快照', () => {
  it('数据目录不存在时返回 null（不为空库存一份骗人的快照）', async () => {
    const { manager, home } = await makeManager()
    const snapshot = await manager.snapshot('app-1', 'a'.repeat(40))
    expect(snapshot).toBeNull()
    // 而且不该顺手把目录造出来 —— 那会让下一次判断误以为"有数据"
    await expect(stat(appPaths(home, 'app-1').pgdataDir)).rejects.toThrow()
  })

  it('按 sha 归档，存完按原状把库停回去', async () => {
    const { manager, home } = await makeManager()
    await exec(manager, 'app-1', 'create table notes (id serial primary key, body text)')
    await manager.release('app-1')

    const sha = 'b'.repeat(40)
    const snapshot = await manager.snapshot('app-1', sha)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.mode).toBe('pglite')
    // 落点是 exports/db/<sha>/db.tar.gz —— 路径里必须带 sha，否则回滚时对不上提交
    expect(snapshot?.file).toBe(join(appPaths(home, 'app-1').exportsDir, 'db', sha, 'db.tar.gz'))
    expect(snapshot?.bytes).toBeGreaterThan(0)

    // 原本是 stopped：存完必须还是 stopped，不能为了快照把 38MB 一直挂着
    expect(manager.status('app-1')?.state).toBe('stopped')
  })

  it('库在跑的时候存快照，存完保持运行（不打断正在用的预览）', async () => {
    const { manager } = await makeManager()
    await exec(manager, 'app-1', 'create table notes (id serial primary key)')
    expect(manager.status('app-1')?.state).toBe('ready')

    await manager.snapshot('app-1', 'c'.repeat(40))
    expect(manager.status('app-1')?.state).toBe('ready')
  })

  it('findSnapshot：没存过返回 null，存过能按 sha 找回来', async () => {
    const { manager } = await makeManager()
    await exec(manager, 'app-1', 'create table notes (id serial primary key)')
    const sha = 'd'.repeat(40)

    expect(await manager.findSnapshot('app-1', sha)).toBeNull()
    await manager.snapshot('app-1', sha)
    const found = await manager.findSnapshot('app-1', sha)
    expect(found?.file.endsWith(join(sha, 'db.tar.gz'))).toBe(true)
  })

  it('★ 还原之后表结构和数据都回到快照那一刻', async () => {
    const { manager } = await makeManager()
    const before = 'e'.repeat(40)

    await exec(
      manager,
      'app-1',
      'create table notes (id serial primary key, body text); insert into notes (body) values (\'第一行\')',
    )
    const snapshot = await manager.snapshot('app-1', before)
    expect(snapshot).not.toBeNull()

    // 快照之后：加一列、再写一行 —— 正是"跑了迁移 + 用户录了数据"的样子
    await exec(manager, 'app-1', "alter table notes add column pinned boolean default false")
    await exec(manager, 'app-1', "insert into notes (body) values ('第二行')")
    const after = await query(manager, 'app-1', 'select body from notes order by id')
    expect(after).toHaveLength(2)

    await manager.restoreSnapshot('app-1', snapshot!)

    // 结构退回旧版：新加的那一列必须没了
    const columns = await query<{ column_name: string }>(
      manager,
      'app-1',
      "select column_name from information_schema.columns where table_name = 'notes'",
    )
    expect(columns.map((row) => row.column_name).sort()).toEqual(['body', 'id'])

    // 数据也退回那一刻：只剩第一行，第二行是被丢弃的那部分
    const restored = await query<{ body: string }>(manager, 'app-1', 'select body from notes order by id')
    expect(restored.map((row) => row.body)).toEqual(['第一行'])
  })

  it('档位不匹配时明确拒绝，而不是丢给 pg_restore 报天书', async () => {
    const { manager } = await makeManager()
    await expect(
      manager.restoreSnapshot('app-1', {
        mode: 'postgres',
        file: '/tmp/whatever.dump',
        bytes: 1,
        createdAt: Date.now(),
      }),
    ).rejects.toThrowError(/pglite 档，不能直接还原/)
  })

  it('★ 运行中打快照：未提交的事务不会被卷进来', async () => {
    /*
     * 快照是在**库还在跑**的时候打的（一轮对话刚结束，预览通常正开着）。
     * 这时候可能有别的事务正在进行 —— 如果 `dumpDataDir` 把未提交的页也收进去，
     * 回滚之后用户会看到一笔他从没确认过的写入。PG 的 WAL + xid 机制本该防住这件事，
     * 但"本该"不是证据：这条测试就是证据。
     */
    const { manager } = await makeManager()
    const sha = 'f'.repeat(40)

    const provider = await manager.acquire('app-1')
    const client = new Client({ connectionString: provider.connectionString() })
    // 还原会销毁 PGlite 实例、掐断所有 socket —— 那时候连接已经不要了，
    // 但不挂监听的话 `pg` 会把 "Connection terminated" 抛成未捕获异常，污染测试结果
    client.on('error', () => undefined)
    await client.connect()
    try {
      await client.query('create table notes (id serial primary key, body text)')
      await client.query("insert into notes (body) values ('已提交')")
      await client.query('begin')
      await client.query("insert into notes (body) values ('未提交')")
      // 事务挂着不提交，这时候打快照
      const snapshot = await manager.snapshot('app-1', sha)
      await client.query('rollback')
      // 先主动断开，再去还原（还原本来也会把它掐掉，但那样日志里会多一条噪音）
      await client.end()

      await manager.restoreSnapshot('app-1', snapshot!)
      const rows = await query<{ body: string }>(manager, 'app-1', 'select body from notes order by id')
      expect(rows.map((row) => row.body)).toEqual(['已提交'])
    } finally {
      await client.end().catch(() => undefined)
    }
  })
})
