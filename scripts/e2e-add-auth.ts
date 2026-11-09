/**
 * 真机端到端：**给一个纯前端应用加登录，然后它真的拦得住**。
 *
 * 这条链路专门验五件只有真跑才验得出来的事：
 *
 * 1. `app.addAuth` 会先把后端补上（纯前端应用的 `type: module` 那套 CJS 坑一起过）
 * 2. **`/api/health` 仍然是公开的** —— 全局守卫一旦把它也拦了，预览会永远
 *    "起不来"，而日志里只有超时（这是这套设计最容易一脚踩死的坑）
 * 3. 未登录时业务接口是 401，且 `Set-Cookie` 真的穿过网关（网关原样转发 rawHeaders）
 * 4. 初始化只能发生一次：建完账号后 `/api/auth/setup` 自己关闭
 * 5. 权限分层是真的：member 调管理员接口是 403，退出之后老 cookie 立刻失效
 *
 * 不进 CI（要联网装 NestJS，几十秒）。用法：
 *   pnpm e2e:auth
 *   pnpm e2e:auth --keep
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../packages/server/src/index.js'

const TOKEN = 'e2e-auth-token'
const keep = process.argv.includes('--keep')

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

const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-auth-'))
console.log(`TENON_HOME = ${home}\n`)

const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '1' },
  preview: {
    // 首次要装 NestJS 全家桶
    readyTimeoutMs: 10 * 60 * 1000,
    apiReadyTimeoutMs: 5 * 60 * 1000,
    log: (line) => console.log(`  [preview] ${line}`),
  },
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

async function call(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.cookie !== undefined) headers['cookie'] = init.cookie
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

/** 从 Set-Cookie 里取出 `name=value`（只取第一条：这个应用只写一个 cookie） */
function cookieOf(response: Response): string {
  const first = response.headers.getSetCookie()[0]
  if (first === undefined) throw new Error('响应里没有 Set-Cookie')
  return first.split(';')[0] ?? ''
}

interface AddAuthResult {
  applied: boolean
  addedBackend: boolean
  files: string[]
  wired: boolean
  notes: string[]
  deps: { installed: boolean; durationMs: number } | null
}

try {
  console.log('1) 建一个纯前端应用（react-vite，有 type: module）')
  const created = await rpc<{ app: { id: string } }>('app.create', { name: '花名册 E2E' })
  const appId = created.app.id
  const repo = join(home, 'apps', appId, 'repo')

  console.log('\n2) 加登录（会顺手补后端并装依赖，可能几十秒）')
  const started = Date.now()
  const added = await rpc<AddAuthResult>('app.addAuth', { id: appId, installDeps: true })
  console.log(`  耗时 ${Date.now() - started}ms，${added.files.length} 个新文件`)
  check('applied', added.applied)
  check('顺手补了后端（纯前端应用没有后端就拦不住）', added.addedBackend)
  check('main.tsx 自动接上了 <AuthGate>', added.wired)
  check('依赖装上了', added.deps?.installed === true, JSON.stringify(added.deps))
  for (const note of added.notes) console.log(`  注意：${note}`)

  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
    tenon?: { api?: string; auth?: boolean }
  }
  check('tenon.api 已经写上（网关靠它起后端）', pkg.tenon?.api === 'api/main.ts')
  check('tenon.auth 已经写上（幂等判据）', pkg.tenon?.auth === true)

  console.log('\n3) 起预览：/api/health 必须仍然公开')
  await rpc('preview.start', { appId })
  const ready = await server.preview.waitReady(appId, 10 * 60 * 1000)
  if (ready.state !== 'ready') throw new Error(`预览没就绪：${ready.error ?? '未知原因'}`)
  check(
    'readiness 四格全 ready（server=ready 说明 /api/health 没被守卫拦）',
    JSON.stringify(ready.readiness) ===
      JSON.stringify({ deps: 'ready', db: 'ready', server: 'ready', preview: 'ready' }),
    JSON.stringify(ready.readiness),
  )
  const url = ready.url as string

  console.log('\n4) 未登录：状态可读，数据接口 401')
  const status0 = await call(url, '/api/auth/status')
  const status0Body = (await status0.json()) as { needsSetup?: boolean; user?: unknown }
  check('/api/auth/status 是 200（未登录不是错误）', status0.status === 200, `status=${status0.status}`)
  check('needsSetup: true（库里零账号）', status0Body.needsSetup === true, JSON.stringify(status0Body))
  check('user 是 null', status0Body.user === null, JSON.stringify(status0Body.user))

  const me0 = await call(url, '/api/auth/me')
  check('GET /api/auth/me 未登录是 401', me0.status === 401, `status=${me0.status}`)

  console.log('\n5) 初始化：弱口令被拒，合法口令拿到 httpOnly cookie')
  const weak = await call(url, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'boss@example.com', password: '123' },
  })
  check('密码太短是 400', weak.status === 400, `status=${weak.status}`)

  const setup = await call(url, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'Boss@Example.com', password: 'correct-horse-9' },
  })
  check('setup 成功', setup.status === 201 || setup.status === 200, `status=${setup.status}`)
  const admin = cookieOf(setup)
  check('cookie 名带应用 slug（同机多应用不会互相覆盖）', admin.startsWith('tenon_auth_'), admin)
  const setCookie = setup.headers.getSetCookie()[0] ?? ''
  check('HttpOnly', /HttpOnly/i.test(setCookie), setCookie)
  check('SameSite=Lax（挡 CSRF 靠这条）', /SameSite=Lax/i.test(setCookie), setCookie)

  const status1 = await call(url, '/api/auth/status', { cookie: admin })
  const status1Body = (await status1.json()) as { needsSetup?: boolean; user?: { email?: string } | null }
  check('needsSetup 变 false', status1Body.needsSetup === false, JSON.stringify(status1Body))
  check('邮箱被规范成小写', status1Body.user?.email === 'boss@example.com', String(status1Body.user?.email))

  const me1 = await call(url, '/api/auth/me', { cookie: admin })
  check('带 cookie 的 /api/auth/me 是 200', me1.status === 200, `status=${me1.status}`)

  console.log('\n6) 初始化口子自己关掉了')
  const setupAgain = await call(url, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'sneaky@example.com', password: 'another-pass-9' },
  })
  check('再次 setup 是 409（不能凭空多一个管理员）', setupAgain.status === 409, `status=${setupAgain.status}`)

  console.log('\n7) 登录：错密码 403，对密码换一个新会话')
  const wrong = await call(url, '/api/auth/login', {
    method: 'POST',
    body: { email: 'boss@example.com', password: 'nope-nope-nope' },
  })
  check('错密码是 403（不是 200、也不是 500）', wrong.status === 403, `status=${wrong.status}`)

  const login = await call(url, '/api/auth/login', {
    method: 'POST',
    body: { email: 'boss@example.com', password: 'correct-horse-9' },
  })
  check('登录成功', login.status === 200, `status=${login.status}`)
  const session = cookieOf(login)
  check('每次登录是一个新令牌', session !== admin, session)

  console.log('\n8) 权限分层：admin 能加人，member 不能看成员列表')
  const addedUser = await call(url, '/api/auth/users', {
    method: 'POST',
    cookie: session,
    body: { email: 'mate@example.com', password: 'mate-password-9', role: 'member' },
  })
  check('管理员加人 201', addedUser.status === 201, `status=${addedUser.status}`)

  const memberLogin = await call(url, '/api/auth/login', {
    method: 'POST',
    body: { email: 'mate@example.com', password: 'mate-password-9' },
  })
  check('新成员能登录', memberLogin.status === 200, `status=${memberLogin.status}`)
  const member = cookieOf(memberLogin)

  const forbidden = await call(url, '/api/auth/users', { cookie: member })
  check('member 看成员列表是 403', forbidden.status === 403, `status=${forbidden.status}`)

  console.log('\n9) 退出登录：服务端那条会话立刻失效')
  const logout = await call(url, '/api/auth/logout', { method: 'POST', cookie: member })
  check('logout 204', logout.status === 204, `status=${logout.status}`)

  const afterLogout = await call(url, '/api/auth/me', { cookie: member })
  check('拿老 cookie 再请求是 401（不是"前端删了 token"那种假退出）', afterLogout.status === 401, `status=${afterLogout.status}`)

  console.log('\n10) 页面本身照常打开（登录页由前端渲染，不是后端吐 HTML）')
  const html = await (await fetch(url)).text()
  check('HTML 里有挂载点', html.includes('<div id="root">'))
  const main = await readFile(join(repo, 'src', 'main.tsx'), 'utf8')
  check('main.tsx 里确实有 <AuthGate>', main.includes('<AuthGate>'))
} catch (error) {
  failures += 1
  console.log(`\n✗ 异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.close().catch(() => undefined)
  if (keep) console.log(`\n工作区保留在：${home}`)
  else await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => undefined)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
