/**
 * 生成器的测试重点不是"文件写出来了"，而是**写出来的东西自洽**：
 * 变量全替换了、package.json 名字合法、模板全集都能渲染、重铺会拒绝。
 *
 * 这几条里最容易静默坏掉的是第一条：模板新增一个 `{{xxx}}` 而调用方没给值，
 * 用户看到的是界面上出现字面的 `{{xxx}}` —— 不报错，只是丢人。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectFiles,
  listTemplates,
  placeholdersOf,
  renderTemplate,
  scaffoldApp,
  templatesRoot,
} from '../src/index.js'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tenon-gen-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const VARS = { appId: 'app_test', appName: '待办清单', appSlug: 'todo-list' }

describe('模板仓库', () => {
  it('至少有一个能跑的前端模板，且清单字段齐全', async () => {
    const templates = await listTemplates()
    const ids = templates.map((t) => t.id).sort()
    expect(ids).toContain('react-vite')
    expect(ids).toContain('blank')

    const react = templates.find((t) => t.id === 'react-vite')
    expect(react?.entry).toBe('index.html')
    expect(react?.files).toContain('src/App.tsx')
    expect(react?.files).toContain('vite.config.ts')
    expect(react?.label.length).toBeGreaterThan(0)
  })

  it('每个模板声明需要的变量，都能被变量集满足（防止新加 {{x}} 无人给值）', async () => {
    for (const template of await listTemplates()) {
      for (const file of template.files) {
        const source = await readFile(join(templatesRoot(), template.id, file), 'utf8')
        for (const name of placeholdersOf(source)) {
          expect(template.variables, `${template.id}/${file} 用了 ${name}`).toContain(name)
        }
      }
    }
  })

  it('blank 模板不铺任何文件（只建目录与 Git）', async () => {
    expect(await collectFiles('blank')).toEqual([])
  })

  it('未知模板报 TEMPLATE_UNKNOWN', async () => {
    await expect(collectFiles('nope')).rejects.toMatchObject({ code: 'TEMPLATE_UNKNOWN' })
  })
})

describe('渲染', () => {
  it('占位符全部替换，残留会被抓出来', () => {
    expect(renderTemplate('<h1>{{appName}}</h1>', VARS)).toBe('<h1>待办清单</h1>')
    expect(() => renderTemplate('<h1>{{unknownVar}}</h1>', VARS)).toThrowError(/unknownVar/)
  })

  it('CSS 的 {{ 不会误伤（占位符只认标识符形状）', () => {
    const css = '.a { color: red } @media {{ }'
    expect(renderTemplate(css, VARS)).toBe(css)
  })
})

describe('铺模板', () => {
  it('把 react-vite 铺进空目录：文件齐全、变量已替换、package.json 名字是 slug', async () => {
    const result = await scaffoldApp({ ...VARS, repoDir: repo, templateId: 'react-vite' })

    expect(result.files).toContain('index.html')
    expect(result.entry).toBe('index.html')

    const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
    }
    expect(pkg.name).toBe('todo-list')
    expect(pkg.dependencies['react']).toBeDefined()

    const html = await readFile(join(repo, 'index.html'), 'utf8')
    expect(html).toContain('<title>待办清单</title>')
    expect(html).not.toContain('{{')

    const app = await readFile(join(repo, 'src/App.tsx'), 'utf8')
    expect(app).not.toContain('{{')
  })

  it('已经有 package.json 时拒绝重铺（会把 Agent 的改动冲掉）', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"x"}', 'utf8')
    await expect(
      scaffoldApp({ ...VARS, repoDir: repo, templateId: 'react-vite' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_DIR_NOT_EMPTY' })
  })

  it('force 可以覆盖（导入/重置场景）', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"old"}', 'utf8')
    const result = await scaffoldApp({
      ...VARS,
      repoDir: repo,
      templateId: 'react-vite',
      force: true,
    })
    expect(result.files.length).toBeGreaterThan(0)
    const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('todo-list')
  })

  it('未知模板在铺之前就失败，不会留下半个工作区', async () => {
    await expect(
      scaffoldApp({ ...VARS, repoDir: repo, templateId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_UNKNOWN' })
    await expect(readFile(join(repo, 'package.json'), 'utf8')).rejects.toThrow()
  })
})

/**
 * 全栈模板（M2）。
 *
 * 这几条守的是**跨文件的一致性**，单看任何一个文件都没问题：
 * - `package.json.tenon.api` 是运行时唯一事实来源（预览靠它决定起不起后端），
 *   它指的文件必须真的在模板里
 * - 后端启动必须走 ts-node（装饰器元数据），不能哪天被"优化"成 tsx
 * - 应用代码只认 `DATABASE_URL`，不许出现环境分支
 */
describe('全栈模板 nest-api', () => {
  it('声明的后端入口真的在模板里，迁移目录也在', async () => {
    const files = await collectFiles('nest-api')
    const manifest = JSON.parse(
      await readFile(join(templatesRoot(), 'nest-api', 'package.json'), 'utf8'),
    ) as { tenon?: { api?: string } }

    expect(manifest.tenon?.api).toBe('api/main.ts')
    expect(files).toContain('api/main.ts')
    expect(files.some((file) => file.startsWith('api/migrations/'))).toBe(true)
    expect(files).toContain('shared/schema.ts')
  })

  it('铺出来的应用自洽：变量替换干净、共享契约与迁移都在', async () => {
    const result = await scaffoldApp({ ...VARS, repoDir: repo, templateId: 'nest-api' })
    expect(result.entry).toBe('index.html')

    for (const file of ['api/main.ts', 'api/db.ts', 'api/app.module.ts', 'shared/schema.ts']) {
      const content = await readFile(join(repo, file), 'utf8')
      expect(content, `${file} 里还有占位符`).not.toContain('{{')
    }
    const html = await readFile(join(repo, 'index.html'), 'utf8')
    expect(html).toContain('<title>待办清单</title>')
    expect(await readFile(join(repo, 'api/migrations/1767225600000-InitItems.ts'), 'utf8')).toContain(
      'create table if not exists items',
    )
  })

  it('后端用 tsc 编译产物（tsx/esbuild 不产装饰器元数据；ts-node 在 Node 22.18+ 已失效）', async () => {
    await scaffoldApp({ ...VARS, repoDir: repo, templateId: 'nest-api' })
    const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      tenon?: { apiOut?: string; apiTsconfig?: string }
      devDependencies: Record<string, string>
    }
    expect(pkg.tenon?.apiOut).toBe('dist-server/api/main.js')
    expect(pkg.tenon?.apiTsconfig).toBe('tsconfig.server.json')
    expect(pkg.scripts['start:api']).toContain('dist-server/api/main.js')
    // ts-node 不要再加回来：Node 22.18 起原生类型擦除会抢走 .ts 入口
    expect(pkg.devDependencies['ts-node']).toBeUndefined()

    const serverTsconfig = JSON.parse(
      await readFile(join(repo, 'tsconfig.server.json'), 'utf8'),
    ) as { compilerOptions: Record<string, unknown> }
    expect(serverTsconfig.compilerOptions['outDir']).toBe('dist-server')
    expect(serverTsconfig.compilerOptions['emitDecoratorMetadata']).toBe(true)
  })

  it('应用侧只认 DATABASE_URL，没有环境分支', async () => {
    await scaffoldApp({ ...VARS, repoDir: repo, templateId: 'nest-api' })
    const db = await readFile(join(repo, 'api/db.ts'), 'utf8')
    expect(db).toContain("process.env['DATABASE_URL']")
    expect(db).toContain("process.env['DATABASE_POOL_MAX']")
    expect(db).not.toContain('NODE_ENV')
  })

  it('运行时 SDK 真的接上了（拷了文件却没用上 = 看起来有其实没有）', async () => {
    await scaffoldApp({ ...VARS, repoDir: repo, templateId: 'nest-api' })

    // 后端：过滤器必须是全局 provider，否则 4xx/5xx 还是走 Nest 默认格式
    const module = await readFile(join(repo, 'api/app.module.ts'), 'utf8')
    expect(module).toContain("from './tenon-logger'")
    expect(module).toContain('APP_FILTER')
    expect(module).toContain('useClass: TenonLoggerFilter')

    // 前端：全局钩子与错误边界都要挂上
    const main = await readFile(join(repo, 'src/main.tsx'), 'utf8')
    expect(main).toContain('installTenonLog()')
    expect(main).toContain('TenonErrorBoundary')

    // 两模板共用同一份 SDK 源码（漂移由 runtime-sdk/test/sync.test.ts 拦）
    expect(await collectFiles('react-vite')).toContain('src/tenon-boundary.tsx')
  })
})
