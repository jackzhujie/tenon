/**
 * 「给已有应用加后端」的测试。
 *
 * 这条能力的价值全在**不破坏已有代码**上，所以测试重点不是"文件写出来了"：
 * 1. 幂等 —— 已经有 `tenon.api` 就什么都不做（加两次不该产生两份定义）
 * 2. package.json 只补缺 —— 用户改过的 `build` 一个字符都不能动
 * 3. `tsconfig.json` 的 `include` 真的加上 `shared`（漏了前端 tsc 会报"不在项目里"）
 * 4. 依赖版本与 `nest-api` 模板不漂移（两处各写一份版本号，必须有测试钉住）
 * 5. `"type": "module"` 的应用要拿到 `scripts/mark-cjs.mjs`（否则后端启动即
 *    `require is not defined`）
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyApiFeature, listTemplates, scaffoldApp, templatesRoot } from '../src/index.js'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-feature-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

async function readPkg(dir = repo): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
}

/** 铺一份 react-vite，模拟"用户已经有一个能跑的前端应用" */
async function frontendOnly(): Promise<void> {
  await scaffoldApp({ repoDir: repo, appId: 'app_x', appName: '账单', appSlug: 'bills' })
}

describe('功能包：api-feature', () => {
  it('不出现在建应用的模板列表里（它是功能包，不是一个能打开的应用）', async () => {
    const ids = (await listTemplates()).map((t) => t.id)
    expect(ids).not.toContain('api-feature')
  })

  it('给纯前端应用加后端：写文件 + 写 tenon.api + 补脚本', async () => {
    await frontendOnly()
    const result = await applyApiFeature({ repoDir: repo })

    expect(result.applied).toBe(true)
    expect(result.files).toContain('api/main.ts')
    expect(result.files).toContain('api/db.ts')
    expect(result.files).toContain('shared/schema.ts')
    expect(result.files).toContain('tsconfig.server.json')
    expect(result.addedScripts).toContain('build:api')

    const pkg = await readPkg()
    const tenon = pkg['tenon'] as Record<string, string>
    // ★ 这个字段是"要不要起后端"的唯一事实来源，写漏了后端永远不起
    expect(tenon.api).toBe('api/main.ts')
    expect(tenon.apiOut).toBe('dist-server/api/main.js')
    expect(tenon.apiTsconfig).toBe('tsconfig.server.json')
    expect(Object.keys(pkg['dependencies'] as object)).toContain('@nestjs/core')

    // 功能包的元文件不能漏进应用
    expect(result.files).not.toContain('template.json')
    expect(result.files).not.toContain('package.fragment.json')
    expect(result.files).not.toContain('AGENTS.section.md')
  })

  it('幂等：已经有后端就什么都不做', async () => {
    await frontendOnly()
    await applyApiFeature({ repoDir: repo })
    const before = await readFile(join(repo, 'package.json'), 'utf8')

    const second = await applyApiFeature({ repoDir: repo })
    expect(second.applied).toBe(false)
    expect(second.reason).toBe('already')
    // 连字节都不该变：否则每次点一下都会产生一个空 commit
    expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe(before)
  })

  it('不覆盖用户改过的脚本：build 一个字符都不动，只补缺的', async () => {
    await frontendOnly()
    const pkg = await readPkg()
    const scripts = pkg['scripts'] as Record<string, string>
    // 用户自己定制过 build（模板默认是 "tsc --noEmit && vite build"）
    scripts['build'] = 'vite build --mode staging && echo custom'
    await writeFile(join(repo, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')

    const result = await applyApiFeature({ repoDir: repo })
    const after = (await readPkg())['scripts'] as Record<string, string>

    expect(after['build']).toBe('vite build --mode staging && echo custom')
    expect(result.addedScripts).not.toContain('build')
    expect(after['build:api']).toBeDefined()
  })

  it('tsconfig.json 的 include 加上 shared（漏了前端 tsc 会报"不在项目里"）', async () => {
    await frontendOnly()
    await applyApiFeature({ repoDir: repo })
    const tsconfig = JSON.parse(await readFile(join(repo, 'tsconfig.json'), 'utf8')) as {
      include: string[]
    }
    expect(tsconfig.include).toContain('shared')
    expect(tsconfig.include).toContain('src')
  })

  it('eslint 忽略 dist-server（否则 lint 去扫编译产物，几百条"错误"）', async () => {
    await frontendOnly()
    await applyApiFeature({ repoDir: repo })
    const config = await readFile(join(repo, 'eslint.config.mjs'), 'utf8')
    expect(config).toContain('dist-server/**')
  })

  it('docs/AGENTS.md 写明有后端（否则 Agent 下次又用 localStorage 存数据）', async () => {
    await frontendOnly()
    await applyApiFeature({ repoDir: repo })
    const doc = await readFile(join(repo, 'docs', 'AGENTS.md'), 'utf8')
    expect(doc).toContain('tenon:backend:begin')
    expect(doc).toContain('DATABASE_URL')
    expect(doc).toContain('api/migrations')
  })

  it('ESM 应用（react-vite 就有 type:module）要拿到 mark-cjs，否则后端启动即 require is not defined', async () => {
    await frontendOnly()
    const result = await applyApiFeature({ repoDir: repo })
    expect(result.files).toContain('scripts/mark-cjs.mjs')
    expect(result.notes.join('\n')).toContain('type')
    const pkg = await readPkg()
    expect(pkg['type']).toBe('module')
    // 脚本顺序不能反：必须先 tsc 产出，再写产物目录的 package.json
    expect((pkg['scripts'] as Record<string, string>)['build:api']).toMatch(/tsc.*&&.*mark-cjs/)
  })

  it('非 ESM 应用也照常能加（不带 type 字段的应用不该被强行加一个）', async () => {
    await mkdir(repo, { recursive: true })
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'plain', scripts: { build: 'vite build' }, dependencies: { vite: '7.3.7' } }, null, 2),
      'utf8',
    )
    await writeFile(join(repo, 'tsconfig.json'), JSON.stringify({ include: ['src'] }), 'utf8')
    const result = await applyApiFeature({ repoDir: repo })
    expect(result.applied).toBe(true)
    expect((await readPkg())['type']).toBeUndefined()
    // 没有 eslint 配置 / README 也不该报错，只是少改一处
    expect(result.notes.join('\n')).not.toContain('mark-cjs')
  })

  it('没有 package.json 就说清楚（而不是写出一堆孤儿文件）', async () => {
    await expect(applyApiFeature({ repoDir: repo })).rejects.toThrow(/没有 package.json/)
  })

  it('依赖版本与 nest-api 模板不漂移（两处各写一份，必须有测试钉住）', async () => {
    const nest = JSON.parse(
      await readFile(join(templatesRoot(), 'nest-api', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    const fragment = JSON.parse(
      await readFile(join(templatesRoot(), 'api-feature', 'package.fragment.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }

    for (const [name, version] of Object.entries(fragment.dependencies)) {
      // react / react-dom 之类前端依赖不在片段里，只管后端那几个
      if (nest.dependencies[name] === undefined) continue
      expect(nest.dependencies[name], `${name} 版本与 nest-api 模板不一致`).toBe(version)
    }
    for (const [name, version] of Object.entries(fragment.devDependencies)) {
      expect(nest.devDependencies[name], `${name} 版本与 nest-api 模板不一致`).toBe(version)
    }
  })
})
