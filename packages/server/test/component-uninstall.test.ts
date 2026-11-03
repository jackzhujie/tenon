/**
 * DoD ② 的验收：**卸载即清理**（M5 第 5 步）。
 *
 * "清理"在这里是可验证的三件事，一件都不能少：
 * 1. **装配声明里没有它** —— 否则下次启动又回来了；
 * 2. **`docs/AGENTS.md` 里没有它** —— 否则 Agent 会继续以为有这个东西，甚至"帮忙恢复"；
 * 3. **仓库里没有任何指向它的引用** —— 这是"代码也清了"的证据。组件是注入式的，
 *    正常情况下本来就不该有引用；一旦有（比如有人手抄了一段调用），这里会当场抓到。
 *
 * 另外两条：`component.list` 立刻反映（装完是 loaded、卸完是空），以及**幂等**。
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appPaths, resolveHome } from '@tenon/core'
import { createComponentsTools, type ComponentsToolsOptions } from '@tenon/agent'
import { AGENTS_DOC } from '@tenon/component-host'
import type { RunningServer } from '../src/index.js'
import { boot, rpc } from './support.js'

const ID = 'tenon.official.ai-assistant'
const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'bundled')

interface ToolText {
  output: { type: string; text: string }[]
  isError?: boolean
}

let home: string
let running: RunningServer | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenon-uninstall-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(home, { recursive: true, force: true })
})

async function start(): Promise<{ server: RunningServer; appId: string; repoDir: string; tools: ReturnType<typeof createComponentsTools> }> {
  running = await boot(home, { pluginRoots: [{ kind: 'bundled', dir: PLUGINS }] })
  const server = running
  const created = await rpc<{ app: { id: string } }>(server, 'app.create', {
    name: '组件卸载测试',
    templateId: 'react-vite',
    styleId: null,
  })
  const appId = created.app.id
  const repoDir = appPaths(resolveHome({ TENON_HOME: home }), appId).repoDir
  const options: ComponentsToolsOptions = {
    appId,
    repoDir,
    roots: [{ kind: 'bundled', dir: PLUGINS }],
    tenonVersion: '0.0.0',
    // 生产里由 server 注入：装/卸之后重新激活组件宿主
    onChanged: async (id) => {
      await server.components.reload(id)
    },
  }
  return { server, appId, repoDir, tools: createComponentsTools(options) }
}

async function call(tools: ReturnType<typeof createComponentsTools>, name: string, args: unknown): Promise<ToolText> {
  const tool = tools.find((item) => item.name === name)
  if (tool === undefined) throw new Error(`没有工具 ${name}`)
  const execute = tool.execute as unknown as (input: unknown) => Promise<ToolText>
  return execute(args)
}

function textOf(result: ToolText): string {
  return result.output.map((part) => part.text).join('')
}

/** 递归扫仓库（跳过依赖与平台目录），找"还有没有指向这个组件的引用" */
async function referencesIn(repoDir: string, needle: string): Promise<string[]> {
  const hits: string[] = []
  const skip = new Set(['node_modules', '.git', '.tenon', 'dist'])
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(repoDir, rel), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(childRel)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(join(repoDir, childRel))
      if (info.size > 512 * 1024) continue
      const content = await readFile(join(repoDir, childRel), 'utf8').catch(() => '')
      if (content.includes(needle)) hits.push(childRel)
    }
  }
  await walk('')
  return hits
}

describe('卸载即清理（DoD ②）', () => {
  it('装 → 三处都写；卸 → 三处都干净，且幂等', async () => {
    const { server, appId, repoDir: repository, tools } = await start()

    // ① 装
    const installed = await call(tools, 'install_component', { id: ID })
    expect(installed.isError).toBeFalsy()
    expect(textOf(installed)).toContain('已装')

    const afterInstall = await rpc<{ components: { id: string; loaded: boolean }[] }>(
      server,
      'component.list',
      { appId },
    )
    expect(afterInstall.components[0]).toMatchObject({ id: ID, loaded: true })

    const docAfterInstall = await readFile(join(repository, AGENTS_DOC), 'utf8')
    expect(docAfterInstall).toContain('AI 小助手')
    expect((await referencesIn(repository, ID)).length).toBeGreaterThan(0) // 声明与文档里当然有

    // ② 卸
    const removed = await call(tools, 'remove_component', { id: ID })
    expect(removed.isError).toBeFalsy()
    expect(textOf(removed)).toContain('已卸')

    const listAfter = await rpc<{ components: unknown[]; available: { id: string; installed: boolean }[] }>(
      server,
      'component.list',
      { appId },
    )
    expect(listAfter.components).toEqual([])
    expect(listAfter.available[0]).toMatchObject({ id: ID, installed: false })

    const docAfterRemove = await readFile(join(repository, AGENTS_DOC), 'utf8')
    expect(docAfterRemove).toContain('（无）')
    expect(docAfterRemove).not.toContain(ID)

    // ③ 仓库里不该再有任何指向它的引用（代码、声明、文档都算）
    expect(await referencesIn(repository, ID)).toEqual([])

    // ④ 幂等：再卸一次不报错，文件也不变
    const again = await call(tools, 'remove_component', { id: ID })
    expect(again.isError).toBeFalsy()
    expect(textOf(again)).toContain('本来就没装')
    expect(await readFile(join(repository, AGENTS_DOC), 'utf8')).toBe(docAfterRemove)
  })

  it('卸一个没装过的组件：不报错，也不留下空文件', async () => {
    const { tools, repoDir } = await start()
    const result = await call(tools, 'remove_component', { id: 'tenon.never.installed' })
    expect(result.isError).toBeFalsy()
    // 没装过的东西不该凭空写出一份 AGENTS.md
    await expect(readFile(join(repoDir, AGENTS_DOC), 'utf8')).rejects.toThrow()
  })

  it('开关：关掉之后不加载，但声明还在（关掉 ≠ 卸载）', async () => {
    const { server, appId, repoDir, tools } = await start()
    await call(tools, 'install_component', { id: ID })

    const off = await rpc<{ components: { enabled: boolean; loaded: boolean }[] }>(
      server,
      'component.setEnabled',
      { appId, id: ID, enabled: false },
    )
    expect(off.components[0]).toMatchObject({ enabled: false, loaded: false })

    // 声明还在：否则"关掉试试"之后就没法一键开回来了
    const assembly = JSON.parse(await readFile(join(repoDir, 'app.components.json'), 'utf8')) as {
      components: { id: string; enabled: boolean }[]
    }
    expect(assembly.components).toEqual([expect.objectContaining({ id: ID, enabled: false })])
    // AGENTS.md 要写明"已关闭"，否则 Agent 会以为它还在界面上
    expect(await readFile(join(repoDir, AGENTS_DOC), 'utf8')).toContain('已关闭')

    const on = await rpc<{ components: { enabled: boolean; loaded: boolean }[] }>(
      server,
      'component.setEnabled',
      { appId, id: ID, enabled: true },
    )
    expect(on.components[0]).toMatchObject({ enabled: true, loaded: true })
  })

  it('list_components 会告诉模型哪些已装', async () => {
    const { tools } = await start()
    await call(tools, 'install_component', { id: ID })
    const list = await call(tools, 'list_components', {})
    expect(textOf(list)).toContain(ID)
    expect(textOf(list)).toContain('（已装）')
  })
})
