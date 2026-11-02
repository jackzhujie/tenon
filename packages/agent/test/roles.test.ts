/**
 * 角色表与只读检索工具（M4 第 1 步）。
 *
 * 这里钉的都是"错了会静默失控"的约束：
 * - 子角色的工具集是**白名单**，`builder` 不在可派活列表里（递归派活是失控第一入口）；
 * - 没接好的角色必须**明确报没接**，而不是让模型自己发现工具不存在（那会开始瞎猜文件内容）；
 * - `grep` / `glob` 是我们的实现，不是 pi 的（pi 的会去下载 ripgrep 二进制）。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RoleId } from '../src/roles.js'
import {
  DELEGABLE_ROLES,
  ROLES,
  roleOf,
  roleOfPrompt,
  subagentPrompt,
  toolsForRole,
} from '../src/roles.js'
import { createSearchTools, globToRegExp } from '../src/tools/search.js'

const fake = (name: string): ToolRegistration => ({
  name,
  description: name,
  parameters: { type: 'object' } as never,
  replay: 'safe',
  async execute() {
    return { output: [{ type: 'text' as const, text: '' }] }
  },
})

const ALL = [
  'read',
  'write',
  'edit',
  'bash',
  'ls',
  'glob',
  'grep',
  'subagent',
  // M4 第 4 步：e2e 角色的预览工具也要在"全量表"里，否则下面那条"名字都是真名字"的断言会误报
  'preview_read',
  'preview_assert',
  'preview_click',
  'preview_type',
  'preview_open',
].map(fake)

describe('角色表', () => {
  it('每个子角色的工具都是全量表里的真名字（拼错会静默给空工具集）', () => {
    const known = new Set(ALL.map((tool) => tool.name))
    for (const role of Object.values(ROLES)) {
      for (const name of role.tools) expect(known.has(name), `${role.id} 用了不存在的工具 ${name}`).toBe(true)
    }
  })

  it('builder 不可被派活，五个子角色都不可再派活', () => {
    expect(DELEGABLE_ROLES).not.toContain('builder')
    expect(DELEGABLE_ROLES).toHaveLength(5)
    for (const id of DELEGABLE_ROLES) {
      expect(ROLES[id].canDelegate).toBe(false)
      expect(ROLES[id].tools).not.toContain('subagent')
    }
  })

  it('白名单真的会拦住写工具，也永远不给 subagent', () => {
    const explore = toolsForRole(ROLES.explore, ALL).map((tool) => tool.name)
    expect(explore.sort()).toEqual(['glob', 'grep', 'ls', 'read'])
    expect(explore).not.toContain('write')
    // 就算哪天有人在 roles 表里手滑把 subagent 写进去，这里也不给
    const sneaky = toolsForRole({ ...ROLES.explore, tools: ['read', 'subagent'] }, ALL).map((tool) => tool.name)
    expect(sneaky).toEqual(['read'])
  })

  it('快 / 综合 / 思考三档都声明了（路由还没接，但档位不是随手填的）', () => {
    expect(ROLES.explore.tier).toBe('fast')
    expect(ROLES.builder.tier).toBe('comprehensive')
    expect(ROLES.reviewer.tier).toBe('thinking')
  })

  it('没接好的角色带 pending 说明，已接好的不带', () => {
    for (const id of ['explore', 'librarian', 'e2e'] as RoleId[]) {
      expect(ROLES[id].readiness, id).toBe('ready')
      expect(ROLES[id].pending, id).toBeUndefined()
    }
    for (const id of ['codeact', 'reviewer'] as RoleId[]) {
      expect(ROLES[id].readiness, id).toBe('planned')
      expect(ROLES[id].pending, id).toBeTruthy()
    }
  })

  it('角色标记能原样认回来（faux 靠它分道，认错就会串台词）', () => {
    for (const id of DELEGABLE_ROLES) {
      expect(roleOfPrompt(subagentPrompt(id, '查一下'))).toBe(id)
    }
    // 普通用户消息不能被当成子 Agent 的话
    expect(roleOfPrompt('帮我看看这个页面')).toBeUndefined()
    // 自己打的类似文本（没有 role=）也不认
    expect(roleOfPrompt('[TENON-SUBAGENT] 假的')).toBeUndefined()
    expect(roleOf('nobody')).toBeUndefined()
  })
})

describe('glob 编译', () => {
  it('** 跨目录、* 不跨、? 单字符', () => {
    const anyTsx = globToRegExp('**/*.tsx')
    expect(anyTsx.test('src/App.tsx')).toBe(true)
    expect(anyTsx.test('App.tsx')).toBe(true)
    expect(anyTsx.test('src/deep/App.tsx')).toBe(true)
    expect(anyTsx.test('src/App.ts')).toBe(false)

    const oneLevel = globToRegExp('src/*.ts')
    expect(oneLevel.test('src/a.ts')).toBe(true)
    expect(oneLevel.test('src/x/a.ts')).toBe(false)

    const single = globToRegExp('a?.ts')
    expect(single.test('ab.ts')).toBe(true)
    expect(single.test('abc.ts')).toBe(false)
  })

  it('点号与括号不被当成正则语法', () => {
    expect(globToRegExp('a.b.ts').test('a.b.ts')).toBe(true)
    expect(globToRegExp('a.b.ts').test('axb.ts')).toBe(false)
  })
})

describe('只读检索工具（真文件系统）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-search-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(dir, 'src', 'App.tsx'), 'export function App() {\n  return <div>你好</div>\n}\n')
    await writeFile(join(dir, 'src', 'util.ts'), 'export const handle = 1\n')
    await writeFile(join(dir, 'README.md'), '# 示例\nhandle 在 src/util.ts\n')
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'const handle = 0\n')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const run = async (tool: string, args: Record<string, unknown>): Promise<string> => {
    const found = createSearchTools({ repoDir: dir }).find((item) => item.name === tool)
    if (found === undefined) throw new Error(`没有工具 ${tool}`)
    const result = (await found.execute(args as never, {} as never, {} as never)) as {
      output: { type: string; text?: string }[]
      isError?: boolean
    }
    return result.output.map((part) => part.text ?? '').join('')
  }

  it('ls 列目录：目录带 /、文件带体积', async () => {
    const out = await run('ls', {})
    expect(out).toContain('src/')
    expect(out).toContain('README.md')
    expect(out).toMatch(/README\.md\t\d+B/)
  })

  it('glob 找文件，且不钻进 node_modules', async () => {
    const out = await run('glob', { pattern: '**/*.ts' })
    expect(out).toContain('src/util.ts')
    expect(out).not.toContain('node_modules')
  })

  it('grep 给 path:line: text，跳过 node_modules', async () => {
    const out = await run('grep', { pattern: 'handle' })
    expect(out).toContain('src/util.ts:1:')
    expect(out).toContain('README.md:2:')
    expect(out).not.toContain('node_modules')
  })

  it('grep 的 literal / ignoreCase / glob 都生效', async () => {
    expect(await run('grep', { pattern: 'HANDLE', ignoreCase: true })).toContain('src/util.ts')
    expect(await run('grep', { pattern: 'HANDLE' })).toContain('没有匹配')
    // `handle = 1` 里没有正则语义，用 literal 才能按字面找 `= 1`
    expect(await run('grep', { pattern: '= 1', literal: true })).toContain('src/util.ts')
    const onlyMd = await run('grep', { pattern: 'handle', glob: '*.md' })
    const paths = onlyMd
      .split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => line.slice(0, line.indexOf(':')))
    expect(paths).toEqual(['README.md'])
  })

  it('越界路径一律拒绝（三个工具都拦）', async () => {
    for (const [tool, args] of [
      ['ls', { path: '../..' }],
      ['glob', { pattern: '**/*', path: '/etc' }],
      ['grep', { pattern: 'root', path: '/etc/passwd' }],
    ] as const) {
      expect(await run(tool, args), tool).toContain('拒绝访问工作区之外的路径')
    }
  })
})
