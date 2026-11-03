/**
 * Hub 的接线（M6）：**装好之后加载器真的用上了它**，以及「有更新」这件事从索引一直走到界面。
 *
 * 单测里 hub.ts 已经把验签、落盘、索引、更新计划都验穿了，这里只问四件"跨层"的事：
 *   1. 未配置时是「未配置」而不是崩溃（官方 Hub 上线前就是这个状态）
 *   2. 装好之后 `component.list` 的版本变成 hub 那个 —— 说明装到了**加载器的 hub 根**
 *   3. `hub.check` 能看出"有新版"，`hub.install` 装完之后只有**真正会用上**的应用被重载
 *   4. 应用声明的区间不接受新版时，必须出现在 `blockedBy` 里（装了也不会被用）
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HUB_INDEX_FORMAT, signBundle, signHubIndex, type HubBundle, type HubIndexComponent } from '@tenon/component-host'
import { boot, rpc } from './support.js'
import type { RunningServer } from '../src/index.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const COMPONENT = 'tenon.official.ai-assistant'

let dir: string | undefined
let running: RunningServer | undefined
let hub: Server | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  if (hub !== undefined) {
    await new Promise<void>((resolve) => hub?.close(() => resolve()))
    hub = undefined
  }
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** 一个同名组件包：内容随便，加载器只认清单与文件在不在 */
function bundle(version = '1.1.0', tamper = false): HubBundle {
  const signed = signBundle(
    {
      format: 1,
      manifest: {
        id: COMPONENT,
        name: 'AI 小助手',
        version,
        description: 'Hub 上的新版',
        source: 'hub',
        minTenonVersion: '0.0.0',
        signature: null,
        permissions: [],
        agentHints: '这是 Hub 版的小助手。',
        pricing: { type: 'free' },
        facets: { server: 'server.js', web: 'web.js' },
        slots: ['app.shell.overlay'],
        dependencies: {},
      } as never,
      files: { 'server.js': `// hub ${version}`, 'web.js': `// hub ${version}` },
    },
    PRIVATE_PEM,
  )
  // 签名之后改内容 = 投毒；用来验"客户端真的会拒"
  return tamper ? { ...signed, files: { 'server.js': 'evil()', 'web.js': 'evil()' } } : signed
}

function indexOf(
  hubUrl: string,
  versions: readonly string[],
  options: { tamper?: boolean } = {},
): unknown {
  const components: HubIndexComponent[] = [
    {
      id: COMPONENT,
      name: 'AI 小助手',
      description: 'Hub 上的新版',
      // 故意倒序：客户端不许靠数组顺序取最新
      versions: [...versions].reverse().map((version) => ({
        version,
        url: `${hubUrl}/bundles/${version}.json`,
        notes: `${version} 的说明`,
        publishedAt: 1,
      })),
    },
  ]
  const signed = signHubIndex({ format: HUB_INDEX_FORMAT, generatedAt: 1, components }, PRIVATE_PEM)
  return options.tamper === true ? { ...signed, components: [] } : signed
}

interface HubHandle {
  readonly url: string
  /** 换一批版本（模拟"Hub 上又发了一版"） */
  setVersions(versions: readonly string[]): void
  setTampered(tampered: boolean): void
}

/**
 * 一个能发索引与包的假 Hub。
 *
 * `versions` 是**可变的**：更新这件事的本质就是"过一会儿 Hub 上多了一版"，
 * 用固定的索引测不出来。
 */
async function startHub(bundles: Record<string, unknown>, initial: readonly string[]): Promise<HubHandle> {
  let versions = initial
  let tampered = false
  hub = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/index.json') {
      const origin = `http://127.0.0.1:${(hub!.address() as AddressInfo).port}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(indexOf(origin, versions, { tamper: tampered })))
      return
    }
    const match = /^\/bundles\/(.+)\.json$/.exec(url)
    if (match !== null) {
      const payload = bundles[match[1] ?? '']
      if (payload !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => hub?.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
  return {
    url: base,
    setVersions(next) {
      versions = next
    },
    setTampered(value) {
      tampered = value
    },
  }
}

async function bootWithHub(hubUrl: string | null): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'tenon-hub-srv-'))
  running = await boot(dir, {
    env: {
      ...(hubUrl === null ? {} : { TENON_HUB_URL: hubUrl }),
      ...(hubUrl === null ? {} : { TENON_HUB_PUBLIC_KEY: PUBLIC_PEM.replaceAll('\n', '\\n') }),
    },
  })
}

/** 把随包那份（1.0.0）装进一个新应用：更新测试要先"装过" */
async function appWithBundled(version = '^1.0.0'): Promise<string> {
  const created = await rpc<{ app: { id: string } }>(running!, 'app.create', { name: 'Hub' })
  const appId = created.app.id
  const { installComponent } = await import('@tenon/component-host')
  const { appPaths, resolveHome } = await import('@tenon/core')
  const repoDir = appPaths(resolveHome({ TENON_HOME: dir! }), appId).repoDir
  await installComponent({
    repoDir,
    roots: [{ kind: 'bundled', dir: join(process.cwd(), 'plugins', 'bundled') }],
    tenonVersion: '0.0.0',
    id: COMPONENT,
    mounts: [{ slot: 'app.shell.overlay', order: 100 }],
    version,
  })
  return appId
}

describe('Hub 接线', () => {
  it('没配置时说"未配置"：status / check / install 三条都不崩', async () => {
    await bootWithHub(null)
    const status = await rpc<{ configured: boolean; hubUrl: string | null; keyFingerprint: string | null }>(
      running!,
      'hub.status',
    )
    expect(status).toEqual({ configured: false, hubUrl: null, keyFingerprint: null })

    // 未配置 → 检查更新是「没得查」，不是错误
    const check = await rpc<{ reachable: boolean; error: string | null; components: unknown[] }>(
      running!,
      'hub.check',
    )
    expect(check).toEqual({ reachable: false, error: null, checkedAt: expect.any(Number), keyFingerprint: null, components: [] })

    const response = await fetch(`${running!.url}/rpc/hub.install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ id: COMPONENT }),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('HUB_NOT_CONFIGURED')
  })

  it('装好之后加载器用的是 hub 版（覆盖层真的生效了）', async () => {
    const fake = await startHub({ '1.1.0': bundle('1.1.0') }, ['1.0.0', '1.1.0'])
    await bootWithHub(fake.url)

    const appId = await appWithBundled()
    const before = await rpc<{ components: { id: string; version: string }[] }>(running!, 'component.list', {
      appId,
    })
    expect(before.components[0]?.version).toBe('1.0.0')

    // 装之前：没装过 Hub 版，所以不算"有更新"
    const checkBefore = await rpc<{ reachable: boolean; components: { installedVersion: string | null; update: boolean; latest: string }[] }>(
      running!,
      'hub.check',
    )
    expect(checkBefore.reachable).toBe(true)
    expect(checkBefore.components[0]).toMatchObject({ installedVersion: null, latest: '1.1.0', update: false })

    const installed = await rpc<{ id: string; version: string; reloadedApps: number; keyFingerprint: string }>(
      running!,
      'hub.install',
      { id: COMPONENT },
    )
    expect(installed.version).toBe('1.1.0')
    expect(installed.keyFingerprint).toHaveLength(16)
    // 声明 ^1.0.0 接受 1.1.0 → 那个应用被重新激活（否则界面上还是旧版本）
    expect(installed.reloadedApps).toBe(1)

    const after = await rpc<{ components: { version: string; source: string }[] }>(running!, 'component.list', {
      appId,
    })
    expect(after.components[0]?.version).toBe('1.1.0')
    expect(after.components[0]?.source).toBe('hub')

    // 装完再检查：已经是最高版本，不再提示更新
    const checkAfter = await rpc<{ components: { installedVersion: string | null; update: boolean }[] }>(
      running!,
      'hub.check',
    )
    expect(checkAfter.components[0]).toMatchObject({ installedVersion: '1.1.0', update: false })
  })

  it('有新版时 check 报出来，install 之后版本真的变了', async () => {
    const bundles = { '1.1.0': bundle('1.1.0'), '1.2.0': bundle('1.2.0') }
    const fake = await startHub(bundles, ['1.0.0', '1.1.0'])
    await bootWithHub(fake.url)

    const appId = await appWithBundled()
    await rpc(running!, 'hub.install', { id: COMPONENT, version: '1.1.0' })

    // Hub 上又发了一版：此时应当提示"有更新"
    fake.setVersions(['1.0.0', '1.1.0', '1.2.0'])
    const check = await rpc<{
      components: { installedVersion: string | null; latest: string; update: boolean; notes: string | null }[]
    }>(running!, 'hub.check')
    expect(check.components[0]).toMatchObject({
      installedVersion: '1.1.0',
      latest: '1.2.0',
      update: true,
      notes: '1.2.0 的说明',
    })

    const installed = await rpc<{ version: string; reloadedApps: number }>(running!, 'hub.install', {
      id: COMPONENT,
    })
    expect(installed.version).toBe('1.2.0')
    expect(installed.reloadedApps).toBe(1)

    const after = await rpc<{ components: { version: string }[] }>(running!, 'component.list', { appId })
    expect(after.components[0]?.version).toBe('1.2.0')
  })

  it('应用的区间不接受新版 → blockedBy 里点名，且装完不重载它', async () => {
    const bundles = { '1.1.0': bundle('1.1.0'), '2.0.0': bundle('2.0.0') }
    const fake = await startHub(bundles, ['1.0.0', '1.1.0'])
    await bootWithHub(fake.url)

    const appId = await appWithBundled('^1.0.0')
    await rpc(running!, 'hub.install', { id: COMPONENT, version: '1.1.0' })
    // 之后 Hub 发了一个大版本：应用声明的是 ^1.0.0，用它不着
    fake.setVersions(['1.0.0', '1.1.0', '2.0.0'])

    const check = await rpc<{
      components: { latest: string; update: boolean; blockedBy: string[] }[]
    }>(running!, 'hub.check')
    expect(check.components[0]?.latest).toBe('2.0.0')
    expect(check.components[0]?.update).toBe(true)
    // ^1.0.0 不接受 2.0.0 —— 装了也不会被用，界面上必须说出来
    expect(check.components[0]?.blockedBy).toEqual([appId])

    const installed = await rpc<{ version: string; reloadedApps: number }>(running!, 'hub.install', {
      id: COMPONENT,
    })
    expect(installed.version).toBe('2.0.0')
    // 重载也没用（解析器只会挑 1.x），所以干脆不重载 —— 否则用户看到"更新了但没变"
    expect(installed.reloadedApps).toBe(0)

    const after = await rpc<{ components: { version: string }[] }>(running!, 'component.list', { appId })
    expect(after.components[0]?.version).toBe('1.1.0')
  })

  it('被改过的包 → 422（HUB_BAD_SIGNATURE），装不进去', async () => {
    const fake = await startHub({ '1.1.0': bundle('1.1.0', true) }, ['1.1.0'])
    await bootWithHub(fake.url)

    const response = await fetch(`${running!.url}/rpc/hub.install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ id: COMPONENT }),
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('HUB_BAD_SIGNATURE')
    // 错误信息要说人话，不能只有"失败"
    expect(body.error?.message ?? '').toContain('验签')
  })

  it('索引被改过 → 检查更新报"验签失败"，装也装不了', async () => {
    const fake = await startHub({ '1.1.0': bundle('1.1.0') }, ['1.1.0'])
    await bootWithHub(fake.url)
    // 索引在服务端每次检查时现取，所以"发布之后被改"也能模拟
    fake.setTampered(true)

    const check = await rpc<{ reachable: boolean; error: string | null; components: unknown[] }>(
      running!,
      'hub.check',
    )
    // 索引坏了 = 查不了更新。**不抛错**：插件页还得能用
    expect(check.reachable).toBe(false)
    expect(check.error ?? '').toContain('验签')
    expect(check.components).toEqual([])

    const response = await fetch(`${running!.url}/rpc/hub.install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ id: COMPONENT }),
    })
    expect(response.status).toBe(422)
  })

  it('Hub 上没有这个组件 → 说清楚，而不是静默 404', async () => {
    const fake = await startHub({}, ['1.0.0'])
    await bootWithHub(fake.url)

    const response = await fetch(`${running!.url}/rpc/hub.install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ id: 'tenon.official.nope' }),
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message ?? '').toContain('tenon.official.nope')
  })
})
