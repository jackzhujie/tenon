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

/** 一行差异。`kind` 是给人看的颜色，行号是给"跳到源码"和"对齐两侧"用的 */
export interface DiffLine {
  kind: 'ctx' | 'add' | 'del'
  text: string
  /** 旧文件里的行号（1 起）；新增行没有 */
  oldLine: number | null
  /** 新文件里的行号（1 起）；删除行没有 */
  newLine: number | null
}

export interface DiffFile {
  path: string
  status: GitFileChange['status']
  insertions: number
  deletions: number
  /** 逐行差异。二进制或超大文件为空，靠 `binary` / `truncated` 说明原因 */
  lines: DiffLine[]
  /** 这个文件自己的 unified patch（复制给模型或人看） */
  patch: string
  binary?: boolean
  truncated?: boolean
}

/**
 * 行级 LCS 差异。只为「让人看懂改了什么」，不做精确的 hunk 合并 ——
 * 所以整份文件一次性比对，不切 `@@` 段。
 *
 * 为什么返回结构而不是纯文本：前端要按行着色、要能点错误日志跳到某一行，
 * 让它在浏览器里再解析一遍 `+`/`-` 前缀等于把同一件事做两遍、且更脆
 * （行内容本身可能以 `+` 开头）。
 */
function lineDiff(
  path: string,
  /**
   * 这一侧不存在时传 `null`，**不要传空串**。
   *
   * `''.split('\n')` 得到 `['']` —— 一个"空行"。新增文件因此会在全是 `+` 的
   * 差异里混进一行无意义的 context，删除文件同理，而且行号会整体错一格。
   */
  fromText: string | null,
  toText: string | null,
): Omit<DiffFile, 'path' | 'status'> {
  const a = fromText === null ? [] : fromText.split('\n')
  const b = toText === null ? [] : toText.split('\n')
  const header = `--- a/${path}\n+++ b/${path}\n`

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return {
      insertions: 0,
      deletions: 0,
      lines: [],
      truncated: true,
      patch: `${header}@@ 文件过大，省略逐行 diff（${a.length} → ${b.length} 行）@@\n`,
    }
  }

  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  const push = (kind: DiffLine['kind'], text: string): void => {
    lines.push({
      kind,
      text,
      oldLine: kind === 'add' ? null : oldNo,
      newLine: kind === 'del' ? null : newNo,
    })
    if (kind !== 'add') oldNo += 1
    if (kind !== 'del') newNo += 1
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('ctx', a[i]!)
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('del', a[i]!)
      i += 1
    } else {
      push('add', b[j]!)
      j += 1
    }
  }
  while (i < n) {
    push('del', a[i]!)
    i += 1
  }
  while (j < m) {
    push('add', b[j]!)
    j += 1
  }

  const insertions = lines.filter((line) => line.kind === 'add').length
  const deletions = lines.filter((line) => line.kind === 'del').length
  const body = lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
  return {
    insertions,
    deletions,
    lines,
    patch: `${header}${body.join('\n')}\n`,
  }
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

/** 空提交的 diff：整棵树都是「新增」（根提交没有父提交可比） */
async function treeDiffFromEmpty(
  dir: string,
  to: string,
): Promise<Array<{ path: string; toOid?: string }>> {
  const results: Array<{ path: string; toOid?: string }> = []
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: to })],
    map: async (filepath, entries) => {
      const entry = entries[0]
      if (entry === null || entry === undefined) return undefined
      if ((await entry.type()) !== 'blob') return undefined
      const oid = await entry.oid()
      if (oid !== undefined) results.push({ path: filepath, toOid: oid })
      return undefined
    },
  })
  return results.sort((x, y) => x.path.localeCompare(y.path))
}

export interface DiffResult {
  changes: GitFileChange[]
  /** 逐文件的结构化差异（前端直接渲染这个） */
  files: DiffFile[]
  /** 拼成一份完整的 unified patch（复制、塞给模型用） */
  patch: string
}

export async function diff(dir: string, from: string, to = 'HEAD'): Promise<DiffResult> {
  return buildDiff(dir, await treeDiff(dir, from, to))
}

/**
 * 一条提交自己改了什么（`git show` 的语义）。
 *
 * 不要用 `diff(dir, sha)` 代替 —— 那是「sha 之后到 HEAD」的累积变化，
 * 在提交列表里点第 3 个版本时会显示第 3 个之后的所有改动，看起来像「这一轮改了 8 个文件」。
 */
export async function showCommit(
  dir: string,
  sha: string,
): Promise<DiffResult & { commit: GitCommit }> {
  let oid: string
  let commit: Awaited<ReturnType<typeof git.readCommit>>['commit']
  try {
    oid = await git.resolveRef({ fs, dir, ref: sha })
    /*
     * `resolveRef` 对 40 位 hex **不校验存在性**，原样返回就完事；
     * 真要读不到是 `readCommit` 抛（错误信息是英文的 "Could not find …"）。
     * 两个都包在同一个 try 里，才能保证对外永远是 GIT_DIFF_FAILED 而不是 INTERNAL。
     */
    ;({ commit } = await git.readCommit({ fs, dir, oid }))
  } catch {
    throw new TenonError('GIT_DIFF_FAILED', `找不到 commit ${sha}`)
  }
  const parent = commit.parent[0]
  const entries =
    parent === undefined
      ? (await treeDiffFromEmpty(dir, oid)).map((entry) => ({
          path: entry.path,
          fromOid: undefined as string | undefined,
          toOid: entry.toOid,
        }))
      : await treeDiff(dir, parent, oid)
  return {
    ...(await buildDiff(dir, entries)),
    commit: {
      sha: oid,
      message: commit.message.trimEnd(),
      author: commit.author.name,
      at: commit.author.timestamp * 1000,
      parents: commit.parent,
    },
  }
}

async function buildDiff(
  dir: string,
  entries: Array<{ path: string; fromOid?: string; toOid?: string }>,
): Promise<DiffResult> {
  const changes: GitFileChange[] = []
  const files: DiffFile[] = []
  for (const entry of entries) {
    const status: GitFileChange['status'] =
      entry.fromOid === undefined ? 'added' : entry.toOid === undefined ? 'deleted' : 'modified'
    const before = await blobText(dir, entry.fromOid)
    const after = await blobText(dir, entry.toOid)

    /*
     * `blobText` 返回 undefined 有两种原因：文件不存在（新增/删除的一侧）或不可读（二进制/超大）。
     * 两者必须分开 —— 混在一起会把「改了一张图」显示成「整文件被替换成空」，
     * 用户看到的是几百行删除，而实际只动了 2KB。
     */
    const exists = entry.fromOid === undefined ? entry.toOid !== undefined : true
    const missingSide = entry.fromOid === undefined ? after : before
    const binary = exists && missingSide === undefined

    if (binary) {
      const header = `--- a/${entry.path}\n+++ b/${entry.path}\n`
      files.push({
        path: entry.path,
        status,
        insertions: 0,
        deletions: 0,
        lines: [],
        binary: true,
        patch: `${header}@@ 二进制文件，不做逐行 diff @@\n`,
      })
      changes.push({ path: entry.path, status })
      continue
    }

    const computed = lineDiff(entry.path, before ?? null, after ?? null)
    files.push({ path: entry.path, status, ...computed })
    changes.push({
      path: entry.path,
      status,
      insertions: computed.insertions,
      deletions: computed.deletions,
    })
  }
  return { changes, files, patch: files.map((file) => file.patch).join('') }
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
    throw new TenonError('NOT_IMPLEMENTED', '不支持回滚仓库的第一个提交（等于清空仓库）')
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
