import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitops } from '../src/index.js'

const { commitAll, diff, initRepo, log, revert, showCommit, worktreeDiff } = gitops

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

  it('showCommit 只看这一条提交自己改了什么（不是它之后累积的改变）', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    const first = await commitAll(dir, 'init')
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\n')
    const second = await commitAll(dir, 'second')
    await writeFile(join(dir, 'b.txt'), 'later\n')
    await commitAll(dir, 'third')

    const shown = await showCommit(dir, second!.sha)

    // 第三条加的文件不该出现在第二条的 diff 里 —— 这是「看这一轮改了什么」和
    // 「从这一轮到 HEAD 改了什么」的区别，最容易写错的一处
    expect(shown.files.map((f) => f.path)).toEqual(['a.txt'])
    expect(shown.commit.sha).toBe(second!.sha)
    expect(shown.commit.parents).toEqual([first!.sha])
  })

  it('showCommit 的逐行差异带两侧行号（前端要按它对齐全文件）', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await commitAll(dir, 'init')
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    const second = await commitAll(dir, 'bump')

    const [file] = (await showCommit(dir, second!.sha)).files
    expect(file).toBeDefined()
    const rows = file!.lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine])
    expect(rows).toEqual([
      ['ctx', 'one', 1, 1],
      ['del', 'two', 2, null],
      ['add', 'TWO', null, 2],
      ['ctx', 'three', 3, 3],
      ['add', 'four', null, 4],
      // 末尾换行会让 split('\n') 多出一个空串，它是真实的「最后一行」
      ['ctx', '', 4, 5],
    ])
    expect(file!.insertions).toBe(2)
    expect(file!.deletions).toBe(1)
  })

  it('根提交的 showCommit 把整棵树当新增（没有父提交可比）', async () => {
    await writeFile(join(dir, 'a.txt'), 'only\n')
    const first = await commitAll(dir, 'init')

    const shown = await showCommit(dir, first!.sha)
    expect(shown.commit.parents).toEqual([])
    expect(shown.files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'added']])
    expect(shown.files[0]?.lines.some((line) => line.kind === 'add')).toBe(true)
  })

  it('新增文件的每一行都是 +，不混进空洞的 context 行', async () => {
    await writeFile(join(dir, 'a.txt'), 'base\n')
    await commitAll(dir, 'init')
    await writeFile(join(dir, 'b.txt'), 'one\ntwo\n')
    const second = await commitAll(dir, 'add b')
    await writeFile(join(dir, 'b.txt'), 'one\ntwo\nthree\n')
    const third = await commitAll(dir, 'edit b')

    const added = (await showCommit(dir, second!.sha)).files.find((f) => f.path === 'b.txt')
    /*
     * 旧实现把缺失一侧当成空串传给 diff，`''.split('\n')` 给出 `['']` ——
     * 一个"空行"，于是新增文件里混进一行 context，全 + 的文件看起来像"改了一行"。
     * 这也是行号整体错一格的来源。
     */
    expect(added?.lines.every((line) => line.kind === 'add')).toBe(true)
    expect(added?.lines.map((line) => line.newLine)).toEqual([1, 2, 3])

    // 删除也要对称：全是 - 行，不该有 context
    const removed = (await showCommit(dir, third!.sha)).files.find((f) => f.path === 'b.txt')
    expect(removed?.lines.map((line) => line.kind)).toEqual(['ctx', 'ctx', 'add', 'ctx'])
  })

  it('二进制文件标 binary，不假装成「整文件被删光」', async () => {
    await writeFile(join(dir, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    const first = await commitAll(dir, 'init')
    await writeFile(join(dir, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]))
    const second = await commitAll(dir, 'change image')

    const shown = await showCommit(dir, second!.sha)
    expect(first).toBeDefined()
    expect(shown.files[0]?.binary).toBe(true)
    expect(shown.files[0]?.lines).toEqual([])
    // 关键：不能报成 0 insertions / 一堆 deletions 让人以为文件被清空
    expect(shown.files[0]?.patch).toContain('二进制文件')
  })

  it('回滚第一个提交会明确拒绝（语义可疑，不做）', async () => {
    await writeFile(join(dir, 'a.txt'), 'only\n')
    const first = await commitAll(dir, 'init')
    await expect(revert(dir, first!.sha)).rejects.toThrowError(/第一个提交/)
  })

  /*
   * worktreeDiff 是给 Reviewer 用的：他动手的时机是**提交之前**，
   * 而 diff()/showCommit() 比的都是两棵树，看不见工作区。
   */
  describe('worktreeDiff（工作区 vs HEAD，评审用）', () => {
    it('看到还没提交的新增/修改/删除，基准是 HEAD', async () => {
      await writeFile(join(dir, 'keep.txt'), 'same\n')
      await writeFile(join(dir, 'edit.txt'), 'one\ntwo\n')
      await writeFile(join(dir, 'gone.txt'), 'bye\n')
      const first = await commitAll(dir, 'init')

      await writeFile(join(dir, 'edit.txt'), 'one\nTWO\n')
      await writeFile(join(dir, 'fresh.txt'), 'brand new\n')
      await rm(join(dir, 'gone.txt'))

      const result = await worktreeDiff(dir)
      expect(result.base).toBe(first!.sha)
      const byPath = new Map(result.changes.map((c) => [c.path, c.status]))
      expect(byPath.get('edit.txt')).toBe('modified')
      expect(byPath.get('fresh.txt')).toBe('added')
      expect(byPath.get('gone.txt')).toBe('deleted')
      // 没动过的文件不该出现
      expect(byPath.has('keep.txt')).toBe(false)
      expect(result.patch).toContain('+TWO')
      expect(result.patch).toContain('+brand new')
      expect(result.patch).toContain('-bye')
    })

    it('同长度、同一毫秒的改动也看得到（不能走 stat 快路径）', async () => {
      await writeFile(join(dir, 'a.txt'), 'v1\n')
      await commitAll(dir, 'init')
      await writeFile(join(dir, 'a.txt'), 'v2\n')

      const result = await worktreeDiff(dir)
      expect(result.changes.map((c) => c.path)).toEqual(['a.txt'])
      expect(result.patch).toContain('-v1')
      expect(result.patch).toContain('+v2')
    })

    it('工作区干净时什么都不报（不能凭空造出一份"改动"）', async () => {
      await writeFile(join(dir, 'a.txt'), 'v1\n')
      await commitAll(dir, 'init')
      const result = await worktreeDiff(dir)
      expect(result.changes).toEqual([])
      expect(result.files).toEqual([])
      expect(result.patch).toBe('')
    })

    it('空仓库（还没有第一个提交）也能用，base 为 undefined', async () => {
      await writeFile(join(dir, 'a.txt'), 'first\n')
      const result = await worktreeDiff(dir)
      expect(result.base).toBeUndefined()
      expect(result.changes[0]).toMatchObject({ path: 'a.txt', status: 'added' })
    })

    it('文件太多时只展开前 40 个，其余只报名字（评审不该被一份大补丁淹掉）', async () => {
      for (let index = 0; index < 45; index += 1) {
        await writeFile(join(dir, `f${String(index).padStart(2, '0')}.txt`), `${index}\n`)
      }
      const result = await worktreeDiff(dir)
      expect(result.files).toHaveLength(40)
      expect(result.omitted).toBe(5)
      expect(result.patch).toContain('还有 5 个文件未展开')
      expect(result.patch).toContain('f44.txt')
    })
  })
})
