/**
 * 评审工具（M4 第 5 步）：`git_diff` + `typecheck`。
 *
 * 这些用例全部打真东西 —— 真 git 仓库、真 `tsc`（用本仓库装的那份 typescript 去编一个临时项目）。
 * 理由：这两个工具的价值全在"结论可信"。桩掉 tsc 之后，`ok` 是怎么算出来的就没人验了，
 * 而这里最贵的 bug 恰恰是**把没跑成报成通过**（评审里的假绿）。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitops } from '@tenon/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReviewTools, REVIEW_TOOL_NAMES, reviewExtension } from '../src/tools/review.js'

/** 用本仓库自己装的那份 typescript：不联网、不假定用户在临时目录里装过依赖 */
const TSC_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/typescript/bin/tsc')

interface ToolResult {
  text: string
  isError: boolean
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-review-'))
  await mkdir(join(dir, 'src'), { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function run(tool: string, args: Record<string, unknown> = {}, options: { tscEntry?: string } = {}): Promise<ToolResult> {
  const found = createReviewTools({ repoDir: dir, tscEntry: options.tscEntry }).find((item) => item.name === tool)
  if (found === undefined) throw new Error(`没有工具 ${tool}`)
  const result = (await found.execute(args as never, {} as never, {} as never)) as {
    output: { type: string; text?: string }[]
    isError?: boolean
  }
  return {
    text: result.output.map((part) => part.text ?? '').join(''),
    isError: result.isError === true,
  }
}

describe('git_diff（默认看工作区，不看提交）', () => {
  it('报出这一轮改的行，带文件数和 +/− 统计', async () => {
    await gitops.initRepo(dir)
    await writeFile(join(dir, 'src', 'App.tsx'), "export const title = 'old'\n")
    await writeFile(join(dir, 'README.md'), '# app\n')
    await gitops.commitAll(dir, 'init')

    // 这就是 Reviewer 动手那一刻的状态：代码改了，还没提交
    await writeFile(join(dir, 'src', 'App.tsx'), "export const title = 'new'\nexport const extra = 1\n")

    const { text, isError } = await run('git_diff')
    expect(isError).toBe(false)
    expect(text).toContain('1 个文件')
    expect(text).toContain('src/App.tsx  (modified')
    expect(text).toContain("-export const title = 'old'")
    expect(text).toContain("+export const title = 'new'")
    expect(text).toContain('+export const extra = 1')
    // 没动过的文件不该混进来（评审只看改动面）
    expect(text).not.toContain('README.md')
  })

  it('工作区干净时说实话，并指路去看上一版提交', async () => {
    await gitops.initRepo(dir)
    await writeFile(join(dir, 'src', 'App.tsx'), 'export const a = 1\n')
    await gitops.commitAll(dir, 'init')

    const clean = await run('git_diff')
    expect(clean.isError).toBe(false)
    expect(clean.text).toContain('工作区是干净的')
    expect(clean.text).toContain('commit:"HEAD"')

    // 按它自己指的路走，就能看到上一版改了什么
    const last = await run('git_diff', { commit: 'HEAD' })
    expect(last.text).toContain('src/App.tsx')
    expect(last.text).toContain('+export const a = 1')
  })

  it('可以只看某个文件/目录（大改动时用它聚焦）', async () => {
    await gitops.initRepo(dir)
    await writeFile(join(dir, 'src', 'App.tsx'), 'export const a = 1\n')
    await gitops.commitAll(dir, 'init')
    await writeFile(join(dir, 'src', 'App.tsx'), 'export const a = 2\n')
    await writeFile(join(dir, 'api.ts'), 'export const b = 1\n')

    const onlySrc = await run('git_diff', { path: 'src' })
    expect(onlySrc.text).toContain('src/App.tsx')
    expect(onlySrc.text).not.toContain('api.ts')

    expect((await run('git_diff', { path: 'nowhere/' })).text).toContain('没有涉及 nowhere/ 的文件')
  })

  it('不是 git 仓库时明确报错，而不是返回"没有改动"', async () => {
    const { text, isError } = await run('git_diff')
    expect(isError).toBe(true)
    expect(text).toContain('读不了这个仓库的改动')
  })
})

describe('typecheck（跑应用自己的 tsc）', () => {
  const writeProject = async (source: string): Promise<void> => {
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ['src'],
        },
        null,
        2,
      ),
    )
    await writeFile(join(dir, 'src', 'a.ts'), source)
  }

  it('真跑一遍 tsc：没问题就报通过', async () => {
    await writeProject('export const n: number = 1\n')
    const { text, isError } = await run('typecheck', {}, { tscEntry: TSC_ENTRY })
    expect(isError).toBe(false)
    expect(text).toContain('✓ 类型检查通过')
    expect(text).toContain('tsconfig.json')
  }, 30_000)

  it('★ 类型错误是"信息"不是工具错误：带文件行列与 TS 码，且 isError 为 false', async () => {
    await writeProject("export const n: number = 'text'\n")
    const { text, isError } = await run('typecheck', {}, { tscEntry: TSC_ENTRY })
    // 标成 isError 会让模型去重试工具，而它该做的是把这一条写进风险清单
    expect(isError).toBe(false)
    expect(text).toContain('✗ 类型检查失败')
    expect(text).toContain('src/a.ts:1:')
    expect(text).toContain('TS2322')
  }, 30_000)

  it('★ 没有 tsconfig 时说"无从跑起"，绝不出现 ✓', async () => {
    await writeFile(join(dir, 'src', 'a.ts'), 'export const n = 1\n')
    const { text } = await run('typecheck', {}, { tscEntry: TSC_ENTRY })
    expect(text).toContain('没有 tsconfig.json')
    expect(text).toContain('这不等于通过')
    expect(text).not.toContain('✓')
  })

  it('★ 依赖没装（找不到 typescript）时说"没跑成"，绝不出现 ✓', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{"include":["src"]}')
    const { text } = await run('typecheck')
    expect(text).toContain('没跑成')
    expect(text).toContain('typescript')
    expect(text).not.toContain('✓')
  })

  it('从应用自己的 node_modules 里找 tsc（真实应用的路径，不靠外部注入）', async () => {
    await writeProject('export const n: number = 1\n')
    // 把本仓库装的那份 typescript 链进去，模拟"应用的依赖装好了"
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await symlink(resolve(dirname(TSC_ENTRY), '..'), join(dir, 'node_modules', 'typescript'), 'dir')

    const { text, isError } = await run('typecheck')
    expect(isError).toBe(false)
    expect(text).toContain('✓ 类型检查通过')
  }, 30_000)

  it('多个 tsconfig 一起跑（Nest 模板有 tsconfig.server.json）', async () => {
    await writeProject('export const n: number = 1\n')
    await writeFile(join(dir, 'tsconfig.server.json'), JSON.stringify({ extends: './tsconfig.json' }))
    const { text } = await run('typecheck', {}, { tscEntry: TSC_ENTRY })
    expect(text).toContain('tsconfig.json，')
    expect(text).toContain('tsconfig.server.json')
    expect(text.split('\n').filter((line) => line.startsWith('✓'))).toHaveLength(2)
  }, 40_000)
})

describe('扩展装配', () => {
  it('只挂两个工具，不带 section（工作顺序写在角色提示词里）', () => {
    const extension = reviewExtension({ repoDir: dir })
    expect(extension.name).toBe('tenon.review')
    expect((extension.tools ?? []).map((tool) => tool.name).sort()).toEqual([...REVIEW_TOOL_NAMES].sort())
    expect(extension.sections ?? []).toHaveLength(0)
  })
})
