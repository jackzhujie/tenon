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
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import git from 'isomorphic-git'
import type { GitCommit, GitFileChange } from '@tenon/protocol'
import { msg, TenonError } from '@tenon/protocol'

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

/**
 * 写对象 / 打包过程中落在**工作区根目录**的临时文件：`_tmp_<pid>_<hex>`。
 *
 * 它不是用户代码。本机上几乎看不见 —— 写和 rename 挤在同一个事件循环里 —— 但在
 * macOS runner 的慢盘上它会在目录里停足够久，被 `readdir` 逮到（2026-11-09 CI 实测，
 * `e2e:release` 第 6 节 "再改一轮" 整轮崩在 ENOENT）。
 *
 * 比"崩一下"更值得防的是**读到它**：那样它会被当用户文件 `add` 进历史，之后每次
 * clone 都带着一个 4MB 的垃圾。所以按名字剪掉，不做"先读到再说"的宽容。
 */
const TMP_FILE = /^_tmp_\d+_[0-9a-f]{8,}$/

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

/**
 * 文件在我们手里"消失"了 —— 列举时还在，读的时候没了。
 *
 * 两种来源必须是同一套判据：我们自己 `readFile` 拿到的是 node 的 `ENOENT`，
 * 而 `git.add` / `git.remove` 内部被 isomorphic-git 转成了 `NotFoundError`
 * （它的 FileSystem 把 lstat 的 ENOENT 折成 null 再抛自己的类）。
 * 只认前者会让 `add` 那一步继续崩 —— 单测里实测过，报错是 `Could not find sub/f0.txt`。
 */
function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'NotFoundError'
}

/** 递归列出工作区文件（已剪枝），返回 相对路径 → 内容 blob oid */
async function workdirOids(root: string, prefix = ''): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const absolute = prefix === '' ? root : join(root, prefix)
  let entries: Dirent[]
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    // 目录在"列父目录"和"列它自己"之间消失：这一支已经没有内容可提交了。
    // 不吞别的错误 —— EACCES 之类是环境坏了，必须让调用方看见
    if (isGone(error)) return found
    throw error
  }  for (const entry of entries) {
    if (PRUNE_DIRS.has(entry.name)) continue
    if (TMP_FILE.test(entry.name)) continue
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [key, value] of await workdirOids(root, relative)) found.set(key, value)
      continue
    }
    if (!entry.isFile()) continue
    // 列举与读取之间文件消失是**正常**的：Agent 在原子写（临时文件 + rename）、
    // 预览/依赖安装也在增删文件。ENOENT 只说明"这一项已经不在了"，跳过即可 ——
    // 为此让整轮 commit 失败，等于把一次无害的并发变成一次对话的结束
    try {
      found.set(relative, blobOid(await readFile(join(root, relative))))
    } catch (error) {
      if (isGone(error)) continue
      throw error
    }
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
    throw new TenonError('GIT_NOT_INITIALIZED', msg('error.git.notRepo', { dir }))
  }

  const { upserts, deletes } = await workingTreeChanges(dir)
  if (upserts.length === 0 && deletes.length === 0) return undefined

  // 第二道口子：`git.add` 会**自己再读一遍文件**，所以上面算 oid 时躲过的竞态在这里会
  // 重演一遍（单测实测报 `Could not find sub/f0.txt`）。读不到的就不进这一轮 ——
  // 它已经不在工作区了，下一轮 workdirOids 会把它算成删除，自愈
  const staged: string[] = []
  for (const filepath of upserts) {
    try {
      // force：忽略 index 里的 stat 缓存，确保内容真的这次被读了一遍
      await git.add({ fs, dir, filepath, force: true })
      staged.push(filepath)
    } catch (error) {
      if (isGone(error)) continue
      throw error
    }
  }
  const removed: string[] = []
  for (const filepath of deletes) {
    try {
      await git.remove({ fs, dir, filepath })
      removed.push(filepath)
    } catch (error) {
      if (isGone(error)) continue
      throw error
    }
  }
  // 全都在列举之后消失了：这一轮没有可提交的东西，别造一条空提交
  if (staged.length === 0 && removed.length === 0) return undefined

  const message = buildMessage(summary, trailers)
  const sha = await git.commit({ fs, dir, message, author: AUTHOR })
  return { sha, message, changed: [...staged, ...removed] }
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
    throw new TenonError('GIT_DIFF_FAILED', msg('error.git.diffFailed', { from, to }), {
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

/** 前 4KB 里有 NUL 就当二进制：不必解码，也不该把二进制塞给模型 */
function isBinary(content: Uint8Array): boolean {
  for (let k = 0; k < Math.min(content.byteLength, 4096); k += 1) {
    if (content[k] === 0) return true
  }
  return false
}

async function blobText(dir: string, oid: string | undefined): Promise<string | undefined> {
  if (oid === undefined) return undefined
  const { blob } = await git.readBlob({ fs, dir, oid })
  if (blob.byteLength > MAX_DIFF_BYTES) return undefined
  if (isBinary(blob)) return undefined
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
    throw new TenonError('GIT_DIFF_FAILED', msg('error.git.commitMissing', { sha }))
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

/** 工作区里最多列出多少个文件（超出的只报数，让 Agent 自己 grep） */
const MAX_WORKTREE_FILES = 40

/**
 * 工作区（还没提交的改动）相对 HEAD 的结构化差异。
 *
 * 为什么需要它：Reviewer 的工作时机是**提交之前** —— 主角色刚改完代码、这一轮还没结束。
 * `diff()` / `showCommit()` 比的都是两棵树，看不到工作区。
 *
 * 为什么不用 `git.statusMatrix` / `WORKDIR` walker：同一个坑（见 `workingTreeChanges` 的注释）——
 * stat 快路径会把"同长度、同一毫秒"的改动判成没变。对评审的后果比 commit 轻（少看一个文件，
 * 不至于坏数据），但"评审说没问题、其实没看到那个文件"恰恰是最坏的一种绿。
 * 所以这里同样**按内容自算 blob oid**，宁可多读一遍盘。
 */
export interface WorktreeDiff extends DiffResult {
  /** 比对基准（HEAD 的 sha）；空仓库（还没有第一个提交）为 undefined */
  base: string | undefined
  /** 因为太多而没展开的文件数（会在 patch 尾部说明） */
  omitted: number
}

export async function worktreeDiff(dir: string): Promise<WorktreeDiff> {
  if (!(await isRepo(dir))) {
    throw new TenonError('GIT_NOT_INITIALIZED', msg('error.git.notRepo', { dir }))
  }
  const base = await headSha(dir)
  const { upserts, deletes } = await workingTreeChanges(dir)
  const committed = await headTreeOids(dir)

  const entries: Array<{ path: string; status: GitFileChange['status']; fromOid?: string }> = [
    ...upserts.map((path) => ({
      path,
      status: (committed.has(path) ? 'modified' : 'added') as GitFileChange['status'],
      fromOid: committed.get(path),
    })),
    ...deletes.map((path) => ({
      path,
      status: 'deleted' as GitFileChange['status'],
      fromOid: committed.get(path),
    })),
  ]
  entries.sort((x, y) => x.path.localeCompare(y.path))

  const shown = entries.slice(0, MAX_WORKTREE_FILES)
  const changes: GitFileChange[] = []
  const files: DiffFile[] = []

  for (const entry of shown) {
    const before = entry.fromOid === undefined ? undefined : await blobText(dir, entry.fromOid)
    // 新一侧读盘而不是读 git 对象：工作区的内容还没进对象库（也可能永远不进）
    const raw =
      entry.status === 'deleted' ? undefined : await readFile(join(dir, entry.path)).catch(() => undefined)
    // 超大文件与二进制同路：不算差异，只标出来（读 20MB 的文本去 LCS 是纯浪费）
    const after =
      raw === undefined || raw.byteLength > MAX_DIFF_BYTES || isBinary(raw) ? undefined : raw.toString('utf8')

    const binary = entry.status !== 'deleted' && raw !== undefined && after === undefined
    if (binary) {
      const header = `--- a/${entry.path}\n+++ b/${entry.path}\n`
      files.push({
        path: entry.path,
        status: entry.status,
        insertions: 0,
        deletions: 0,
        lines: [],
        binary: true,
        patch: `${header}@@ 二进制或超大文件，不做逐行 diff @@\n`,
      })
      changes.push({ path: entry.path, status: entry.status })
      continue
    }

    const computed = lineDiff(entry.path, before ?? null, after ?? null)
    files.push({ path: entry.path, status: entry.status, ...computed })
    changes.push({
      path: entry.path,
      status: entry.status,
      insertions: computed.insertions,
      deletions: computed.deletions,
    })
  }

  const omitted = entries.length - shown.length
  const tail =
    omitted > 0
      ? `@@ 还有 ${omitted} 个文件未展开（单次上限 ${MAX_WORKTREE_FILES}）：${entries
          .slice(MAX_WORKTREE_FILES)
          .map((entry) => entry.path)
          .join(', ')} @@\n`
      : ''
  return { base, changes, files, patch: files.map((file) => file.patch).join('') + tail, omitted }
}

export interface RevertPlan {
  /** 真正要回滚的提交（完整 sha，调用方传的可能是缩写） */
  readonly targetSha: string
  /** 回滚之后代码会回到的状态 —— 也就是目标提交的父提交 */
  readonly parentSha: string
  /** 从 `parentSha` 起往前的整条链（新 → 旧），用于回溯"最近一份库快照在哪" */
  readonly ancestors: readonly string[]
}

/**
 * 回滚前的可行性检查，**单独导出**是为了让调用方在动手之前就能问"这件事能做吗"。
 *
 * 为什么不能"先做了再说"：带数据还原的回滚里，**覆盖数据库是不可逆的**，
 * 而回滚代码是可逆的（再回滚一次就行）。所以顺序必须是
 * 「检查 → 还原数据 → 回滚代码」，检查这一步就必须能脱离执行独立调用。
 *
 * 两条规则和 `revert()` 共用同一份实现，避免"预览说能做、真做时又报错"。
 */
export async function planRevert(dir: string, sha: string): Promise<RevertPlan> {
  const commits = await git.log({ fs, dir, depth: 200 })
  const target = commits.find((entry) => entry.oid.startsWith(sha) || entry.oid === sha)
  if (target === undefined) {
    throw new TenonError('GIT_REVERT_FAILED', msg('error.git.commitMissing', { sha }))
  }
  const parent = target.commit.parent[0]
  if (parent === undefined) {
    // 根提交的反向应用等于清空仓库，语义可疑；真需要就走「删应用」而不是回滚
    throw new TenonError('NOT_IMPLEMENTED', msg('error.git.revertRoot'))
  }
  const index = commits.findIndex((entry) => entry.oid === target.oid)
  return {
    targetSha: target.oid,
    parentSha: parent,
    ancestors: commits.slice(index + 1).map((entry) => entry.oid),
  }
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
  const plan = await planRevert(dir, sha)
  const entries = (await treeDiff(dir, plan.parentSha, plan.targetSha)).map((e) => ({
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

  const shortSha = plan.targetSha.slice(0, 7)
  /*
   * 提交信息用英文：它是 git 历史，会跟着仓库离开这台机器（见 STATUS §2「系统生成的文本」）。
   * 正文那句"不改写历史"是给半年后翻 `git log` 的人看的，所以留在这儿而不是注释里。
   */
  const result = await commitAll(
    dir,
    `revert: undo ${shortSha}\n\nThis commit applies the reverse of ${shortSha} (Tenon reverts by adding, never by rewriting history).`,
    trailers,
  )
  if (result === undefined) {
    throw new TenonError('GIT_REVERT_FAILED', msg('error.git.revertNoChange', { sha: shortSha }))
  }
  return result
}

// ---------------------------------------------------------------- 发布：打标签 + 推到备份库

/** 工作区里还没提交的路径。发布前要为空 —— 半截状态发出去比不发更糟 */
export async function uncommittedChanges(dir: string): Promise<string[]> {
  if (!(await isRepo(dir))) return []
  const { upserts, deletes } = await workingTreeChanges(dir)
  return [...upserts, ...deletes]
}

export async function listTags(dir: string): Promise<string[]> {
  if (!(await isRepo(dir))) return []
  try {
    return (await git.listTags({ fs, dir })).sort()
  } catch {
    return []
  }
}

export interface ReleaseTagInput {
  /** 同时是版本号，如 `v2026.11.01-1` */
  tag: string
  sha: string
  message: string
  when?: Date
}

/**
 * 打一个 annotated tag。
 *
 * 为什么用 annotated 而不是轻量 tag：轻量 tag 只是一个 ref，`git show` 看不到"谁在什么时候发的、
 * 这一版想说什么"。发布记录在 `tenon.db` 里有一份，但那是 Tenon 的内部账本 ——
 * **代码仓库自己也该带着这份信息**，否则把备份库交给别人（`git clone` 走）时版本说明就丢了。
 */
export async function createReleaseTag(dir: string, input: ReleaseTagInput): Promise<string> {
  const when = input.when ?? new Date()
  const oid = await git.writeTag({
    fs,
    dir,
    tag: {
      object: input.sha,
      type: 'commit',
      tag: input.tag,
      tagger: {
        name: AUTHOR.name,
        email: AUTHOR.email,
        timestamp: Math.floor(when.getTime() / 1000),
        // isomorphic-git 要的是"UTC 西为正"的分钟数，正是 Date 的 getTimezoneOffset()
        timezoneOffset: when.getTimezoneOffset(),
      },
      message: input.message,
    },
  })
  await git.writeRef({ fs, dir, ref: `refs/tags/${input.tag}`, value: oid, force: true })
  return oid
}

export async function deleteTag(dir: string, tag: string): Promise<void> {
  await git.deleteRef({ fs, dir, ref: `refs/tags/${tag}` }).catch(() => undefined)
}

function toBuffer(value: string | Uint8Array): Uint8Array {
  // ⚠️ 内容必须转成 Buffer：`writeObject` 对 string 的处理是坏的（实测写出来的 tag 对象
  // 解压后是一段乱码，`git fsck` 直接判定 object could not be parsed）
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value
}

async function objectExists(gitdir: string, oid: string): Promise<boolean> {
  try {
    await git.readObject({ fs, gitdir, oid })
    return true
  } catch {
    return false
  }
}

/** 从 HEAD 出发收集**所有可达对象**（提交 / 树 / blob） */
async function collectReachable(dir: string, head: string): Promise<Set<string>> {
  const oids = new Set<string>([head])
  const walkedRoots = new Set<string>()
  const commits = await git.log({ fs, dir, depth: 100_000 })
  for (const entry of commits) {
    oids.add(entry.oid)
    const { commit } = await git.readCommit({ fs, dir, oid: entry.oid })
    const root = commit.tree
    // 一轮一 commit，相邻两轮常常共享整棵子树；按根树去重能把「同一份没变的目录」
    // 只走一遍（走一遍就是一次 readdir + 每个文件算 oid）
    if (walkedRoots.has(root)) continue
    walkedRoots.add(root)
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: entry.oid })],
      map: async (_path, entries) => {
        const entry2 = entries[0]
        if (entry2 === null || entry2 === undefined) return undefined
        const oid = await entry2.oid()
        if (oid !== undefined) oids.add(oid)
        return undefined
      },
    })
  }
  return oids
}

async function ensureBareRepo(dir: string, branch: string): Promise<void> {
  try {
    await fs.promises.access(join(dir, 'objects'))
  } catch {
    await mkdir(dir, { recursive: true })
    await git.init({ fs, dir, bare: true, defaultBranch: branch })
    return
  }
  // 备份库可能是从别处拷来的、或者默认分支不叫 main：HEAD 指错的话
  // `git clone` 出来是一个空仓库（不报错，最坏的一种失败）
  const head = await fs.promises.readFile(join(dir, 'HEAD'), 'utf8').catch(() => '')
  if (!head.includes(`refs/heads/${branch}`)) {
    await git.writeRef({
      fs,
      gitdir: dir,
      ref: 'HEAD',
      value: `refs/heads/${branch}`,
      symbolic: true,
      force: true,
    })
  }
}

export interface MirrorOptions {
  branch?: string
  /** 要一并推过去的 tag（发布版本）；不存在会抛 `GIT_DIFF_FAILED` 之外的原样错误 */
  tags?: readonly string[]
}

export interface MirrorResult {
  branch: string
  head: string
  /** 这次真正写进备份库的对象数（已存在的不算 —— 重复发布不应该每次都搬全量） */
  objects: number
  tags: string[]
}

/**
 * 把仓库**推送**到一个裸库（DESIGN §12.1「未配置远端时 push 到本地裸库」）。
 *
 * 为什么不是 `git.push`：isomorphic-git 1.44 的 push 只认 HTTP 传输
 * （对本地路径也会报 `requires a "http" parameter`），而 Tenon 不能假设用户机器上有 Git 服务、
 * 也不该为了备份去起一个。所以这里用 git 自己的对象模型搬运：
 * 收集可达对象 → `writeObject` 写进目标库 → 写 ref。传的东西和真 push 一样是**对象 + ref**，
 * 只是少了协商（备份是整库镜像，不需要增量协商）。
 *
 * 代价：每轮发布要遍历一次对象图。真实应用是几十个文本文件，实测在几十毫秒量级；
 * 已经存在的对象会跳过，所以重复发布是增量写。
 */
export async function mirrorTo(
  dir: string,
  targetDir: string,
  options: MirrorOptions = {},
): Promise<MirrorResult> {
  const branch = options.branch ?? 'main'
  if (!(await isRepo(dir))) {
    throw new TenonError('GIT_NOT_INITIALIZED', msg('error.git.notRepo', { dir }))
  }
  const head = await headSha(dir)
  if (head === undefined) {
    throw new TenonError('RELEASE_NO_COMMITS', msg('error.release.noCommits'))
  }

  await ensureBareRepo(targetDir, branch)

  const tags = [...(options.tags ?? [])]
  const tagOids: string[] = []
  for (const tag of tags) {
    const oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${tag}` })
    tagOids.push(oid)
  }

  const oids = await collectReachable(dir, head)
  for (const oid of tagOids) oids.add(oid)

  let written = 0
  for (const oid of oids) {
    if (await objectExists(targetDir, oid)) continue
    const read = await git.readObject({ fs, dir, oid, format: 'content' })
    // `format: 'content'` 下类型只可能是这四种；出现别的说明读到的是内部表示
    // （deflated / wrapped），当一个裸字节搬过去会写坏目标库 —— 宁可报错
    if (read.type !== 'commit' && read.type !== 'tree' && read.type !== 'blob' && read.type !== 'tag') {
      throw new TenonError('RELEASE_FAILED', msg('error.release.unknownObject', { type: read.type, oid }))
    }
    await git.writeObject({
      fs,
      gitdir: targetDir,
      type: read.type,
      object: toBuffer(read.object as string | Uint8Array),
      format: 'content',
    })
    written += 1
  }

  for (const [index, tag] of tags.entries()) {
    await git.writeRef({
      fs,
      gitdir: targetDir,
      ref: `refs/tags/${tag}`,
      value: tagOids[index] as string,
      force: true,
    })
  }
  await git.writeRef({ fs, gitdir: targetDir, ref: `refs/heads/${branch}`, value: head, force: true })
  return { branch, head, objects: written, tags }
}
