/**
 * 加载计划：把「装配声明 + 磁盘上的插件 + 宿主版本」算成「加载谁、按什么顺序、为什么装不上」。
 *
 * 每条用例都对应一个**真实会遇到的坏局面**，而不是为了覆盖率：
 * 版本区间对不上（用户改了声明）、hub 版覆盖 bundled 版（热更新）、
 * 依赖没装、依赖成环、两个组件抢同一个后端前缀、开关关掉但声明还在……
 *
 * 贯穿全篇的一条断言习惯：**一个组件坏，别的组件照常加载**。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeAssembly, type ComponentAssembly, type ComponentEntry } from '../src/assembly.js'
import { buildPlan, listAvailable, type PlanResult } from '../src/plan.js'
import type { PluginRoot } from '../src/roots.js'

let dir: string
let bundledDir: string
let hubDir: string
let repoDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-plan-'))
  bundledDir = join(dir, 'bundled')
  hubDir = join(dir, 'hub')
  repoDir = join(dir, 'repo')
  for (const path of [bundledDir, hubDir, repoDir]) await mkdir(path, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function roots(): PluginRoot[] {
  // 优先级：hub 在前（覆盖层）
  return [
    { kind: 'hub', dir: hubDir },
    { kind: 'bundled', dir: bundledDir },
  ]
}

interface PluginSpec {
  id: string
  version: string
  root?: 'bundled' | 'hub'
  /** 清单字段覆盖 */
  manifest?: Record<string, unknown>
  /** 额外/替换的文件（相对路径 → 内容）；给 `null` 表示删掉默认的那个 */
  files?: Record<string, string | null>
}

const DEFAULT_FILES = { 'server.js': '// server facet', 'web.js': '// web facet' }

/** 默认清单：一个能挂 overlay + api 的官方组件 */
function manifestOf(spec: PluginSpec, root: 'bundled' | 'hub'): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.id,
    version: spec.version,
    description: `${spec.id} 的说明`,
    source: root,
    minTenonVersion: '1.0.0',
    signature: root === 'hub' ? 'sig' : null,
    permissions: ['fs:app'],
    agentHints: '用它，不要自己写',
    pricing: { type: 'free' },
    facets: { server: 'server.js', web: 'web.js' },
    slots: ['app.shell.overlay', 'app.api'],
    ...(spec.manifest ?? {}),
  }
}

async function addPlugin(spec: PluginSpec): Promise<string> {
  const root = spec.root ?? 'bundled'
  // bundled 用平铺布局，hub 用 `<id>/<version>/`（Phase 2 的布局，现在就要能认）
  const pluginDir =
    root === 'bundled'
      ? join(bundledDir, spec.id)
      : join(hubDir, spec.id, spec.version)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'manifest.json'),
    JSON.stringify(manifestOf(spec, root), null, 2),
    'utf8',
  )
  // 默认写好两侧 facet 文件，用例可以用 `null` 把它们删掉（模拟"清单说有、文件没有"）
  for (const [name, content] of Object.entries({ ...DEFAULT_FILES, ...(spec.files ?? {}) })) {
    const path = join(pluginDir, name)
    if (content === null) {
      await rm(path, { force: true })
      continue
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return pluginDir
}

async function assemble(components: ComponentEntry[]): Promise<void> {
  const assembly: ComponentAssembly = { version: 1, components }
  await writeAssembly(repoDir, assembly)
}

function entry(id: string, overrides: Partial<ComponentEntry> = {}): ComponentEntry {
  return {
    id,
    version: '*',
    license: 'free',
    enabled: true,
    mount: [
      { slot: 'app.shell.overlay', order: 100 },
      { slot: 'app.api', order: 100, prefix: `/_c/${id.split('.').pop() ?? 'x'}` },
    ],
    ...overrides,
  }
}

async function plan(tenonVersion = '0.0.0'): Promise<PlanResult> {
  return buildPlan({ repoDir, roots: roots(), tenonVersion })
}

function codes(result: PlanResult): string[] {
  return result.problems.map((p) => p.code)
}

describe('正常装配', () => {
  it('空声明 → 没有组件、没有抱怨', async () => {
    const result = await plan()
    expect(result.components).toEqual([])
    expect(result.problems).toEqual([])
    expect(result.loadOrder).toEqual([])
  })

  it('一个组件 + 两处挂载：loaded，顺序就是依赖顺序', async () => {
    await addPlugin({ id: 'tenon.official.ai-assistant', version: '1.0.0' })
    await assemble([entry('tenon.official.ai-assistant', { version: '^1.0.0' })])
    const result = await plan()
    expect(result.problems).toEqual([])
    expect(result.components).toHaveLength(1)
    const component = result.components[0]
    expect(component?.loaded).toBe(true)
    expect(component?.version).toBe('1.0.0')
    expect(component?.mounts.map((m) => m.slot)).toEqual(['app.shell.overlay', 'app.api'])
    expect(result.loadOrder).toEqual(['tenon.official.ai-assistant'])
  })

  it('hub 版覆盖 bundled 版（热更新靠这条）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.2.0' })
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', root: 'hub' })
    await assemble([entry('tenon.official.a', { version: '^1.0.0' })])
    const result = await plan()
    // 按"最高版本"选会挑 1.2.0（bundled），那样官方修了 bug 永远推不下来
    expect(result.components[0]?.version).toBe('1.0.0')
    expect(result.components[0]?.source).toBe('hub')
  })

  it('hub 版不满足区间时回落到 bundled（卸载 hub 版不该让应用缺组件）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.2.0' })
    await addPlugin({ id: 'tenon.official.a', version: '0.9.0', root: 'hub' })
    await assemble([entry('tenon.official.a', { version: '^1.0.0' })])
    const result = await plan()
    expect(result.components[0]?.version).toBe('1.2.0')
    expect(result.components[0]?.source).toBe('bundled')
  })
})

describe('装不上：先说清原因', () => {
  it('磁盘上没有这个组件', async () => {
    await assemble([entry('tenon.official.ghost')])
    const result = await plan()
    expect(codes(result)).toEqual(['missing'])
    expect(result.problems[0]?.hint).toBeTruthy()
    expect(result.loadOrder).toEqual([])
  })

  it('有组件但版本对不上，提示里要带上找到的版本', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '2.0.0' })
    await assemble([entry('tenon.official.a', { version: '^1.0.0' })])
    const result = await plan()
    expect(codes(result)).toEqual(['version-unsatisfied'])
    expect(result.problems[0]?.message).toContain('2.0.0')
  })

  it('宿主太旧', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { minTenonVersion: '1.4.0' } })
    await assemble([entry('tenon.official.a')])
    const result = await plan('1.2.0')
    expect(codes(result)).toEqual(['tenon-too-old'])
    expect(result.problems[0]?.message).toContain('1.2.0')
  })

  it('目录名与清单 id 不一致（放错位置会装上别的组件）', async () => {
    const pluginDir = await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await writeFile(
      join(pluginDir, 'manifest.json'),
      JSON.stringify(manifestOf({ id: 'tenon.official.other', version: '1.0.0' }, 'bundled')),
      'utf8',
    )
    await assemble([entry('tenon.official.a')])
    // 目录名是 a，清单说是 other —— 扫描用目录名认领，装配的是 a，于是 id 对不上
    expect(codes(await plan())).toEqual(['id-mismatch'])
  })

  it('来源与所在目录不一致（否则签名校验被绕过）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { source: 'hub' } })
    await assemble([entry('tenon.official.a')])
    expect(codes(await plan())).toEqual(['source-mismatch'])
  })

  it('hub 目录里没有签名的组件不加载', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', root: 'hub', manifest: { signature: null } })
    await assemble([entry('tenon.official.a')])
    expect(codes(await plan())).toEqual(['unsigned'])
  })

  it('清单本身坏了（未知权限）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { permissions: ['root:all'] } })
    await assemble([entry('tenon.official.a')])
    const result = await plan()
    expect(codes(result)).toEqual(['invalid-manifest'])
    expect(result.problems[0]?.hint).toContain('root:all')
  })

  it('挂在不存在的槽位上', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await assemble([entry('tenon.official.a', { mount: [{ slot: 'app.nowhere', order: 100 }] })])
    expect(codes(await plan())).toEqual(['unknown-slot'])
  })

  it('挂在组件没声明的槽位上', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { slots: ['app.shell.overlay'] } })
    await assemble([entry('tenon.official.a')])
    const result = await plan()
    expect(codes(result)).toEqual(['slot-not-declared'])
    expect(result.problems[0]?.hint).toContain('app.shell.overlay')
  })

  it('组件没有那一侧的 facet，却挂到那一边', async () => {
    await addPlugin({
      id: 'tenon.official.a',
      version: '1.0.0',
      manifest: { facets: { web: 'web.js' }, slots: ['app.shell.overlay', 'app.api'] },
    })
    await assemble([entry('tenon.official.a')])
    expect(codes(await plan())).toEqual(['facet-missing'])
  })

  it('清单说有 web.js，文件却不在', async () => {
    await addPlugin({
      id: 'tenon.official.a',
      version: '1.0.0',
      manifest: { facets: { web: 'web.js' }, slots: ['app.shell.overlay'] },
      files: { 'web.js': null },
    })
    await assemble([entry('tenon.official.a', { mount: [{ slot: 'app.shell.overlay', order: 100 }] })])
    expect(codes(await plan())).toEqual(['facet-file-missing'])
  })

  it('前端槽位上写了 prefix', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await assemble([
      entry('tenon.official.a', { mount: [{ slot: 'app.shell.overlay', order: 100, prefix: '/_c/x' }] }),
    ])
    expect(codes(await plan())).toEqual(['prefix-on-slot'])
  })

  it('版本区间写错（不是合法 semver 区间）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await assemble([entry('tenon.official.a', { version: 'latest' })])
    expect(codes(await plan())).toEqual(['bad-range'])
  })

  it('同一个 id 写了两遍', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await assemble([entry('tenon.official.a'), entry('tenon.official.a')])
    const result = await plan()
    expect(codes(result)).toEqual(['duplicate-entry'])
    // 第一条照常加载：一条写重了不该让组件消失
    expect(result.components).toHaveLength(1)
    expect(result.components[0]?.loaded).toBe(true)
  })

  it('装配声明整份坏掉时，明确说"这次谁都不加载"', async () => {
    await writeFile(join(repoDir, 'app.components.json'), '{ nope', 'utf8')
    const result = await plan()
    expect(codes(result)).toEqual(['assembly-invalid'])
    expect(result.components).toEqual([])
    expect(result.assembly).toBeNull()
  })
})

describe('坏一个不影响别的', () => {
  it('A 版本对不上，B 照常加载', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '2.0.0' })
    await addPlugin({ id: 'tenon.official.b', version: '1.0.0' })
    await assemble([entry('tenon.official.a', { version: '^1.0.0' }), entry('tenon.official.b')])
    const result = await plan()
    expect(codes(result)).toEqual(['version-unsatisfied'])
    expect(result.components.map((c) => [c.id, c.loaded])).toEqual([
      ['tenon.official.b', true],
    ])
  })

  it('关掉的组件仍然出现在列表里，但不加载', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await assemble([entry('tenon.official.a', { enabled: false })])
    const result = await plan()
    expect(result.problems).toEqual([])
    expect(result.components[0]?.enabled).toBe(false)
    expect(result.components[0]?.loaded).toBe(false)
    expect(result.loadOrder).toEqual([])
  })
})

describe('依赖', () => {
  it('加载顺序：被依赖的在前（哪怕声明里写在后面）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { dependencies: { 'tenon.official.b': '^1.0.0' } } })
    await addPlugin({ id: 'tenon.official.b', version: '1.0.0' })
    await assemble([entry('tenon.official.a'), entry('tenon.official.b')])
    const result = await plan()
    expect(result.loadOrder).toEqual(['tenon.official.b', 'tenon.official.a'])
  })

  it('依赖没装配 → 装不上，并说清缺谁', async () => {
    await addPlugin({
      id: 'tenon.official.a',
      version: '1.0.0',
      manifest: { dependencies: { 'tenon.official.b': '^1.0.0' } },
    })
    await assemble([entry('tenon.official.a')])
    const result = await plan()
    expect(codes(result)).toEqual(['dependency-missing'])
    expect(result.problems[0]?.hint).toContain('tenon.official.b')
  })

  it('依赖的版本区间没匹配上也算缺依赖', async () => {
    await addPlugin({
      id: 'tenon.official.a',
      version: '1.0.0',
      manifest: { dependencies: { 'tenon.official.b': '^2.0.0' } },
    })
    await addPlugin({ id: 'tenon.official.b', version: '1.0.0' })
    await assemble([entry('tenon.official.a'), entry('tenon.official.b')])
    expect(codes(await plan())).toEqual(['dependency-missing'])
  })

  it('成环 → 整组都不加载', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { dependencies: { 'tenon.official.b': '*' } } })
    await addPlugin({ id: 'tenon.official.b', version: '1.0.0', manifest: { dependencies: { 'tenon.official.a': '*' } } })
    await assemble([entry('tenon.official.a'), entry('tenon.official.b')])
    const result = await plan()
    expect(codes(result)).toContain('dependency-cycle')
    expect(result.loadOrder).toEqual([])
  })

  it('依赖装不上时，依赖它的也装不上（链再长也要传到位）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { dependencies: { 'tenon.official.b': '*' } } })
    await addPlugin({ id: 'tenon.official.b', version: '1.0.0', manifest: { dependencies: { 'tenon.official.c': '*' } } })
    await addPlugin({
      id: 'tenon.official.c',
      version: '1.0.0',
      manifest: { facets: { web: 'web.js' }, slots: ['app.shell.overlay'] },
      files: { 'web.js': null },
    })
    await assemble([
      entry('tenon.official.a'),
      entry('tenon.official.b'),
      entry('tenon.official.c', { mount: [{ slot: 'app.shell.overlay', order: 100 }] }),
    ])
    const result = await plan()
    expect(codes(result).sort()).toEqual(['dependency-blocked', 'dependency-blocked', 'facet-file-missing'])
    expect(result.loadOrder).toEqual([])
  })

  it('两个组件抢同一个后端前缀 → 都拦下（路由会打架）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await addPlugin({ id: 'tenon.official.b', version: '1.0.0' })
    const same = [{ slot: 'app.api', order: 100, prefix: '/_c/shared' }]
    await assemble([
      entry('tenon.official.a', { mount: same }),
      entry('tenon.official.b', { mount: same }),
    ])
    const result = await plan()
    expect(codes(result)).toEqual(['prefix-conflict', 'prefix-conflict'])
    expect(result.loadOrder).toEqual([])
  })
})

describe('可安装列表', () => {
  it('列出磁盘上的组件，标出已经装了的', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0' })
    await addPlugin({ id: 'tenon.official.b', version: '2.0.0' })
    const available = await listAvailable({ roots: roots(), installed: ['tenon.official.a'] })
    expect(available.map((c) => [c.id, c.installed])).toEqual([
      ['tenon.official.a', true],
      ['tenon.official.b', false],
    ])
  })

  it('同 id 多版本时给优先级更高的那个（与真实加载一致）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.2.0' })
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', root: 'hub' })
    const available = await listAvailable({ roots: roots(), installed: [] })
    expect(available).toHaveLength(1)
    expect(available[0]?.version).toBe('1.0.0')
    expect(available[0]?.source).toBe('hub')
  })

  it('清单坏掉的组件不出现在可安装列表里（装不上就别勾引用户）', async () => {
    await addPlugin({ id: 'tenon.official.a', version: '1.0.0', manifest: { permissions: ['root:all'] } })
    expect(await listAvailable({ roots: roots(), installed: [] })).toEqual([])
  })
})
