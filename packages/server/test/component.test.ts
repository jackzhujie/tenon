/**
 * `component.list` 走真 HTTP。
 *
 * 这里验的不是加载计划（那些在 `component-host` 的单测里，30 条），而是**接线**：
 * 装配声明写进的是应用仓库、服务端找得到；装不上的原因能顺着 RPC 传到前端，
 * 而且**不会变成 500** —— 插件页要能把"AI 小助手装不上，因为它要求 Tenon ≥ 1.4.0"
 * 显示出来，一个红叉加 Internal Server Error 说明不了任何事。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appPaths, resolveHome } from '@tenon/core'
import type { PluginRoot } from '@tenon/component-host'
import type { RunningServer } from '../src/index.js'
import { boot, rpc } from './support.js'

interface ComponentList {
  components: Array<{
    id: string
    version: string
    enabled: boolean
    loaded: boolean
    mounts: Array<{ slot: string; order: number; prefix: string | null }>
  }>
  problems: Array<{ code: string; componentId: string | null; message: string; hint: string | null }>
  available: Array<{ id: string; version: string; installed: boolean; source: string }>
  assemblyFile: string
  tenonVersion: string
}

let home: string
let plugins: string
let running: RunningServer | undefined

const roots = (): PluginRoot[] => [{ kind: 'bundled', dir: plugins }]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenon-component-'))
  plugins = join(home, 'bundled-plugins')
  await mkdir(join(plugins, 'tenon.official.ai-assistant'), { recursive: true })
  await writeFile(
    join(plugins, 'tenon.official.ai-assistant', 'manifest.json'),
    JSON.stringify({
      id: 'tenon.official.ai-assistant',
      name: 'AI 小助手',
      version: '1.0.0',
      description: '右下角悬浮球',
      source: 'bundled',
      minTenonVersion: '1.0.0',
      signature: null,
      permissions: ['fs:app'],
      agentHints: '用它，不要自己写聊天框',
      pricing: { type: 'free' },
      facets: { server: 'server.js', web: 'web.js' },
      slots: ['app.shell.overlay', 'app.api'],
    }),
    'utf8',
  )
  for (const name of ['server.js', 'web.js']) {
    await writeFile(join(plugins, 'tenon.official.ai-assistant', name), '// facet', 'utf8')
  }
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(home, { recursive: true, force: true })
})

async function start(): Promise<RunningServer> {
  running = await boot(home, { pluginRoots: roots() })
  return running
}

async function createApp(server: RunningServer): Promise<string> {
  const created = await rpc<{ app: { id: string } }>(server, 'app.create', {
    name: '组件测试',
    templateId: 'react-vite',
    styleId: null,
  })
  return created.app.id
}

function repoOf(appId: string): string {
  return appPaths(resolveHome({ TENON_HOME: home }), appId).repoDir
}

async function assemble(appId: string, assembly: unknown): Promise<void> {
  await writeFile(join(repoOf(appId), 'app.components.json'), JSON.stringify(assembly), 'utf8')
}

describe('component.list', () => {
  it('新应用没有装配声明：空列表，可安装里能看到官方组件', async () => {
    const server = await start()
    const appId = await createApp(server)
    const list = await rpc<ComponentList>(server, 'component.list', { appId })
    expect(list.components).toEqual([])
    expect(list.problems).toEqual([])
    expect(list.assemblyFile).toBe('app.components.json')
    expect(list.available).toMatchObject([
      { id: 'tenon.official.ai-assistant', version: '1.0.0', installed: false, source: 'bundled' },
    ])
  })

  it('装配之后：组件出现在列表里、标记为已装、带挂载点', async () => {
    const server = await start()
    const appId = await createApp(server)
    await assemble(appId, {
      components: [
        {
          id: 'tenon.official.ai-assistant',
          version: '^1.0.0',
          mount: [
            { slot: 'app.shell.overlay' },
            { slot: 'app.api', prefix: '/_c/assistant' },
          ],
        },
      ],
    })
    const list = await rpc<ComponentList>(server, 'component.list', { appId })
    expect(list.problems).toEqual([])
    expect(list.components).toHaveLength(1)
    expect(list.components[0]).toMatchObject({ id: 'tenon.official.ai-assistant', version: '1.0.0', loaded: true })
    expect(list.components[0]?.mounts).toEqual([
      { slot: 'app.shell.overlay', order: 100, prefix: null },
      { slot: 'app.api', order: 100, prefix: '/_c/assistant' },
    ])
    expect(list.available[0]?.installed).toBe(true)
  })

  it('装不上时说清原因，而不是 500', async () => {
    const server = await start()
    const appId = await createApp(server)
    await assemble(appId, {
      components: [{ id: 'tenon.official.ai-assistant', version: '^2.0.0', mount: [] }],
    })
    const list = await rpc<ComponentList>(server, 'component.list', { appId })
    expect(list.components).toEqual([])
    expect(list.problems).toMatchObject([{ code: 'version-unsatisfied', componentId: 'tenon.official.ai-assistant' }])
  })

  it('装配声明坏掉时也返回 200 + 一条 assembly-invalid（不是把插件页打成 500）', async () => {
    const server = await start()
    const appId = await createApp(server)
    await writeFile(join(repoOf(appId), 'app.components.json'), '{ oops', 'utf8')
    const list = await rpc<ComponentList>(server, 'component.list', { appId })
    expect(list.components).toEqual([])
    expect(list.problems[0]?.code).toBe('assembly-invalid')
  })

  it('没这个应用是 404（appId 写错不该表现成"没有组件"）', async () => {
    const server = await start()
    await expect(rpc(server, 'component.list', { appId: 'nope' })).rejects.toThrow()
  })
})
