/**
 * 发布的集成测试：走真 HTTP，验的是「编排」而不是 git 原语（那些在 core 的单测里）。
 *
 * 三条最容易错的事，各有一个用例钉住：
 * 1. 无提交不该发一个空版本
 * 2. 工作区脏（上一轮没写完）不该发出去
 * 3. 推送失败时**不能留下没有记录的 tag** —— 否则下次发布直接跳到 -2，用户以为少发了一版
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import git from 'isomorphic-git'
import fs from 'node:fs'
import { appPaths, gitops, resolveHome } from '@tenon/core'
import { boot, TEST_TOKEN, type BootOptions } from './support.js'
import type { RunningServer } from '../src/index.js'

interface Release {
  id: string
  appId: string
  version: string
  commitSha: string
  kind: string
  artifactPath: string | null
  notes: string | null
}

interface PublishResult {
  release: Release
  version: string
  commitSha: string
  backupPath: string
  branch: string
  objects: number
}

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-release-srv-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

async function bootServer(options: BootOptions = {}): Promise<RunningServer> {
  running = await boot(dir, options)
  return running
}

async function rpc<T>(server: RunningServer, method: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } }
  if (!body.ok) throw new Error(`${method} 失败：${body.error?.code} ${body.error?.message}`)
  return body.data as T
}

async function rpcError(
  server: RunningServer,
  method: string,
  input: unknown,
): Promise<{ code: string; message: string }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; error?: { code: string; message: string } }
  if (body.ok) throw new Error(`${method} 本该失败`)
  return body.error as { code: string; message: string }
}

async function createApp(server: RunningServer): Promise<string> {
  const created = await rpc<{ app: { id: string } }>(server, 'app.create', {
    name: '发布测试',
    templateId: 'react-vite',
    styleId: null,
  })
  return created.app.id
}

async function commit(server: RunningServer, appId: string, file: string, content: string): Promise<string> {
  const repoDir = appPaths(resolveHome({ TENON_HOME: dir }), appId).repoDir
  await writeFile(join(repoDir, file), content)
  const result = await gitops.commitAll(repoDir, `feat: ${file}`)
  if (result === undefined) throw new Error('测试里应该有改动')
  void server
  return result.sha
}

describe('发布（release.publish）', () => {
  it('把 commit 冻结成版本：记一条 release，备份库 HEAD 指向它', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const sha = await commit(server, appId, 'note.txt', 'v1\n')

    const result = await rpc<PublishResult>(server, 'release.publish', { appId, notes: '第一版' })
    expect(result.version).toMatch(/^v\d{4}\.\d{2}\.\d{2}-1$/)
    expect(result.commitSha).toBe(sha)
    expect(result.release.kind).toBe('push')
    expect(result.release.notes).toBe('第一版')
    // 发布说明同时进了 tag 正文：把备份库 clone 走的人也能看到
    const tagOid = await git.resolveRef({ fs, gitdir: result.backupPath, ref: `refs/tags/${result.version}` })
    const tag = (await git.readObject({ fs, gitdir: result.backupPath, oid: tagOid })).object as unknown as {
      message: string
    }
    expect(tag.message).toContain('第一版')

    const remoteHead = await git.resolveRef({ fs, gitdir: result.backupPath, ref: 'refs/heads/main' })
    expect(remoteHead).toBe(sha)

    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases.map((release) => release.version)).toEqual([result.version])
  })

  it('同一天再发一次是 -2，备份库跟着前进', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await commit(server, appId, 'note.txt', 'v1\n')
    const first = await rpc<PublishResult>(server, 'release.publish', { appId })

    const secondSha = await commit(server, appId, 'note.txt', 'v2\n')
    const second = await rpc<PublishResult>(server, 'release.publish', { appId })

    expect(second.version).not.toBe(first.version)
    expect(second.version.endsWith('-2')).toBe(true)
    expect(await git.resolveRef({ fs, gitdir: second.backupPath, ref: 'refs/heads/main' })).toBe(secondSha)

    // 历史是累加的，不是覆盖：备份库里两版都在
    const tags = await git.listTags({ fs, gitdir: second.backupPath })
    expect(tags).toEqual(expect.arrayContaining([first.version, second.version]))
  })

  it('仓库里一条提交都没有时拒绝发布，也不会凭空造一个备份库', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    // 建应用会有一个初始提交，把它删掉，造出「仓库在、历史空」的状态
    await rm(join(paths.repoDir, '.git'), { recursive: true, force: true })
    await gitops.initRepo(paths.repoDir)

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_NO_COMMITS')

    await expect(readFile(join(paths.backupRepo, 'HEAD'), 'utf8')).rejects.toThrowError()
  })

  it('工作区还有没提交的改动时拒绝（可能这一轮没跑完）', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await commit(server, appId, 'note.txt', 'v1\n')

    const repoDir = appPaths(resolveHome({ TENON_HOME: dir }), appId).repoDir
    await writeFile(join(repoDir, 'note.txt'), '写了一半\n')

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('GIT_DIRTY_WORKTREE')
    expect(error.message).toContain('note.txt')
  })

  it('推送失败时把 tag 删掉，不留「有 tag 没记录」的半成品', async () => {
    const server = await bootServer()
    const appId = await createApp(server)
    await commit(server, appId, 'note.txt', 'v1\n')

    // 把备份库路径做成一个普通文件：裸库建不出来，推送必然失败
    const paths = appPaths(resolveHome({ TENON_HOME: dir }), appId)
    await mkdir(dirname(paths.backupRepo), { recursive: true })
    await writeFile(paths.backupRepo, '不是目录\n')

    const error = await rpcError(server, 'release.publish', { appId })
    expect(error.code).toBe('RELEASE_FAILED')

    expect(await gitops.listTags(paths.repoDir)).toEqual([])
    const listed = await rpc<{ releases: Release[] }>(server, 'release.list', { appId })
    expect(listed.releases).toEqual([])
  })

  it('应用不存在时报 APP_NOT_FOUND，而不是在别的目录里乱发布', async () => {
    const server = await bootServer()
    const error = await rpcError(server, 'release.publish', { appId: 'app-nope' })
    expect(error.code).toBe('APP_NOT_FOUND')
  })
})
