import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitops } from '../src/index.js'

const { commitAll, diff, initRepo, log, revert } = gitops

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-git-'))
  await initRepo(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Git 一等公民（isomorphic-git）', () => {
  it('一轮一 commit：无改动返回 undefined，不产生空提交', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello\n')
    const first = await commitAll(dir, 'feat: 加一个文件', { conversationId: '1', turn: 1 })
    expect(first?.sha).toBeTruthy()
    // 带 trailer，方便回溯"这行是第几轮对话写的"
    expect(first?.message).toContain('Tenon-ConversationId: 1')
    expect(first?.message).toContain('Tenon-Turn: 1')

    const again = await commitAll(dir, 'feat: 什么也没改')
    expect(again).toBeUndefined()
    expect(await log(dir, 10)).toHaveLength(1)
  })

  it('diff 能报出新增/修改/删除与行数', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    const first = await commitAll(dir, 'init')
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(join(dir, 'b.txt'), 'new file\n')
    await commitAll(dir, 'change')

    const result = await diff(dir, first!.sha)
    const byPath = new Map(result.changes.map((c) => [c.path, c]))
    expect(byPath.get('a.txt')?.status).toBe('modified')
    expect(byPath.get('b.txt')?.status).toBe('added')
    expect(result.patch).toContain('-two')
    expect(result.patch).toContain('+TWO')
    expect(result.patch).toContain('+three')
  })

  it('同长度改动也会被提交（statusMatrix / WORKDIR 的 stat 缓存会漏掉它）', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1\n')
    const first = await commitAll(dir, 'init')
    // 长度完全相同、几乎同一毫秒内写入：这是 stat 快路径的经典漏检场景
    await writeFile(join(dir, 'a.txt'), 'v2\n')

    const second = await commitAll(dir, 'bump')
    expect(second?.sha).toBeTruthy()
    expect(second?.changed).toContain('a.txt')

    // 提交内容确实是 v2（证明 force add 真的重读了盘，而不是复用 index 里的旧对象）
    const result = await diff(dir, first!.sha)
    expect(result.patch).toContain('-v1')
    expect(result.patch).toContain('+v2')
  })

  it('revert 产生新提交而不改写历史（禁止 reset --hard）', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1\n')
    const first = await commitAll(dir, 'init')
    await writeFile(join(dir, 'a.txt'), 'v2\n')
    const second = await commitAll(dir, 'bump')
    expect(second?.sha).not.toBe(first?.sha)

    const reverted = await revert(dir, second!.sha, { appId: 'app_test' })
    expect(reverted.sha).not.toBe(second!.sha)

    const commits = await log(dir, 10)
    // 三条都在：init、bump、revert —— 历史未被重写
    expect(commits).toHaveLength(3)
    expect(commits[0]?.message).toContain('revert')

    const { readFile } = await import('node:fs/promises')
    expect((await readFile(join(dir, 'a.txt'), 'utf8')).trim()).toBe('v1')
  })

  it('回滚第一个提交会明确拒绝（语义可疑，不做）', async () => {
    await writeFile(join(dir, 'a.txt'), 'only\n')
    const first = await commitAll(dir, 'init')
    await expect(revert(dir, first!.sha)).rejects.toThrowError(/第一个提交/)
  })
})
