/**
 * DCO 检查 —— 每个提交必须带 `Signed-off-by`，不带就让 CI 红。
 *
 * ## 为什么这件事必须交给机器
 *
 * CONTRIBUTING 从 M0 起就写着「必须带 `Signed-off-by`」，而仓库里**一个都没有**。
 * 不是谁反对它，而是它的失效方式太安静：漏签不会让任何东西坏掉，跑测试、装应用、
 * 发布，全部照旧。等到某天真的需要回答「这段代码你有权提交吗」，那句声明是空的。
 * **一个没人执行、也没人发现的规则，等于没有这条规则。**
 *
 * ## 只查新增的提交，不追溯历史
 *
 * 追溯要 rebase 全部提交、改掉所有 sha —— 对已经公开的历史，代价远大于收益，
 * 而且会让所有指向旧 sha 的链接失效。门禁的意义是「从现在起不再漏」。
 *
 * ## 判定规则（比 GitHub 的 DCO App 宽松一处）
 *
 * - 只认 git **自己的** trailer 解析（`%(trailers:key=…)`）。
 *   不要自己按行 grep：提交正文里写一句 `Signed-off-by: ...` 举例，就会被当成签了。
 *   这不是假想 —— 本仓库的文档型提交里正好有这种句子，`grep -c` 数出 71，
 *   而真正的 trailer 是 0（见 STATUS §5）。
 * - 邮箱必须等于 **author 或 committer** 之一：`git commit -s` 写的是 committer，
 *   而 `rebase` / `--author` 之后两者可能不同，任一匹配都代表「这个人签了」。
 * - 合并提交不看（`--no-merges`）：它没有自己的内容，且 GitHub 合并时代签不了。
 * - 机器人跳过：dependabot 的提交不带 trailer，也没人能给它补。**判断不能只看后缀** ——
 *   真地址是 `49699333+dependabot[bot]@users.noreply.github.com`，`[bot]` 在中间。
 *
 * ## 为什么不用 GitHub 的 DCO App
 *
 * 多一个外部服务、多一次授权，而且结论落在 Checks 里而不是 Actions 日志里。
 * 我们要的是**本地能先跑一遍**（`pnpm check:dco`），红了当场改，而不是推上去等通知。
 *
 * 输出用英文：CI 日志会离开这台机器（见 STATUS §2 的语言边界表）。
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 一条不合规的提交。`reason` 直接进日志，所以写成能独立读懂的短句 */
export interface DcoViolation {
  sha: string
  short: string
  subject: string
  author: string
  reason: 'missing' | 'mismatch'
  /** 已经写了的签名的邮箱（`mismatch` 时用来说明「你签的是谁」） */
  signers: string[]
}

export interface DcoReport {
  /** 实际检查了几条提交（跳过的 bot / merge 不算） */
  checked: number
  violations: DcoViolation[]
  /** 用来报错时给出一条能直接粘的修复命令 */
  from: string | null
}

interface Options {
  /** 起点（不含）。空/全 0 表示「只查 to 这一条」 */
  from?: string | undefined
  /** 终点，默认 HEAD */
  to?: string | undefined
}

const FIELD = '\x1f'
const RECORD = '\x1e'
const ZERO_SHA = /^0+$/

/**
 * git 失败要**抛**而不是返回空字符串：把「没跑成」当成「全部合规」是这类门禁最坏的失效方式。
 *
 * 用 `spawnSync` 而不是 `execFileSync`：后者在失败时会把 git 的 stderr 再往终端写一遍，
 * 于是同一句 `fatal: bad revision` 在日志里出现两次，看着像两个不同的错
 */
class GitError extends Error {
  constructor(stderr: string) {
    super(stderr.trim() === '' ? 'git failed' : stderr.trim())
    this.name = 'GitError'
  }
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // 中文提交信息按 UTF-8 出来，别让 locale 把它变成问号
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new GitError(result.stderr)
  return result.stdout
}

function refExists(repo: string, ref: string): boolean {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * 没给区间时自己找一个：
 * - 有 `origin/main` → `origin/main..HEAD`，正好是「我要推的那几条」，推之前自检最准
 * - 没有（离线、只有一个本地库）→ 只查 HEAD 一条，别把整个历史翻出来
 */
function resolveRange(repo: string, options: Options): { from: string | null; to: string } {
  const to = options.to !== undefined && options.to !== '' ? options.to : 'HEAD'
  if (options.from !== undefined && options.from !== '' && !ZERO_SHA.test(options.from)) {
    return { from: options.from, to }
  }
  if (options.from === undefined && refExists(repo, 'origin/main')) {
    return { from: 'origin/main', to }
  }
  return { from: null, to }
}

/**
 * 一次 `git log` 取回全部提交。
 *
 * 字段用 `\x1f` 分隔、记录用 `\x1e` 开头：两者都不可能是人敲进提交信息的字符，
 * 比「按换行切」稳 —— 多行 subject（实际不会有）和多个签名都不会错位。
 */
export function checkSignoffs(repo: string, options: Options = {}): DcoReport {
  const { from, to } = resolveRange(repo, options)
  const format = [
    `%H`,
    `%an`,
    `%ae`,
    `%cn`,
    `%ce`,
    `%s`,
    // git 自己的 trailer 解析器。`valueonly` 只给 `Name <email>`，
    // 多个签名用逗号分隔；末尾那个 `\n` 由 git 加上，所以每段都要 trim
    `%(trailers:key=Signed-off-by,valueonly,separator=%x2C)`,
  ].join(FIELD)

  const revArgs = from === null ? ['--max-count=1', to, '--'] : [`${from}..${to}`, '--']
  const raw = git(repo, ['log', '--no-merges', `--format=${RECORD}${format}`, ...revArgs])

  const violations: DcoViolation[] = []
  let checked = 0

  for (const chunk of raw.split(RECORD)) {
    if (chunk.trim() === '') continue
    const parts = chunk.split(FIELD)
    // 字段顺序与上面 `format` 一一对应：%H %an %ae %cn %ce %s trailers。
    // 少写一个变量就会整体错位一格（作者名被当成邮箱、邮箱被当成标题）—— 已经错过一次
    const [sha, authorName, authorEmail, , committerEmail, subject, trailers] = parts
    if (sha === undefined || authorEmail === undefined || committerEmail === undefined) continue

    // 机器人：真正的地址长这样 `49699333+dependabot[bot]@users.noreply.github.com`
    // —— `[bot]` 在**中间**，所以不能只判后缀。名字一侧倒是以 `[bot]` 结尾
    const isBot = /\[bot\]/i.test(authorEmail) || /\[bot\]$/i.test(authorName?.trim() ?? '')
    if (isBot) continue

    checked++

    const signers = splitSignoffs(trailers ?? '')
    const own = new Set([authorEmail.trim().toLowerCase(), committerEmail.trim().toLowerCase()])
    if (signers.length === 0) {
      violations.push({
        sha: sha.trim(),
        short: sha.trim().slice(0, 7),
        subject: (subject ?? '').trim(),
        author: `${(authorName ?? '').trim()} <${authorEmail.trim()}>`,
        reason: 'missing',
        signers,
      })
    } else if (!signers.some((email) => own.has(email))) {
      violations.push({
        sha: sha.trim(),
        short: sha.trim().slice(0, 7),
        subject: (subject ?? '').trim(),
        author: `${(authorName ?? '').trim()} <${authorEmail.trim()}>`,
        reason: 'mismatch',
        signers,
      })
    }
  }

  return { checked, violations, from }
}

/** `Name <email>, Other <email>` → `['name@x', 'other@y']`（小写，只留邮箱） */
function splitSignoffs(trailers: string): string[] {
  return trailers
    .split(',')
    .map((one) => /<([^<>]+)>\s*$/.exec(one.trim())?.[1]?.trim().toLowerCase())
    .filter((email): email is string => email !== undefined && email !== '')
}

function report(repo: string, options: Options): number {
  let result: DcoReport
  try {
    result = checkSignoffs(repo, options)
  } catch (error) {
    // 「git 没跑成」不能和「全部合规」混为一谈 —— 这正是门禁最容易被骗的地方
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\n✗ DCO check could not run:\n\n${message}\n`)
    console.error('  Nothing was verified. Fix the git error above and re-run.\n')
    return 2
  }

  if (result.violations.length === 0) {
    console.log(`✓ ${result.checked} commit(s) checked, all signed off`)
    return 0
  }

  console.error(
    `\n✗ ${result.violations.length} of ${result.checked} commit(s) have no valid Signed-off-by` +
      ' (DCO, see CONTRIBUTING.md)\n',
  )
  for (const one of result.violations) {
    console.error(`  ${one.short}  ${one.subject}`)
    console.error(`           author: ${one.author}`)
    console.error(
      one.reason === 'missing'
        ? '           missing: no Signed-off-by trailer'
        : `           mismatch: signed off as ${one.signers.join(', ')}, expected the author or committer email`,
    )
    console.error('')
  }
  const base = result.from ?? 'origin/main'
  console.error('  Every commit needs a Signed-off-by line matching its author email.')
  console.error(`  Fix this branch:     git rebase --signoff ${base}`)
  console.error('  Never again:         git config format.signoff true')
  console.error('  Already pushed it?   git push --force-with-lease  (rewrites only this branch)')
  console.error('')
  return 1
}

/** 直接运行才执行（被测试 import 时不要跑） */
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  // 参数自然位置：`check-dco [from] [to]`。CI 里传两个 sha，本机不传
  const [from, to] = process.argv.slice(2)
  process.exit(report(process.cwd(), { from, to }))
}
