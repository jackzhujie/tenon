/**
 * 「回滚这一版的数据该用哪份快照」。
 *
 * 这段逻辑决定了两件事，错哪个都不会报错、只会悄悄丢数据：
 * 1. **用太新的快照** → 表结构没退回去，代码跑旧查询、库还是新样子
 * 2. **退得太早（skipped 算错）** → 用户以为只丢一轮的数据，实际丢了三轮
 *
 * 所以这里的重点是 `skipped` 的**语义**，而不是"找得到就行"。
 */
import { describe, expect, it } from 'vitest'
import type { DbSnapshot } from '@tenon/db-provisioner'
import { pickSnapshot } from '../src/revert-data.js'

function snap(sha: string): DbSnapshot {
  return { mode: 'pglite', file: `/snapshots/${sha}.tar.gz`, bytes: 1024, createdAt: 0 }
}

/** 用 sha 列表描述"哪些提交有快照" */
function finder(available: readonly string[]): (sha: string) => Promise<DbSnapshot | null> {
  return (sha) => Promise.resolve(available.includes(sha) ? snap(sha) : null)
}

describe('pickSnapshot', () => {
  it('父提交就有快照：skipped 为 0，一轮数据都不用丢', async () => {
    const picked = await pickSnapshot(['b', 'a'], finder(['b', 'a']))
    expect(picked?.sha).toBe('b')
    expect(picked?.skipped).toBe(0)
  })

  it('父提交没有、祖父有：skipped 为 1，且如实报告退到了哪一份', async () => {
    const picked = await pickSnapshot(['b', 'a'], finder(['a']))
    expect(picked?.sha).toBe('a')
    expect(picked?.skipped).toBe(1)
    expect(picked?.snapshot.file).toBe('/snapshots/a.tar.gz')
  })

  it('跳过多个：skipped 表示中间隔了几个提交', async () => {
    // 祖先链：d(父) → c → b → a（有快照）
    const picked = await pickSnapshot(['d', 'c', 'b', 'a'], finder(['a']))
    expect(picked?.sha).toBe('a')
    expect(picked?.skipped).toBe(3)
  })

  it('用**最近**的那一份，不是随便一份', async () => {
    const picked = await pickSnapshot(['c', 'b', 'a'], finder(['b', 'a']))
    expect(picked?.sha).toBe('b')
    expect(picked?.skipped).toBe(1)
  })

  it('一份都没有：返回 null（调用方据此报 DB_SNAPSHOT_MISSING，而不是静默跳过）', async () => {
    expect(await pickSnapshot(['b', 'a'], finder([]))).toBeNull()
    expect(await pickSnapshot([], finder(['a']))).toBeNull()
  })

  it('查一次就命中时不多查（找到即停，不做无谓的 stat）', async () => {
    const seen: string[] = []
    await pickSnapshot(['c', 'b', 'a'], (sha) => {
      seen.push(sha)
      return Promise.resolve(sha === 'c' ? snap(sha) : null)
    })
    expect(seen).toEqual(['c'])
  })
})
