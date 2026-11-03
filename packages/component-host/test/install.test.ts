/**
 * `install_component` 的业务内核（不含 pi 工具层）：装一个组件要动三个地方 ——
 * 装配声明、AGENTS.md、以及"装完就是活的"。
 *
 * 最要紧的两条：
 * - **先试算再落盘**：装不上时磁盘上一个字节都不该变（不然用户看到一份半装的声明）。
 * - **幂等**：同 id 再装一次，文件字节不变（否则每装一次多一个无意义 commit）。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENTS_DOC,
  assemblyFile,
  installComponent,
  readAssembly,
  uninstallComponent,
} from '../src/index.js'
import type { PluginRoot } from '../src/roots.js'

let dir: string
let rootsDir: string
let repoDir: string

const roots = (): PluginRoot[] => [{ kind: 'bundled', dir: rootsDir }]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-install-'))
  rootsDir = join(dir, 'plugins')
  repoDir = join(dir, 'repo')
  await mkdir(rootsDir, { recursive: true })
  await mkdir(repoDir, { recursive: true })
  await addPlugin('tenon.test.assistant', {
    name: 'AI 小助手',
    description: '右下角悬浮球',
    slots: ['app.shell.overlay', 'app.api'],
    agentHints: '用它，不要自己写聊天框',
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function addPlugin(
  id: string,
  manifest: Record<string, unknown> = {},
  files: Record<string, string | null> = {},
): Promise<void> {
  const pluginDir = join(rootsDir, id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      description: `${id} 的说明`,
      source: 'bundled',
      minTenonVersion: '0.0.0',
      signature: null,
      permissions: [],
      agentHints: '说明',
      pricing: { type: 'free' },
      facets: { server: 'server.js', web: 'web.js' },
      slots: ['app.shell.overlay'],
      ...manifest,
    }),
    'utf8',
  )
  for (const [name, content] of Object.entries({ 'server.js': '// s', 'web.js': '// w', ...files })) {
    if (content === null) continue
    await writeFile(join(pluginDir, name), content, 'utf8')
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

describe('装组件', () => {
  it('写装配声明 + AGENTS.md，默认挂在清单的第一个插槽上', async () => {
    const result = await installComponent({
      repoDir,
      roots: roots(),
      tenonVersion: '0.0.0',
      id: 'tenon.test.assistant',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyInstalled).toBe(false)
    expect(result.component.mounts).toEqual([{ slot: 'app.shell.overlay', order: 100, prefix: null }])

    const assembly = JSON.parse(await readText(assemblyFile(repoDir))) as {
      components: { id: string; version: string; mount: unknown[] }[]
    }
    expect(assembly.components).toHaveLength(1)
    expect(assembly.components[0]?.version).toBe('^1.0.0')

    const doc = await readText(join(repoDir, AGENTS_DOC))
    expect(doc).toContain('## 已装组件')
    expect(doc).toContain('AI 小助手')
    expect(doc).toContain('tenon.test.assistant')
    expect(doc).toContain('用它，不要自己写聊天框')
  })

  it('幂等：再装一次字节不变，声明也只有一条', async () => {
    const first = await installComponent({ repoDir, roots: roots(), tenonVersion: '0.0.0', id: 'tenon.test.assistant' })
    expect(first.ok).toBe(true)
    const before = await readText(assemblyFile(repoDir))
    const docBefore = await readText(join(repoDir, AGENTS_DOC))

    const second = await installComponent({ repoDir, roots: roots(), tenonVersion: '0.0.0', id: 'tenon.test.assistant' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.alreadyInstalled).toBe(true)
    expect(second.agentsDoc.changed).toBe(false)
    expect(await readText(assemblyFile(repoDir))).toBe(before)
    expect(await readText(join(repoDir, AGENTS_DOC))).toBe(docBefore)

    const assembly = await readAssembly(repoDir)
    expect(assembly.kind === 'ok' ? assembly.assembly.components.length : -1).toBe(1)
  })

  it('指定插槽：按参数挂', async () => {
    const result = await installComponent({
      repoDir,
      roots: roots(),
      tenonVersion: '0.0.0',
      id: 'tenon.test.assistant',
      mounts: [{ slot: 'app.shell.overlay', order: 5 }],
    })
    expect(result.ok && result.component.mounts[0]?.order).toBe(5)
  })

  it('装不上时磁盘上一个字节都不变（先试算、后落盘）', async () => {
    const result = await installComponent({
      repoDir,
      roots: roots(),
      tenonVersion: '0.0.0',
      id: 'tenon.test.assistant',
      mounts: [{ slot: 'app.page.header', order: 100 }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((item) => item.code)).toContain('slot-not-declared')
    const assembly = await readAssembly(repoDir)
    expect(assembly.kind === 'ok' ? assembly.assembly.components : []).toEqual([])
    await expect(readText(join(repoDir, AGENTS_DOC))).rejects.toThrow()
  })

  it('找不到组件时给出可读的原因', async () => {
    const result = await installComponent({ repoDir, roots: roots(), tenonVersion: '0.0.0', id: 'tenon.ghost' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]?.code).toBe('missing')
    expect(result.problems[0]?.hint).toContain('component.list')
  })

  it('版本对不上时说清找到了哪些版本', async () => {
    const result = await installComponent({
      repoDir,
      roots: roots(),
      tenonVersion: '0.0.0',
      id: 'tenon.test.assistant',
      version: '^2.0.0',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]?.code).toBe('version-unsatisfied')
    expect(result.problems[0]?.message).toContain('1.0.0')
  })

  it('已有的 AGENTS.md 只改标记区，别的小节原样保留', async () => {
    await mkdir(join(repoDir, 'docs'), { recursive: true })
    const original = '# 项目说明\n\n## 架构\n\n两层：前端 + Nest。\n'
    await writeFile(join(repoDir, AGENTS_DOC), original, 'utf8')

    await installComponent({ repoDir, roots: roots(), tenonVersion: '0.0.0', id: 'tenon.test.assistant' })
    const doc = await readText(join(repoDir, AGENTS_DOC))
    expect(doc).toContain('## 架构')
    expect(doc).toContain('两层：前端 + Nest。')
    expect(doc).toContain('## 已装组件')
    // 再卸一次：架构那段仍然在，组件那段变成"（无）"
    await uninstallComponent({ repoDir, roots: roots(), tenonVersion: '0.0.0', id: 'tenon.test.assistant' })
    const after = await readText(join(repoDir, AGENTS_DOC))
    expect(after).toContain('## 架构')
    expect(after).toContain('（无）')
    expect(after).not.toContain('AI 小助手')
  })
})

describe('卸组件', () => {
  it('删声明 + 同步 AGENTS.md；没装过也返回成功（幂等）', async () => {
    await installComponent({ repoDir, roots: roots(), tenonVersion: '0.0.0', id: 'tenon.test.assistant' })
    const removed = await uninstallComponent({
      repoDir,
      roots: roots(),
      tenonVersion: '0.0.0',
      id: 'tenon.test.assistant',
    })
    expect(removed.removed).toBe(true)
    expect(removed.remaining).toEqual([])

    const again = await uninstallComponent({
      repoDir,
      roots: roots(),
      tenonVersion: '0.0.0',
      id: 'tenon.test.assistant',
    })
    expect(again.removed).toBe(false)
  })
})
