/**
 * 「给已有应用加登录」的测试。
 *
 * 这条能力的价值不在"文件写出来了"（那是 `writeFile` 的事），而在**四处就地改**：
 * 任何一处漏掉都不会在编译期报错，只是功能静默不生效，或者更糟 —— 看起来启用了，
 * 其实所有接口都公开。所以每条断言都对着一个"已经踩过或必然会踩"的后果：
 *
 * 1. `tenon.auth` 是幂等判据（加两次不该出现两份定义）
 * 2. `api/db.ts` 的 entities 要含两张账号表（漏了迁移不建表 → 登录报 relation does not exist）
 * 3. `api/app.module.ts` 要挂 AuthModule（漏了守卫不生效 → 所有接口公开）
 * 4. `src/main.tsx` 要包上 AuthGate（漏了接口全 401，而页面上没有登录框）
 * 5. `docs/AGENTS.md` 的两节标记**不能互相覆盖**（后写的会把先写的整段抹掉）
 * 6. cookie 名按应用区分（浏览器不按端口隔离 cookie，同名会互相踢下线）
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyApiFeature, applyAuthFeature, scaffoldApp } from '../src/index.js'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-auth-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function readPkg(dir = repo): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
}

async function read(rel: string, dir = repo): Promise<string> {
  return readFile(join(dir, rel), 'utf8')
}

/** 铺一份纯前端应用，模拟"用户已经有一个能跑的前端" */
async function frontendOnly(slug = 'bills'): Promise<void> {
  await scaffoldApp({ repoDir: repo, appId: 'app_x', appName: '账单', appSlug: slug })
}

describe('功能包：auth-feature', () => {
  it('纯前端应用：先补后端，再写登录，并把四处就地改全做完', async () => {
    await frontendOnly()
    const result = await applyAuthFeature({ repoDir: repo })

    expect(result.applied).toBe(true)
    // 鉴权必须有后端：这一步不是"顺手"，是前置条件
    expect(result.addedBackend).toBe(true)
    expect(result.wired).toBe(true)
    // 后端功能包会对 ESM 应用留一条 mark-cjs 说明（预期内）；"要人手动补"的才算问题
    expect(result.notes.filter((note) => note.includes('请手动'))).toEqual([])

    for (const file of [
      'api/auth/auth.module.ts',
      'api/auth/auth.guard.ts',
      'api/auth/password.ts',
      'api/migrations/1770000000000-CreateAuth.ts',
      'shared/auth-schema.ts',
      'src/auth/AuthGate.tsx',
      'src/auth/LoginPage.tsx',
    ]) {
      expect(result.files).toContain(file)
    }

    const pkg = await readPkg()
    const tenon = pkg['tenon'] as Record<string, unknown>
    expect(tenon['auth']).toBe(true)
    expect(tenon['api']).toBe('api/main.ts')

    // ★ 漏了这两处：一个不建表，一个守卫不生效 —— 都不报错
    const db = await read('api/db.ts')
    expect(db).toContain("from './auth/auth-user.entity'")
    expect(db).toContain('export const entities = [AuthUser, AuthSession] as const')

    const module = await read('api/app.module.ts')
    expect(module).toContain("from './auth/auth.module'")
    expect(module).toMatch(/imports:\s*\[\s*AuthModule,/)

    const main = await read('src/main.tsx')
    expect(main).toContain("import { AuthGate } from './auth/AuthGate'")
    expect(main).toMatch(/<AuthGate>[\s\S]*<App[\s\S]*<\/AuthGate>/)

    /*
     * ★ 就绪探针必须绕过守卫。漏了它的表现是**预览永远起不来**（网关打 /api/health
     * 拿到 401，300 秒后超时），日志里只有一串 401 —— 实测踩过，所以钉在这里。
     * 这条没有走 `@Public()`：平台契约不该由应用内的注解来保证。
     */
    const guard = await read('api/auth/auth.guard.ts')
    expect(guard).toContain("path === '/api/health'")

    // 幂等标记之外，两个功能包各占一对 AGENTS 标记，谁都不能把谁抹掉
    const agents = await read('docs/AGENTS.md')
    expect(agents).toContain('tenon:backend:begin')
    expect(agents).toContain('tenon:auth:begin')
    expect(agents).toContain('后端（NestJS + PostgreSQL）')
    expect(agents).toContain('登录与用户体系')
  })

  it('加第二次什么都不做（不会出现两份守卫定义）', async () => {
    await frontendOnly()
    await applyAuthFeature({ repoDir: repo })
    const again = await applyAuthFeature({ repoDir: repo })

    expect(again.applied).toBe(false)
    expect(again.reason).toBe('already')
    expect(again.files).toEqual([])

    const module = await read('api/app.module.ts')
    expect(module.match(/AuthModule/g)?.length).toBe(2) // import + imports 里的一次
    const db = await read('api/db.ts')
    expect(db).toContain('export const entities = [AuthUser, AuthSession] as const')
  })

  it('已经有后端的应用：不重复加后端，只写登录', async () => {
    await frontendOnly()
    await applyApiFeature({ repoDir: repo })
    const result = await applyAuthFeature({ repoDir: repo })
    expect(result.addedBackend).toBe(false)
    expect(result.applied).toBe(true)
  })

  it('用户重写过 main.tsx：不硬改，留下一条明确的待办', async () => {
    await frontendOnly()
    await applyAuthFeature({ repoDir: repo })
    // 模拟"加完登录之后，用户自己重写了入口"
    await writeFile(
      join(repo, 'src', 'main.tsx'),
      `import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (container === null) throw new Error('没有 #root')
createRoot(container).render(<App appName="账单" />)
`,
      'utf8',
    )

    // 把标记清掉，模拟"从没加过登录"（否则幂等会直接返回）
    const pkg = await readPkg()
    pkg['tenon'] = { ...(pkg['tenon'] as Record<string, unknown>) }
    delete (pkg['tenon'] as Record<string, unknown>)['auth']
    await writeFile(join(repo, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

    const result = await applyAuthFeature({ repoDir: repo })
    expect(result.wired).toBe(false)
    expect(result.notes.join('\n')).toContain('AuthGate')
    // 文件仍然是写好的：接线失败不该让整个动作失败，Agent 改一行就能补上
    expect(result.files).toContain('src/auth/AuthGate.tsx')
  })

  it('cookie 名按应用区分（同机两个应用不会互相踢下线）', async () => {
    const other = await mkdtemp(join(tmpdir(), 'tenon-auth-b-'))
    try {
      await frontendOnly('bills')
      await scaffoldApp({ repoDir: other, appId: 'app_y', appName: '名单', appSlug: 'roster' })
      await applyAuthFeature({ repoDir: repo })
      await applyAuthFeature({ repoDir: other })

      const a = await read('api/auth/cookie-name.ts')
      const b = await read('api/auth/cookie-name.ts', other)
      expect(a).toContain("'tenon_auth_bills'")
      expect(b).toContain("'tenon_auth_roster'")
      expect(a).not.toBe(b)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
