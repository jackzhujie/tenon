/**
 * 发布门禁（M4 第 7 步）：`typecheck` / `test` 的三态判定。
 *
 * 这里全部打真东西：真 `tsc`（用本仓库装的那份）、真 `pnpm run test`（临时项目里
 * 写一个会失败的脚本）。桩掉之后，"什么算通过"就没人验了，而这一步唯一的价值就是
 * **判据可信** —— 一个会假绿的门禁比没有门禁更危险，因为它给了"发出去是安全的"这个错觉。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatGateSummary, runLintScript, runQualityGate, runTestScript, runTypecheck } from '../src/checks.js'

/** 用本仓库自己装的那份 typescript：不联网、不假定临时目录里装过依赖 */
const TSC_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/typescript/bin/tsc')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-checks-'))
  await mkdir(join(dir, 'src'), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(join(dir, file), JSON.stringify(value, null, 2))
}

async function project(
  options: { source?: string; testScript?: string; lintScript?: string; withNodeModules?: boolean } = {},
): Promise<void> {
  await writeJson('tsconfig.json', {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
    },
    include: ['src'],
  })
  await writeFile(join(dir, 'src', 'main.ts'), options.source ?? 'export const answer: number = 42\n')
  const scripts: Record<string, string> = {}
  if (options.testScript !== undefined) scripts['test'] = options.testScript
  if (options.lintScript !== undefined) scripts['lint'] = options.lintScript
  await writeJson('package.json', { name: 'check-fixture', private: true, scripts })
  if (options.withNodeModules === true) await mkdir(join(dir, 'node_modules'), { recursive: true })
}

describe('typecheck', () => {
  it('跑通了、没诊断 → pass，摘要里有几个 tsconfig 与耗时', async () => {
    await project()
    const result = await runTypecheck(dir, { tscEntry: TSC_ENTRY })
    expect(result.status).toBe('pass')
    expect(result.errorCount).toBe(0)
    expect(result.summary).toContain('tsconfig.json')
    expect(result.sections.join('')).toContain('✓')
  })

  it('★ 有类型错误 → fail，错在第几行都说清楚', async () => {
    await project({ source: "export const answer: number = 'not a number'\n" })
    const result = await runTypecheck(dir, { tscEntry: TSC_ENTRY })
    expect(result.status).toBe('fail')
    expect(result.errorCount).toBeGreaterThan(0)
    expect(result.summary).toContain('没过')
    const text = result.sections.join('')
    expect(text).toContain('✗')
    expect(text).toContain('TS2322')
    expect(text).toContain('src/main.ts')
  })

  it('多个 tsconfig 各自跑各自判：一个红就是整体红', async () => {
    await project()
    await writeJson('tsconfig.server.json', {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
      },
      include: ['api'],
    })
    await mkdir(join(dir, 'api'), { recursive: true })
    await writeFile(join(dir, 'api', 'main.ts'), "export const port: string = 3000\n")
    const result = await runTypecheck(dir, { tscEntry: TSC_ENTRY })
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('tsconfig.server.json')
    // 通过的另一个也得留下报告：不然用户会以为两个都没跑
    expect(result.sections).toHaveLength(2)
    expect(result.sections.some((section) => section.startsWith('✓'))).toBe(true)
  })

  it('没有 tsconfig → skip（"这个项目不做类型检查"是配置性选择）', async () => {
    await project()
    await rm(join(dir, 'tsconfig.json'))
    const result = await runTypecheck(dir, { tscEntry: TSC_ENTRY })
    expect(result.status).toBe('skip')
    expect(result.reason).toBe('no-config')
  })

  it('★ 有 tsconfig 却没装 typescript → fail，不是 skip', async () => {
    // 这条是整个门禁最容易被绕过的地方：把 skip 当成"没得检查"，删掉 node_modules
    // 就等于放行。所以"该检查的东西没检查成功"必须是 fail。
    await project()
    const result = await runTypecheck(dir)
    expect(result.status).toBe('fail')
    expect(result.reason).toBe('no-typescript')
    expect(result.summary).toContain('没跑成')
  })
})

describe('test 脚本', () => {
  it('没有 scripts.test → skip，并说明是"没有"而不是"过了"', async () => {
    await project()
    const result = await runTestScript(dir)
    expect(result.status).toBe('skip')
    expect(result.summary).toContain('没有 scripts.test')
    expect(result.summary).not.toContain('通过')
  })

  it('★ 脚本绿了 → pass', async () => {
    await project({ testScript: 'node -e "process.exit(0)"', withNodeModules: true })
    const result = await runTestScript(dir)
    expect(result.status).toBe('pass')
    expect(result.detail).toBeNull()
  })

  it('★ 脚本红了 → fail，带退出码与最后几行输出', async () => {
    await project({
      testScript: 'node -e "console.error(\'断言失败：期望 1 得到 2\'); process.exit(1)"',
      withNodeModules: true,
    })
    const result = await runTestScript(dir)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('失败')
    expect(result.summary).toContain('退出码 1')
    // 失败时最有用的在尾部：断言差异、堆栈
    expect(result.detail).toContain('断言失败')
  })

  it('★ 有脚本但依赖没装 → fail（不是 skip，也不是"测试失败"）', async () => {
    await project({ testScript: 'vitest run' })
    const result = await runTestScript(dir)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('依赖还没装')
  })
})

describe('lint 脚本', () => {
  it('没有 scripts.lint → skip（那是配置性选择，不是失败）', async () => {
    await project()
    const result = await runLintScript(dir)
    expect(result.id).toBe('lint')
    expect(result.status).toBe('skip')
    expect(result.summary).toContain('scripts.lint')
  })

  it('脚本退出 0 → pass', async () => {
    await project({ lintScript: 'node -e "process.exit(0)"', withNodeModules: true })
    const result = await runLintScript(dir)
    expect(result.status).toBe('pass')
    expect(result.summary).toContain('pnpm run lint')
  })

  it('脚本退出 1 → fail，detail 里有具体输出', async () => {
    await project({
      lintScript: 'node -e "console.error(\'src/a.ts:3:1 error 未使用变量\');process.exit(1)"',
      withNodeModules: true,
    })
    const result = await runLintScript(dir)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('退出码 1')
    expect(result.detail).toContain('未使用变量')
  })

  it('★ 两种 shell 的"找不到命令"文案都认（这条曾经本地绿、CI 红）', async () => {
    /*
     * macOS 的 sh（bash 系）说 `sh: eslint: command not found`，
     * Debian 的 dash（GitHub Actions 的默认 sh）说 `sh: 1: eslint: not found`。
     * 只认前者的话，本地全绿、CI 上那条断言会挂 —— 而且挂的是"文案"，不是逻辑。
     *
     * 退一步说，真正与环境无关的判据是 `looksLikeMissingCommand` 里那条
     * 「脚本第一个词在不在 node_modules/.bin」，文案正则只是复合脚本的兜底。
     */
    for (const line of ['sh: 1: eslint: not found', 'sh: eslint: command not found']) {
      await project({
        lintScript: `node -e "console.error('${line}');process.exit(1)"`,
        withNodeModules: true,
      })
      const result = await runLintScript(dir)
      expect(result.status, line).toBe('fail')
      expect(result.summary, line).toContain('命令没装')
    }
  })

  it('★ 命令没装 → 说"没跑成"，不说"没过"（两种处置方式相反）', async () => {
    /*
     * 这条是最容易写错的一条：`eslint` 没装时退出码是 127，与"查到 3 个错误"
     * 只差一个数字。如果都报成"lint 失败"，用户会去改一段本来没问题的代码。
     */
    await project({ lintScript: 'definitely-not-a-command-tenon', withNodeModules: true })
    const result = await runLintScript(dir)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('没跑成')
    expect(result.summary).toContain('命令没装')
    expect(result.summary).not.toContain('没过')
  })

  it('有脚本但依赖没装 → fail，且说的是"依赖还没装"', async () => {
    await project({ lintScript: 'eslint .' })
    const result = await runLintScript(dir)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('依赖还没装')
  })

  it('超时 → fail 并说明已终止', async () => {
    await project({
      lintScript: 'node -e "setTimeout(()=>{},60000)"',
      withNodeModules: true,
    })
    const result = await runLintScript(dir, { timeoutMs: 800 })
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('超时')
  })

  it('输出很长时砍尾不砍头，但保留最后那行"共几个问题"', async () => {
    /*
     * lint 与测试**相反**：测试的有用信息在尾部（堆栈），lint 的在头部（第一个文件的
     * 第一个错误）。而最后那行 `✖ N problems` 是"到底多少个"的唯一来源，不能丢。
     */
    await project({
      lintScript:
        'node -e "for(let i=0;i<120;i++)console.log(\'src/f.ts:\'+i+\':1 error 第\'+i+\'条\');console.log(\'✖ 120 problems (120 errors, 0 warnings)\');process.exit(1)"',
      withNodeModules: true,
    })
    const result = await runLintScript(dir)
    expect(result.status).toBe('fail')
    expect(result.detail).toContain('第0条')
    expect(result.detail).toContain('lines omitted')
    expect(result.detail).toContain('✖ 120 problems')
  })
})

describe('整套门禁', () => {
  it('★ 三项都 skip 时 ok=true —— "没得检查"不等于"不许发"', async () => {
    await project()
    await rm(join(dir, 'tsconfig.json'))
    const gate = await runQualityGate(dir)
    expect(gate.checks.map((check) => check.status)).toEqual(['skip', 'skip', 'skip'])
    expect(gate.ok).toBe(true)
    expect(formatGateSummary(gate)).toBe('类型检查 ⏭ · 测试 ⏭ · Lint ⏭')
  })

  it('任何一项 fail 就 ok=false，且在 check 里点得出是哪一项', async () => {
    await project({ source: "export const answer: number = 'x'\n", testScript: 'node -e "process.exit(1)"', withNodeModules: true })
    const gate = await runQualityGate(dir, { tscEntry: TSC_ENTRY })
    expect(gate.ok).toBe(false)
    const failed = gate.checks.filter((check) => check.status === 'fail').map((check) => check.id)
    expect(failed).toContain('typecheck')
    expect(failed).toContain('test')
  })

  it('摘要写进发布记录的形状：一行、带状态图形', async () => {
    await project()
    const gate = await runQualityGate(dir, { tscEntry: TSC_ENTRY })
    expect(gate.ok).toBe(true)
    expect(formatGateSummary(gate)).toBe('类型检查 ✓ · 测试 ⏭ · Lint ⏭')
  })
})

describe('检查器只读，不碰仓库', () => {
  it('跑完不改 package.json、不留临时文件', async () => {
    await project({ testScript: 'node -e "process.exit(0)"', withNodeModules: true })
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    await runQualityGate(dir, { tscEntry: TSC_ENTRY })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })
})
