/**
 * DCO 检查自己的护栏 —— 门禁脚本出错时的表现必须是「红」，不能是「绿」。
 *
 * 为什么这些用例非写不可：这条路只有两种坏法，**两种都不会有人发现**。
 * 1. 漏判（该红的绿了）：于是「每个提交都签过」这句话变回一句空话，
 *    而它失效时没有任何东西会坏；
 * 2. 误判（该绿的频红）：于是这个 job 被 skip 掉或加 `continue-on-error`，
 *    结果和 1 一样，只是多花了几轮时间。
 *
 * 用例都用**真的 git 仓库**（临时目录）跑，不 mock：要测的正是「git 自己怎么解析
 * trailer」，mock 掉之后就只在测我自己的假设了。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSignoffs } from '../check-dco.js'

const made: string[] = []
let counter = 0

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  })
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tenon-dco-'))
  made.push(dir)
  git(dir, ['init', '-b', 'main'])
  // 仓库级配置压过全局：本机开着的 gpgsign / hooks 不该影响这条测试
  git(dir, ['config', 'user.name', 'Test User'])
  git(dir, ['config', 'user.email', 't@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

/** 每次提交改一个新文件，免得「没有变更」让 commit 失败 */
function commit(dir: string, message: string, extra: string[] = [], env: Record<string, string> = {}): string {
  writeFileSync(join(dir, `f${counter++}.txt`), message)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', ...extra, '-m', message], env)
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

describe('checkSignoffs', () => {
  it('passes when every commit carries a matching sign-off', () => {
    const dir = makeRepo()
    const first = commit(dir, 'one', ['-s'])
    commit(dir, 'two', ['-s'])

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toEqual([])
    expect(result.checked).toBe(1)
  })

  it('flags a commit with no trailer at all', () => {
    const dir = makeRepo()
    const first = commit(dir, 'signed', ['-s'])
    commit(dir, 'not signed')

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.reason).toBe('missing')
  })

  /**
   * 这是整条护栏最要紧的一条。
   *
   * 本仓库的文档型提交里真的会写「`Signed-off-by: ...`」举例；如果实现是按行 grep，
   * 那么一句出现在正文中间的示例就会被当成签名 —— 而 `grep -c Signed-off-by`
   * 在本仓库数出 71、真正的 trailer 是 0，正是这个误判。
   */
  it('ignores a Signed-off-by line that is part of the message body', () => {
    const dir = makeRepo()
    const first = commit(dir, 'base', ['-s'])
    commit(
      dir,
      'docs: explain the trailer\n\nSigned-off-by: Fake Person <fake@example.com>\n\n然后还有正文。',
    )

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.reason).toBe('missing')
  })

  it('flags a sign-off that names somebody else', () => {
    const dir = makeRepo()
    const first = commit(dir, 'base', ['-s'])
    commit(dir, 'copy-pasted trailer\n\nSigned-off-by: Someone Else <else@example.com>')

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.reason).toBe('mismatch')
    expect(result.violations[0]?.signers).toEqual(['else@example.com'])
  })

  /** 宽松的那一处：`--author` 之后 author 与 committer 不同，任一匹配都算签过 */
  it('accepts a sign-off that matches the author instead of the committer', () => {
    const dir = makeRepo()
    const first = commit(dir, 'base', ['-s'])
    commit(
      dir,
      'signed by the author\n\nSigned-off-by: Other Person <other@example.com>',
      ['--author', 'Other Person <other@example.com>'],
    )

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toEqual([])
  })

  /** 真实地址是 `49699333+dependabot[bot]@users.noreply.github.com`，`[bot]` 不在末尾 */
  it('skips bot commits (the [bot] marker sits inside the address)', () => {
    const dir = makeRepo()
    const first = commit(dir, 'base', ['-s'])
    commit(dir, 'chore(deps): bump x', [], {
      GIT_AUTHOR_NAME: 'dependabot[bot]',
      GIT_AUTHOR_EMAIL: '49699333+dependabot[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'dependabot[bot]',
      GIT_COMMITTER_EMAIL: '49699333+dependabot[bot]@users.noreply.github.com',
    })

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toEqual([])
    expect(result.checked).toBe(0)
  })

  it('skips merge commits but still checks what the branch brought in', () => {
    const dir = makeRepo()
    const first = commit(dir, 'base', ['-s'])
    git(dir, ['checkout', '-q', '-b', 'topic'])
    commit(dir, 'topic work', ['-s'])
    git(dir, ['checkout', '-q', 'main'])
    commit(dir, 'main work', ['-s'])
    // merge commit 自己没有签名：GitHub 网页合并出来的也是这样，不能因此红
    git(dir, ['merge', '-q', '--no-ff', 'topic', '-m', 'merge topic'])

    const result = checkSignoffs(dir, { from: first, to: 'HEAD' })
    expect(result.violations).toEqual([])
    // base 被区间排除、merge 自己被跳过，只剩两条真正带内容的提交
    expect(result.checked).toBe(2)
  })

  it('only looks at the given range', () => {
    const dir = makeRepo()
    commit(dir, 'old, unsigned')
    const middle = commit(dir, 'middle', ['-s'])
    commit(dir, 'new, unsigned')

    expect(checkSignoffs(dir, { from: middle, to: 'HEAD' }).checked).toBe(1)
    expect(checkSignoffs(dir, { from: middle, to: 'HEAD' }).violations).toHaveLength(1)
  })

  /**
   * 没有 `origin/main`（离线、单体本地库）时只看最后一条。
   * 否则一个克隆下来就要把几百条历史翻出来，第一次跑就红几百行 —— 那种门禁活不过一周。
   */
  it('checks only the newest commit when there is no base to compare against', () => {
    const dir = makeRepo()
    commit(dir, 'old, unsigned')
    commit(dir, 'new', ['-s'])

    const result = checkSignoffs(dir)
    expect(result.checked).toBe(1)
    expect(result.violations).toEqual([])
    expect(result.from).toBeNull()
  })

  /** 第一次推送时 `github.event.before` 是 40 个 0，要当成「没有 base」而不是一个坏 revision */
  it('treats an all-zero base as absent', () => {
    const dir = makeRepo()
    commit(dir, 'only commit', ['-s'])

    const result = checkSignoffs(dir, { from: '0'.repeat(40), to: 'HEAD' })
    expect(result.checked).toBe(1)
  })
})
