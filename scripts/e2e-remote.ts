/**
 * 真机端到端：**把一版推到真远端**（GitHub / GitLab / Gitea 的 HTTPS 仓库）。
 *
 * 为什么这条不能像别的 e2e 那样跑在 CI 里：它要一个**真的能收推送**的仓库。git 的
 * receive-pack 是二进制协议，没法像 `e2e:provider` 那样用一个假 HTTP 服务顶上 ——
 * 所以这条脚本的存在方式是：**有凭据就真跑，没有就明确 skip 并告诉你怎么给**。
 *
 * 它要一个**专门的测试仓库**（会往里面推分支和 tag，别指向你在意的仓库）：
 *
 *   TENON_TEST_GIT_URL=https://github.com/you/tenon-push-sandbox.git \
 *   TENON_TEST_GIT_TOKEN=ghp_xxx \
 *   pnpm e2e:remote
 *
 * 验的是五件事，每一件都是单测替代不了的：
 * 1. 令牌从库里解出来、交给 isomorphic-git 的 onAuth，**真的通过了认证**
 * 2. 分支和 tag 都到了远端（用系统 git `ls-remote` 当裁判 —— 我们自己的代码说成功不算证据）
 * 3. 读回来的配置里**没有令牌明文**
 * 4. 令牌写错时是 `AUTH` 且带指路文案（不是一句 "HTTP Error: 401"）
 * 5. 远端失败**不影响发布本身**：发布记录照写，`remote.ok` 为 false
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { appPaths, gitops } from '../packages/core/src/index.js'
import { startServer } from '../packages/server/src/index.js'

const run = promisify(execFile)
const TOKEN = 'e2e-remote-token'
const keep = process.argv.includes('--keep')

const url = process.env['TENON_TEST_GIT_URL'] ?? ''
const gitToken = process.env['TENON_TEST_GIT_TOKEN'] ?? ''

if (url === '' || gitToken === '') {
  console.log('跳过：没有给测试仓库。')
  console.log('')
  console.log('  这条要真推东西，所以需要一个**专门的**空仓库（会往里写分支和 tag）：')
  console.log('')
  console.log('    TENON_TEST_GIT_URL=https://github.com/you/tenon-push-sandbox.git \\')
  console.log('    TENON_TEST_GIT_TOKEN=ghp_xxx \\')
  console.log('    pnpm e2e:remote')
  console.log('')
  console.log('  令牌权限：Fine-grained token → Contents: Read and write，并勾选这个仓库。')
  process.exit(0)
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-remote-'))
console.log(`TENON_HOME = ${home}`)
console.log(`远端      = ${url}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
})

async function rpc<T>(method: string, input: unknown): Promise<T> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
  return body.data as T
}

/**
 * 系统 git 当裁判：远端到底有没有这个 ref。
 *
 * **凭据用 `GIT_CONFIG_*` 环境变量递进去，不拼 URL。** 两个原因：
 * - 拼进 URL 的凭据会进 `.git/config`、进日志、进任何打印 url 的地方
 * - 私有仓库裸 `ls-remote` 会**卡在交互式认证上**（等 stdin 输入用户名密码），
 *   写脚本时表现为"跑着跑着不动了"，看不出是在等输入
 * 顺带关掉终端提示：宁可直接失败，也不要一个等着人打字的子进程。
 */
async function lsRemote(pattern: string): Promise<string[]> {
  const basic = Buffer.from(`x-access-token:${gitToken}`).toString('base64')
  const { stdout } = await run('git', ['ls-remote', url, pattern], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
  })
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

try {
  console.log('1) 建应用、提交一次')
  const { app } = await rpc<{ app: { id: string; name: string } }>('app.create', { name: '推送测试' })
  const paths = appPaths(server.core.home, app.id)
  await writeFile(join(paths.repoDir, 'notes.md'), `推于 ${new Date().toISOString()}\n`)
  const commit = await gitops.commitAll(paths.repoDir, 'chore: 推送测试')
  check('提交成功', commit !== undefined)

  console.log('\n2) 配远端：读回来不能有令牌明文')
  const saved = await rpc<{ remote: Record<string, unknown> }>('release.remote.set', {
    appId: app.id,
    url,
    token: gitToken,
  })
  check('保存成功', saved.remote['url'] === url)
  check('hasToken 为真', saved.remote['hasToken'] === true)
  check('尾四位对得上', saved.remote['tokenHint'] === `…${gitToken.slice(-4)}`)
  check('整个结构里没有明文令牌', !JSON.stringify(saved.remote).includes(gitToken))

  const reread = await rpc<{ remote: Record<string, unknown> }>('release.remote', { appId: app.id })
  check('再读一次仍然没有明文', !JSON.stringify(reread.remote).includes(gitToken))

  console.log('\n3) 发布：本地备份库 + 远端都要成')
  /*
   * `force: true` 是刻意的：这条脚本验的是**推送链路**，不是门禁。模板应用还没装依赖，
   * 门禁里那几项必然不过（`e2e:release` 里正是拿它当"检查没过要拦住"的素材）。
   * 用 force 放行、记录里留 `forced` 痕迹，比为了过门禁去装一遍依赖划算得多。
   * 门禁本身仍会跑一遍 —— force 只影响拦不拦，不影响跑不跑。
   */
  const published = await rpc<{
    version: string
    release: { id: string }
    remote: { ok: boolean; code: string | null; message: string | null; refs: number } | null
  }>('release.publish', { appId: app.id, force: true })
  check('发布本身成功', published.release.id !== '')
  check('远端那格不是 null（配过就一定会推）', published.remote !== null)
  check('远端推送成功', published.remote?.ok === true, JSON.stringify(published.remote))
  check('推了分支和 tag 两个 ref', published.remote?.refs === 2, String(published.remote?.refs))

  console.log('\n4) 用系统 git 核对：远端真的有这个 tag')
  const tags = await lsRemote(`refs/tags/${published.version}`)
  check(`${published.version} 在远端`, tags.length === 1, tags.join(' '))
  const branches = await lsRemote('refs/heads/*')
  check('至少有一个分支在远端', branches.length >= 1, branches.join(' '))

  console.log('\n5) 令牌写错：必须报 AUTH 且指路，不能只说"失败了"')
  await rpc('release.remote.set', { appId: app.id, url, token: 'ghp_definitely_wrong_token' })
  const failed = await rpc<{
    outcome: { ok: boolean; code: string | null; message: string | null; hint: string | null }
  }>('release.push', { appId: app.id, version: published.version })
  check('ok 为 false', failed.outcome.ok === false)
  check('分类是 AUTH', failed.outcome.code === 'AUTH', String(failed.outcome.code))
  check(
    '给了指路文案（不是一句 401）',
    (failed.outcome.hint ?? '').includes('Contents: Read and write'),
    failed.outcome.hint ?? '(空)',
  )

  console.log('\n6) 令牌恢复后补推：同一版能推上去，且不多出一个版本号')
  await rpc('release.remote.set', { appId: app.id, url, token: gitToken })
  const again = await rpc<{ outcome: { ok: boolean; refs: number } }>('release.push', {
    appId: app.id,
    version: published.version,
  })
  check('补推成功', again.outcome.ok === true)
  check('仍然是两个 ref', again.outcome.refs === 2, String(again.outcome.refs))
  const releases = await rpc<{ releases: unknown[] }>('release.list', { appId: app.id, limit: 20 })
  check('发布记录只有一条（补推不该多出一版）', releases.releases.length === 1, String(releases.releases.length))
} finally {
  await server.close()
  if (keep) {
    console.log(`\n目录留着：${home}`)
  } else {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

if (failures > 0) {
  console.log(`\n${String(failures)} 项没通过`)
  process.exit(1)
}
console.log('\n全部通过：令牌、推送、验签、失败分类、补推 —— 一条链路。')
