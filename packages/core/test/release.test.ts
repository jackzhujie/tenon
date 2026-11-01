import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import git from 'isomorphic-git'
import fs from 'node:fs'
import { gitops, nextVersion, parseVersion, versionPrefix } from '../src/index.js'

let dir: string
/** 备份库必须放在**仓库外面**：放进去会被 commitAll 一起提交，镜像时又把自己搬进自己 */
let backupRoot: string
let backup: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-release-'))
  backupRoot = await mkdtemp(join(tmpdir(), 'tenon-backup-'))
  backup = join(backupRoot, 'backup.git')
  await gitops.initRepo(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(backupRoot, { recursive: true, force: true })
})

async function commit(file: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, file), content)
  const result = await gitops.commitAll(dir, message)
  if (result === undefined) throw new Error('测试里应该有改动')
  return result.sha
}

describe('版本号（v<yyyy.MM.dd>-<n>）', () => {
  const day = new Date(2026, 10, 1, 9, 30)

  it('当天第一次发布是 -1', () => {
    expect(versionPrefix(day)).toBe('v2026.11.01')
    expect(nextVersion([], day)).toBe('v2026.11.01-1')
  })

  it('同一天接着发就递增', () => {
    expect(nextVersion(['v2026.11.01-1'], day)).toBe('v2026.11.01-2')
    expect(nextVersion(['v2026.11.01-1', 'v2026.11.01-7'], day)).toBe('v2026.11.01-8')
  })

  it('别的日期的序号不影响今天', () => {
    expect(nextVersion(['v2026.10.31-9', 'v2026.11.01-2'], day)).toBe('v2026.11.01-3')
  })

  it('不认识的值直接忽略，而不是算错', () => {
    // 用户手打的 tag、别的命名方案、空串都不该把序号带偏
    expect(nextVersion(['v1.2.3', 'release-4', '', 'v2026.11.01'], day)).toBe('v2026.11.01-1')
  })

  it('只解析精确形状，宽容会带出错号', () => {
    expect(parseVersion('v2026.11.01-3')).toEqual({ date: '2026.11.01', n: 3 })
    expect(parseVersion('v2026.11.1-3')).toBeUndefined()
    expect(parseVersion('2026.11.01-3')).toBeUndefined()
    expect(parseVersion('v2026.11.01-')).toBeUndefined()
  })
})

describe('发布用的 git 原语', () => {
  it('annotated tag 带得住发布说明', async () => {
    const sha = await commit('a.txt', 'hello\n', 'init')
    const oid = await gitops.createReleaseTag(dir, {
      tag: 'v2026.11.01-1',
      sha,
      message: '第一版：能跑',
      when: new Date(2026, 10, 1, 9, 30),
    })

    const { object } = await git.readObject({ fs, dir, oid, format: 'parsed' })
    const tag = object as unknown as {
      object: string
      tag: string
      message: string
      tagger: { name: string; timestamp: number; timezoneOffset: number }
    }
    expect(tag.object).toBe(sha)
    expect(tag.tag).toBe('v2026.11.01-1')
    expect(tag.message).toContain('第一版')
    expect(tag.tagger.timestamp).toBe(Math.floor(new Date(2026, 10, 1, 9, 30).getTime() / 1000))

    expect(await gitops.listTags(dir)).toContain('v2026.11.01-1')
  })

  it('镜像到裸库后，历史与内容都读得回来', async () => {
    await commit('a.txt', 'v1\n', 'first')
    const sha = await commit('a.txt', 'v2\n', 'second')
    await gitops.createReleaseTag(dir, { tag: 'v2026.11.01-1', sha, message: '发布' })

    const result = await gitops.mirrorTo(dir, backup, { tags: ['v2026.11.01-1'] })
    expect(result.head).toBe(sha)
    expect(result.objects).toBeGreaterThan(0)

    const commits = await git.log({ fs, gitdir: backup, depth: 10 })
    expect(commits.map((entry) => entry.commit.message.trim())).toEqual(['second', 'first'])

    const blob = await git.readBlob({ fs, gitdir: backup, oid: sha, filepath: 'a.txt' })
    expect(Buffer.from(blob.blob).toString()).toBe('v2\n')

    // tag 对象也搬过去了（不是只有一个 ref）
    const tagOid = await git.resolveRef({ fs, gitdir: backup, ref: 'refs/tags/v2026.11.01-1' })
    const tag = await git.readObject({ fs, gitdir: backup, oid: tagOid })
    expect(tag.type).toBe('tag')
  })

  it('第二次镜像只写新增对象（增量）', async () => {
    await commit('a.txt', 'v1\n', 'first')
    const first = await gitops.mirrorTo(dir, backup)
    expect(first.objects).toBeGreaterThan(0)

    const second = await gitops.mirrorTo(dir, backup)
    expect(second.objects).toBe(0)

    const sha = await commit('b.txt', 'new\n', 'second')
    const third = await gitops.mirrorTo(dir, backup)
    expect(third.head).toBe(sha)
    // 只该写这一轮新增的那几个（commit + tree + blob）
    expect(third.objects).toBeGreaterThan(0)
    expect(third.objects).toBeLessThan(5)
  })

  it('备份库是可反复用的：再发布一次不会把旧历史冲掉', async () => {
    const first = await commit('a.txt', 'v1\n', 'first')
    await gitops.mirrorTo(dir, backup)
    const second = await commit('a.txt', 'v2\n', 'second')
    await gitops.mirrorTo(dir, backup)

    const commits = await git.log({ fs, gitdir: backup, depth: 10 })
    expect(commits.map((entry) => entry.oid)).toEqual([second, first])
  })

  it('没有提交时明确拒绝，而不是建一个空裸库', async () => {
    await expect(gitops.mirrorTo(dir, backup)).rejects.toThrowError(/还没有任何提交/)
  })

  it('工作区有未提交改动时能报出来（发布前的闸门）', async () => {
    await commit('a.txt', 'v1\n', 'first')
    expect(await gitops.uncommittedChanges(dir)).toEqual([])

    await writeFile(join(dir, 'a.txt'), 'v2\n')
    await writeFile(join(dir, 'b.txt'), 'new\n')
    expect((await gitops.uncommittedChanges(dir)).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('备份库目录不存在时自动建出来（含 HEAD）', async () => {
    await commit('a.txt', 'v1\n', 'first')
    const nested = join(backupRoot, 'nested', 'deep.git')
    await gitops.mirrorTo(dir, nested)
    const head = await fs.promises.readFile(join(nested, 'HEAD'), 'utf8')
    expect(head.trim()).toBe('ref: refs/heads/main')
  })
})
