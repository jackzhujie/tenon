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
import { formatGateSummary, runQualityGate, runTestScript, runTypecheck } from '../src/checks.js'

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

async function project(options: { source?: string; testScript?: string; withNodeModules?: boolean } = {}): Promise<void> {
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
  await writeJson('package.json', {
    name: 'check-fixture',
    private: true,
    scripts: options.testScript === undefined ? {} : { test: options.testScript },
  })
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

describe('整套门禁', () => {
  it('★ 两项都 skip 时 ok=true —— "没得检查"不等于"不许发"', async () => {
    await project()
    await rm(join(dir, 'tsconfig.json'))
    const gate = await runQualityGate(dir)
    expect(gate.checks.map((check) => check.status)).toEqual(['skip', 'skip'])
    expect(gate.ok).toBe(true)
    expect(formatGateSummary(gate)).toBe('类型检查 ⏭ · 测试 ⏭')
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
    expect(formatGateSummary(gate)).toBe('类型检查 ✓ · 测试 ⏭')
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
