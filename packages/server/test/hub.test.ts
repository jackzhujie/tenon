/**
 * Hub 的接线（M6）：**装好之后加载器真的用上了它**。
 *
 * 单测里 hub.ts 已经把验签与落盘验穿了，这里只问三件"跨层"的事：
 *   1. 未配置时是「未配置」而不是崩溃（官方 Hub 上线前就是这个状态）
 *   2. 装好之后 `component.list` 的版本变成 hub 那个 —— 说明装到了**加载器的 hub 根**，
 *      而不是某个只有安装器自己知道的地方（这种错最费劲：装的时候一切正常）
 *   3. 装了它的应用会被重新激活（reloadedApps），否则用户点了更新、界面上还是旧版本
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signBundle, type HubBundle } from '@tenon/component-host'
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

/** 一个 1.1.0 的同名组件包：内容随便，加载器只认清单与文件在不在 */
function bundle(version = '1.1.0'): HubBundle {
  return signBundle(
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
}

async function startHub(payload: unknown): Promise<string> {
  hub = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/bundles/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => hub?.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
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

describe('Hub 接线', () => {
  it('没配置时说"未配置"，不是报错', async () => {
    await bootWithHub(null)
    const status = await rpc<{ configured: boolean; hubUrl: string | null; keyFingerprint: string | null }>(
      running!,
      'hub.status',
    )
    expect(status).toEqual({ configured: false, hubUrl: null, keyFingerprint: null })

    const response = await fetch(`${running!.url}/rpc/hub.install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ bundleUrl: 'https://example.com/x.json' }),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('HUB_NOT_CONFIGURED')
  })

  it('装好之后加载器用的是 hub 版（覆盖层真的生效了）', async () => {
    const hubUrl = await startHub(bundle())
    await bootWithHub(hubUrl)

    // 先装随包的那份（1.0.0）
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
    })
    const before = await rpc<{ components: { id: string; version: string }[] }>(
      running!,
      'component.list',
      { appId },
    )
    expect(before.components[0]?.version).toBe('1.0.0')

    // 从 Hub 装 1.1.0
    const installed = await rpc<{ id: string; version: string; reloadedApps: number; keyFingerprint: string }>(
      running!,
      'hub.install',
      { bundleUrl: `${hubUrl}/bundles/ai.json` },
    )
    expect(installed.version).toBe('1.1.0')
    expect(installed.keyFingerprint).toHaveLength(16)
    // 装完之后那个应用被重新激活了一次（否则界面上还是旧版本）
    expect(installed.reloadedApps).toBe(1)

    const after = await rpc<{ components: { id: string; version: string; source: string }[] }>(
      running!,
      'component.list',
      { appId },
    )
    expect(after.components[0]?.version).toBe('1.1.0')
    expect(after.components[0]?.source).toBe('hub')
  })

  it('被改过的包 → 422（HUB_BAD_SIGNATURE），装不进去', async () => {
    const good = bundle()
    const hubUrl = await startHub({ ...good, files: { 'server.js': 'evil()', 'web.js': 'evil()' } })
    await bootWithHub(hubUrl)

    const response = await fetch(`${running!.url}/rpc/hub.install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ bundleUrl: `${hubUrl}/bundles/ai.json` }),
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('HUB_BAD_SIGNATURE')
    // 错误信息要说人话，不能只有"失败"
    expect(body.error?.message ?? '').toContain('验签')
  })
})
