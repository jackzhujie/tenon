/**
 * 组件商店（M6 第 3 步）：`component.install` / `component.remove` 与付费门禁。
 *
 * 这一层有三件容易做错的事，用例大多围着它们：
 *
 * 1. **"装进应用"必须和 Agent 走同一条路**（写声明 + 同步 `docs/AGENTS.md`）。
 *    少写一处，Agent 就"不知道有这个组件" —— 界面上看着装了，对话里它还是会自己写一个。
 * 2. **本机没有包时先下载再装**。顺序反了会变成"商店里的组件一律装不上，除非先去别处下"。
 * 3. **付费组件**：现在没有购买流程，所以装不了。门禁放在唯一入口里，
 *    否则"Agent 能装、界面不能装"就是一个绕过。
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signBundle, type HubBundle } from '@tenon/component-host'
import { startFakeHub, type FakeHub } from './fake-hub.js'
import { boot, rpc } from './support.js'
import type { RunningServer } from '../src/index.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

interface ManifestSpec {
  readonly id: string
  readonly version: string
  readonly name?: string
  readonly pricing?: { type: 'free' } | { type: 'paid'; sku: string }
}

function manifestOf(spec: ManifestSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    version: spec.version,
    description: '测试用组件',
    source: 'bundled',
    minTenonVersion: '0.0.0',
    signature: null,
    permissions: [],
    agentHints: '这是测试组件。',
    pricing: spec.pricing ?? { type: 'free' },
    facets: { server: 'server.js', web: 'web.js' },
    slots: ['app.shell.overlay'],
  }
}

/** 往一个**只读根**（bundled）里放一个组件：`<root>/<id>/manifest.json` */
async function writePlugin(root: string, spec: ManifestSpec): Promise<void> {
  const at = join(root, spec.id)
  await mkdir(at, { recursive: true })
  await writeFile(join(at, 'manifest.json'), JSON.stringify(manifestOf(spec), null, 2), 'utf8')
  await writeFile(join(at, 'server.js'), 'export function activate() {}\n', 'utf8')
  await writeFile(join(at, 'web.js'), '/* web */\n', 'utf8')
}

function bundleOf(spec: ManifestSpec): HubBundle {
  return signBundle(
    {
      format: 1,
      manifest: { ...manifestOf(spec), source: 'hub' } as never,
      files: { 'server.js': 'export function activate() {}\n', 'web.js': '/* web */\n' },
    },
    PRIVATE_PEM,
  )
}

let dir: string | undefined
let running: RunningServer | undefined
let hub: FakeHub | undefined
const cleanup: string[] = []

afterEach(async () => {
  await running?.close()
  running = undefined
  if (hub !== undefined) {
    await hub.close()
    hub = undefined
  }
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

/** 一个只读的组件根（相当于随包的那份） */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-store-root-'))
  cleanup.push(root)
  return root
}

async function bootWith(options: { roots: string[]; hubUrl?: string }): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'tenon-store-'))
  running = await boot(dir, {
    /*
     * ★ hub 根**必须**在列表里，而且排在 bundled 前面（与 `pluginRoots()` 一致）。
     * 少写它的话，从 Hub 下载的包装到了 <home>/plugins 却"谁也没看见" ——
     * 表现就是"下载成功了，但装不上"，而磁盘上文件明明都在（就是这条陷阱）。
     */
    pluginRoots: [
      { kind: 'hub' as const, dir: join(dir, 'plugins') },
      ...options.roots.map((path) => ({ kind: 'bundled' as const, dir: path })),
    ],
    env:
      options.hubUrl === undefined
        ? {}
        : {
            TENON_HUB_URL: options.hubUrl,
            TENON_HUB_PUBLIC_KEY: PUBLIC_PEM.replaceAll('\n', '\\n'),
          },
  })
  const created = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '商店' })
  return created.app.id
}

describe('组件商店', () => {
  it('本机有包 → 装进应用，装配声明与 AGENTS.md 一起写', async () => {
    const root = await makeRoot()
    await writePlugin(root, { id: 'test.alpha', version: '1.0.0' })
    const appId = await bootWith({ roots: [root] })

    const installed = await rpc<{
      components: { id: string; version: string; enabled: boolean }[]
      problems: unknown[]
      downloaded: boolean
    }>(running!, 'component.install', { appId, id: 'test.alpha' })

    expect(installed.components).toEqual([
      expect.objectContaining({ id: 'test.alpha', version: '1.0.0', enabled: true }),
    ])
    expect(installed.problems).toEqual([])
    // 本机就有，不该走网络
    expect(installed.downloaded).toBe(false)

    // 两处都要有：少写一处，Agent 就不知道有这个组件
    const repoDir = join(dir!, 'apps', appId, 'repo')
    const assembly = await readFile(join(repoDir, 'app.components.json'), 'utf8')
    expect(assembly).toContain('test.alpha')
    expect(await readFile(join(repoDir, 'docs', 'AGENTS.md'), 'utf8')).toContain('test.alpha')
  })

  it('再装一次是幂等的（同 id 整条替换，不长两条）', async () => {
    const root = await makeRoot()
    await writePlugin(root, { id: 'test.alpha', version: '1.0.0' })
    const appId = await bootWith({ roots: [root] })

    await rpc(running!, 'component.install', { appId, id: 'test.alpha' })
    const again = await rpc<{ components: unknown[] }>(running!, 'component.install', {
      appId,
      id: 'test.alpha',
    })
    expect(again.components).toHaveLength(1)
  })

  it('本机没有、Hub 已配置 → 先下载再装（downloaded=true）', async () => {
    const root = await makeRoot()
    hub = await startFakeHub({
      componentId: 'test.from-hub',
      privateKeyPem: PRIVATE_PEM,
      bundles: { '2.0.0': bundleOf({ id: 'test.from-hub', version: '2.0.0' }) },
      versions: ['2.0.0'],
    })
    const appId = await bootWith({ roots: [root], hubUrl: hub.url })

    const installed = await rpc<{
      components: { id: string; version: string; source: string }[]
      downloaded: boolean
    }>(running!, 'component.install', { appId, id: 'test.from-hub' })

    expect(installed.downloaded).toBe(true)
    expect(installed.components[0]).toMatchObject({
      id: 'test.from-hub',
      version: '2.0.0',
      // 来源由装到哪决定，不由包自称
      source: 'hub',
    })
  })

  it('本机没有、Hub 也没配 → 说"找不到"，不是 500', async () => {
    const root = await makeRoot()
    const appId = await bootWith({ roots: [root] })

    const result = await rpc<{ problems: { code: string; message: string }[]; downloaded: boolean }>(
      running!,
      'component.install',
      { appId, id: 'test.nope' },
    )
    expect(result.downloaded).toBe(false)
    expect(result.problems[0]?.code).toBe('missing')
    expect(result.problems[0]?.message ?? '').toContain('test.nope')
  })

  it('付费组件装不上：paid-not-available，装配声明里不留痕', async () => {
    const root = await makeRoot()
    await writePlugin(root, {
      id: 'test.paid',
      version: '1.0.0',
      pricing: { type: 'paid', sku: 'tenon.test.paid' },
    })
    const appId = await bootWith({ roots: [root] })

    const result = await rpc<{ problems: { code: string; message: string; hint: string | null }[] }>(
      running!,
      'component.install',
      { appId, id: 'test.paid' },
    )
    expect(result.problems[0]?.code).toBe('paid-not-available')
    // 说清"为什么"，以及"什么时候会有"
    expect(result.problems[0]?.message ?? '').toContain('付费')
    expect(result.problems[0]?.hint ?? '').toContain('购买')

    // 装不上就该一个字节都不写
    const repoDir = join(dir!, 'apps', appId, 'repo')
    const assembly = await readFile(join(repoDir, 'app.components.json'), 'utf8').catch(() => '')
    expect(assembly).not.toContain('test.paid')
  })

  it('卸掉之后回到"可安装"，重复卸是幂等', async () => {
    const root = await makeRoot()
    await writePlugin(root, { id: 'test.alpha', version: '1.0.0' })
    const appId = await bootWith({ roots: [root] })
    await rpc(running!, 'component.install', { appId, id: 'test.alpha' })

    const removed = await rpc<{ components: unknown[]; removed: boolean }>(
      running!,
      'component.remove',
      { appId, id: 'test.alpha' },
    )
    expect(removed.removed).toBe(true)
    expect(removed.components).toEqual([])

    const list = await rpc<{ available: { id: string; installed: boolean }[] }>(
      running!,
      'component.list',
      { appId },
    )
    expect(list.available.find((item) => item.id === 'test.alpha')?.installed).toBe(false)

    const again = await rpc<{ removed: boolean }>(running!, 'component.remove', {
      appId,
      id: 'test.alpha',
    })
    expect(again.removed).toBe(false)
  })

  it('Agent 的 install_component 也能装 Hub 上的组件（同一个入口，不会"商店能装、Agent 装不了"）', async () => {
    const root = await makeRoot()
    hub = await startFakeHub({
      componentId: 'test.from-hub',
      privateKeyPem: PRIVATE_PEM,
      bundles: { '2.0.0': bundleOf({ id: 'test.from-hub', version: '2.0.0' }) },
      versions: ['2.0.0'],
    })
    const appId = await bootWith({ roots: [root], hubUrl: hub.url })

    const session = await running!.agent.pool?.acquire(appId)
    const tool = session?.rootTools.find((item) => item.name === 'install_component')
    expect(tool).toBeDefined()

    const result = (await tool!.execute({ id: 'test.from-hub' } as never, {} as never, {} as never)) as {
      isError?: boolean
      output: { text: string }[]
    }
    const text = result.output.map((part) => part.text).join('')
    expect(result.isError).toBeFalsy()
    // 说清"这次是从 Hub 下的"——模型会把这句话转述给用户
    expect(text).toContain('downloaded from the Hub')

    const list = await rpc<{ components: { id: string; version: string; source: string }[] }>(
      running!,
      'component.list',
      { appId },
    )
    expect(list.components[0]).toMatchObject({ id: 'test.from-hub', version: '2.0.0', source: 'hub' })
  })

  it('装到别的应用不影响这个应用（装配声明是每个应用自己的）', async () => {
    const root = await makeRoot()
    await writePlugin(root, { id: 'test.alpha', version: '1.0.0' })
    const appId = await bootWith({ roots: [root] })
    const other = await rpc<{ app: { id: string } }>(running!, 'app.create', { name: '另一个' })

    await rpc(running!, 'component.install', { appId, id: 'test.alpha' })

    const list = await rpc<{ components: unknown[] }>(running!, 'component.list', {
      appId: other.app.id,
    })
    expect(list.components).toEqual([])
    // 但"可安装"里能看到它 —— 包在本机是全局的
    const available = await rpc<{ available: { id: string }[] }>(running!, 'component.list', {
      appId: other.app.id,
    })
    expect(available.available.map((item) => item.id)).toContain('test.alpha')
  })
})
