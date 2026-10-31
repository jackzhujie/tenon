/**
 * Git 一等公民（DESIGN §12）—— 全部走 isomorphic-git（纯 JS，无原生依赖）。
 *
 * 铁律：
 * - **一轮对话一个 commit**，commit message 带 trailer（会话/轮次/提交 id），方便回溯
 * - 回滚一律 `revert` 语义（新建一个反向提交），**不用 `reset --hard`**：历史不丢，
 *   pi-durable 的任务与文档仍能指回原 commit
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import git from 'isomorphic-git'
import type { GitCommit, GitFileChange } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'

const AUTHOR = { name: 'Tenon', email: 'tenon@localhost' } as const

export interface CommitTrailers {
  conversationId?: string
  turn?: number
  submissionId?: string
  taskId?: string
  [key: string]: string | number | undefined
}

export interface CommitResult {
  sha: string
  message: string
  changed: string[]
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  if (await isRepo(dir)) return
  await git.init({ fs, dir, defaultBranch: 'main' })
}

function buildMessage(summary: string, trailers: CommitTrailers | undefined): string {
  if (trailers === undefined) return summary
  const lines = Object.entries(trailers)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `Tenon-${key[0]!.toUpperCase()}${key.slice(1)}: ${String(value)}`)
  return lines.length === 0 ? summary : `${summary}\n\n${lines.join('\n')}`
}

/** 这些目录不参与提交（与 .gitignore 一致；目录遍历不会自己读 .gitignore，必须显式剪枝） */
const PRUNE_DIRS = new Set(['.git', 'node_modules', 'dist', '.tenon', 'pgdata', 'exports'])

interface WorkingChanges {
  upserts: string[]
  deletes: string[]
}

/** git blob oid = sha1("blob <bytes>\0" + content)，自己算，不依赖 isomorphic-git 的 stat 缓存 */
function blobOid(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

/** 递归列出工作区文件（已剪枝），返回 相对路径 → 内容 blob oid */
async function workdirOids(root: string, prefix = ''): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const entries = await readdir(prefix === '' ? root : join(root, prefix), { withFileTypes: true })
  for (const entry of entries) {
    if (PRUNE_DIRS.has(entry.name)) continue
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [key, value] of await workdirOids(root, relative)) found.set(key, value)
      continue
    }
    if (!entry.isFile()) continue
    found.set(relative, blobOid(await readFile(join(root, relative))))
  }
  return found
}

/** HEAD 树里每个 blob 的 oid。空仓库返回空表。 */
async function headTreeOids(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const head = await headSha(dir)
  if (head === undefined) return found
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: head })],
    // 只走 HEAD 一侧：树里的 oid 是既成事实，不存在 stat 缓存问题
    map: async (filepath, entries) => {
      const entry = entries[0]
      if (entry === null || entry === undefined) return undefined
      if ((await entry.type()) !== 'blob') return undefined
      const oid = await entry.oid()
      if (oid !== undefined) found.set(filepath, oid)
      return undefined
    },
  })
  return found
}

/**
 * **不能用 `git.statusMatrix`，也不能信 `WORKDIR` walker 的 `oid()`**：
 * 两者都带 stat 快路径，实测同一毫秒内写入的**同长度**改动（`v1\n` → `v2\n`）会被
 * 判成"没变"（statusMatrix 返回 `[1,1,1]`，WORKDIR 的 oid 仍是旧值），于是这一轮改动被
 * 静默跳过 —— 对「一轮一 commit」是致命的。这里自己按内容算 blob oid，宁可多读一遍盘。
 */
async function workingTreeChanges(dir: string): Promise<WorkingChanges> {
  const [current, committed] = await Promise.all([workdirOids(dir), headTreeOids(dir)])
  const upserts: string[] = []
  const deletes: string[] = []
  for (const [filepath, oid] of current) {
    if (committed.get(filepath) !== oid) upserts.push(filepath)
  }
  for (const filepath of committed.keys()) {
    if (!current.has(filepath)) deletes.push(filepath)
  }
  return { upserts: upserts.sort(), deletes: deletes.sort() }
}

/** 把工作区所有变化（新增/修改/删除）提交。没有变化返回 `undefined`，不产生空提交。 */
export async function commitAll(
  dir: string,
  summary: string,
  trailers?: CommitTrailers,
): Promise<CommitResult | undefined> {
  if (!(await isRepo(dir))) {
    throw new TenonError('GIT_NOT_INITIALIZED', `不是 git 仓库：${dir}`)
  }

  const { upserts, deletes } = await workingTreeChanges(dir)
  if (upserts.length === 0 && deletes.length === 0) return undefined

  for (const filepath of upserts) {
    // force：忽略 index 里的 stat 缓存，确保内容真的这次被读了一遍
    await git.add({ fs, dir, filepath, force: true })
  }
  for (const filepath of deletes) {
    await git.remove({ fs, dir, filepath })
  }

  const message = buildMessage(summary, trailers)
  const sha = await git.commit({ fs, dir, message, author: AUTHOR })
  return { sha, message, changed: [...upserts, ...deletes] }
}

export async function headSha(dir: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' })
  } catch {
    return undefined
  }
}

export async function log(dir: string, limit = 30): Promise<GitCommit[]> {
  if (!(await isRepo(dir))) return []
  try {
    const commits = await git.log({ fs, dir, depth: limit })
    return commits.map((entry) => ({
      sha: entry.oid,
      message: entry.commit.message.trimEnd(),
      author: entry.commit.author.name,
      at: entry.commit.author.timestamp * 1000,
      parents: entry.commit.parent,
    }))
  } catch {
    // 空仓库（还没有第一个 commit）会抛，视为空历史
    return []
  }
}

/** walk 两棵树，拿到变化的文件与两侧 blob oid */
async function treeDiff(
  dir: string,
  from: string,
  to: string,
): Promise<Array<{ path: string; fromOid?: string; toOid?: string }>> {
  const results: Array<{ path: string; fromOid?: string; toOid?: string }> = []
  try {
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
      map: async (filepath, entries) => {
        const [a, b] = entries
        const aOid = a === null || a === undefined ? undefined : await a.oid()
        const bOid = b === null || b === undefined ? undefined : await b.oid()
        if (aOid === bOid) return undefined
        const type = await (b ?? a)?.type()
        if (type !== 'blob') return undefined
        results.push({ path: filepath, fromOid: aOid, toOid: bOid })
        return undefined
      },
    })
  } catch (err) {
    throw new TenonError('GIT_DIFF_FAILED', `无法比对 ${from}..${to}`, {
      reason: err instanceof Error ? err.message : String(err),
    })
  }
  return results.sort((x, y) => x.path.localeCompare(y.path))
}

const MAX_DIFF_BYTES = 200_000
const MAX_DIFF_LINES = 1500

/** 行级 LCS 差异。只为「让人看懂改了什么」，不做精确的 hunk 合并。 */
function unifiedLineDiff(path: string, fromText: string, toText: string): string {
  const a = fromText.split('\n')
  const b = toText.split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `--- a/${path}\n+++ b/${path}\n@@ 文件过大，省略逐行 diff（${a.length} → ${b.length} 行）@@\n`
  }
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]!}`)
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push(`-${a[i]!}`)
      i += 1
    } else {
      lines.push(`+${b[j]!}`)
      j += 1
    }
  }
  while (i < n) {
    lines.push(`-${a[i]!}`)
    i += 1
  }
  while (j < m) {
    lines.push(`+${b[j]!}`)
    j += 1
  }
  return `--- a/${path}\n+++ b/${path}\n${lines.join('\n')}\n`
}

async function blobText(dir: string, oid: string | undefined): Promise<string | undefined> {
  if (oid === undefined) return undefined
  const { blob } = await git.readBlob({ fs, dir, oid })
  if (blob.byteLength > MAX_DIFF_BYTES) return undefined
  // 二进制判定：含 NUL 就当不可 diff
  for (let k = 0; k < Math.min(blob.byteLength, 4096); k += 1) {
    if (blob[k] === 0) return undefined
  }
  return Buffer.from(blob).toString('utf8')
}

export interface DiffResult {
  changes: GitFileChange[]
  patch: string
}

export async function diff(dir: string, from: string, to = 'HEAD'): Promise<DiffResult> {
  const entries = await treeDiff(dir, from, to)
  const changes: GitFileChange[] = []
  const patches: string[] = []
  for (const entry of entries) {
    const status: GitFileChange['status'] =
      entry.fromOid === undefined ? 'added' : entry.toOid === undefined ? 'deleted' : 'modified'
    const before = await blobText(dir, entry.fromOid)
    const after = await blobText(dir, entry.toOid)
    const fromText = before ?? ''
    const toText = after ?? ''
    const lines = unifiedLineDiff(entry.path, fromText, toText).split('\n')
    const insertions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    changes.push({ path: entry.path, status, insertions, deletions })
    if (before !== undefined || after !== undefined) patches.push(unifiedLineDiff(entry.path, fromText, toText))
  }
  return { changes, patch: patches.join('') }
}

/**
 * 回滚一个 commit：把该 commit 引入的改动反向应用，产生**新** commit。
 * 与 `reset --hard` 的区别是历史保留 —— 这也是 DESIGN §12 的硬性要求。
 */
export async function revert(
  dir: string,
  sha: string,
  trailers?: CommitTrailers,
): Promise<CommitResult> {
  const commits = await git.log({ fs, dir, depth: 200 })
  const target = commits.find((c) => c.oid.startsWith(sha) || c.oid === sha)
  if (target === undefined) {
    throw new TenonError('GIT_REVERT_FAILED', `找不到 commit ${sha}`)
  }
  const parent = target.commit.parent[0]
  if (parent === undefined) {
    // 根提交的反向应用等于清空仓库，语义可疑；真需要就走「删应用」而不是回滚
    throw new TenonError('NOT_IMPLEMENTED', 'M1 不支持回滚仓库的第一个提交')
  }
  const entries = (await treeDiff(dir, parent, target.oid)).map((e) => ({
    path: e.path,
    fromOid: e.toOid,
    toOid: e.fromOid,
  }))

  for (const entry of entries) {
    const absolute = join(dir, entry.path)
    if (entry.toOid === undefined) {
      await fs.promises.rm(absolute, { force: true })
      continue
    }
    const { blob } = await git.readBlob({ fs, dir, oid: entry.toOid })
    await mkdir(join(absolute, '..'), { recursive: true })
    await fs.promises.writeFile(absolute, Buffer.from(blob))
  }

  const shortSha = target.oid.slice(0, 7)
  const result = await commitAll(
    dir,
    `revert: 回滚 ${shortSha}\n\n本次提交反向应用了 ${shortSha} 的改动（Tenon 回滚不改写历史）。`,
    trailers,
  )
  if (result === undefined) {
    throw new TenonError('GIT_REVERT_FAILED', `回滚 ${shortSha} 没有产生任何改动`)
  }
  return result
}
