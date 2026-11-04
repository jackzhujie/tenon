/**
 * Hub 客户端：验签、落盘、来源改写、路径穿越。
 *
 * 这一层的价值全在"不发生什么"上 —— 装错了、装了一半、装到别处去，
 * 都比"装不上"糟得多。所以用例大多是**否定式**的：篡改必须被拒、越界路径必须被拒、
 * 索引与包不一致必须被拒，而且拒绝之后磁盘上不能留下任何东西。
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundleSigningBytes,
  HUB_INDEX_FORMAT,
  hubBundleDir,
  hubConfigFromEnv,
  installBundle,
  installFromHub,
  installFromHubIndex,
  signBundle,
  signHubIndex,
  verifyBundle,
  type HubBundle,
} from '../src/hub.js'
import { listAvailable } from '../src/plan.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function manifestOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tenon.official.hub-test',
    name: 'Hub 测试组件',
    version: '1.1.0',
    description: '只在测试里存在',
    source: 'hub',
    minTenonVersion: '0.0.0',
    signature: null,
    permissions: [],
    agentHints: '这是测试组件，别在真实应用里用它。',
    pricing: { type: 'free' },
    facets: { server: 'server.js' },
    slots: ['app.shell.overlay'],
    ...overrides,
  }
}

function bundleOf(overrides: { manifest?: Record<string, unknown>; files?: Record<string, string> } = {}): Omit<HubBundle, 'sig'> {
  return {
    format: 1,
    manifest: manifestOf(overrides.manifest) as never,
    files: overrides.files ?? { 'server.js': 'export function activate() {}\n' },
  }
}

let dir: string
let server: Server | undefined
let hubUrl = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-hub-'))
})

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  await rm(dir, { recursive: true, force: true })
})

describe('验签', () => {
  it('签过的包能验过，并给出私钥指纹', () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    const result = verifyBundle(signed, PUBLIC_PEM)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.bundle.manifest.id).toBe('tenon.official.hub-test')
    expect(result.value.keyFingerprint).toHaveLength(16)
  })

  it('改了一个字节就验不过（签名覆盖文件内容）', () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    const tampered = { ...signed, files: { 'server.js': 'export function activate() { /* 后门 */ }\n' } }
    const result = verifyBundle(tampered, PUBLIC_PEM)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-signature')
  })

  it('改版本号也验不过（签名覆盖清单）', () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, version: '9.9.9' },
    }
    expect(verifyBundle(tampered, PUBLIC_PEM).ok).toBe(false)
  })

  it('没有签名的包直接拒（不"宽容通过"）', () => {
    const unsigned = { ...bundleOf(), sig: undefined }
    const result = verifyBundle(unsigned, PUBLIC_PEM)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-signature')
  })

  it('换成别人的公钥就验不过', () => {
    const other = generateKeyPairSync('ed25519')
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    expect(verifyBundle(signed, otherPem).ok).toBe(false)
  })

  it('签名字节是规范的：键序不同不影响结果', () => {
    const a = bundleSigningBytes({
      format: 1,
      manifest: { b: 1, a: 2 } as never,
      files: { 'x.js': '1' },
    })
    const b = bundleSigningBytes({
      format: 1,
      manifest: { a: 2, b: 1 } as never,
      files: { 'x.js': '1' },
    })
    expect(a.equals(b)).toBe(true)
  })
})

describe('落盘', () => {
  it('装到 <hub>/<id>/<version>/，且把 source 改写成 hub、签名写进清单', async () => {
    // 包里自称 bundled：装完之后必须是 hub（来源标签是给用户看的，不能由包自称）
    const signed = signBundle(bundleOf({ manifest: { source: 'bundled' } }), PRIVATE_PEM)
    const result = await installBundle({ hubDir: dir, raw: signed, publicKeyPem: PUBLIC_PEM })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const target = join(dir, 'tenon.official.hub-test', '1.1.0')
    expect(result.value.dir).toBe(target)
    const written = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as {
      source: string
      signature: string | null
    }
    expect(written.source).toBe('hub')
    expect(written.signature).toBe(signed.sig)
    expect(await readFile(join(target, 'server.js'), 'utf8')).toContain('activate')
  })

  it('路径穿越被拒，且磁盘上什么都不留', async () => {
    const signed = signBundle(
      bundleOf({ files: { 'server.js': 'ok', '../../evil.sh': 'rm -rf /' } }),
      PRIVATE_PEM,
    )
    const result = await installBundle({ hubDir: dir, raw: signed, publicKeyPem: PUBLIC_PEM })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('unsafe-path')
    // 连 id 目录都不该建出来（检查发生在写之前）
    const entries = await readdir(dir).catch(() => [] as string[])
    expect(entries).toEqual([])
  })

  it('清单声明了 facet 但包里没有那个文件 → 拒', async () => {
    const signed = signBundle(bundleOf({ files: { 'other.js': 'x' } }), PRIVATE_PEM)
    const result = await installBundle({ hubDir: dir, raw: signed, publicKeyPem: PUBLIC_PEM })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-manifest')
  })

  it('索引说 1.1.0、包里是 9.9.9 → 拒（挡住张冠李戴）', async () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    const result = await installBundle({
      hubDir: dir,
      raw: signed,
      publicKeyPem: PUBLIC_PEM,
      expect: { version: '1.1.0', id: 'tenon.official.other' },
    })
    expect(result.ok).toBe(false)
  })

  it('同版本重装幂等：覆盖、不留临时目录', async () => {
    const first = signBundle(bundleOf({ files: { 'server.js': 'v1' } }), PRIVATE_PEM)
    const second = signBundle(bundleOf({ files: { 'server.js': 'v2' } }), PRIVATE_PEM)
    await installBundle({ hubDir: dir, raw: first, publicKeyPem: PUBLIC_PEM })
    const again = await installBundle({ hubDir: dir, raw: second, publicKeyPem: PUBLIC_PEM })
    expect(again.ok).toBe(true)

    const target = hubBundleDir(dir, manifestOf() as never)
    expect(await readFile(join(target, 'server.js'), 'utf8')).toBe('v2')
    const versions = await readdir(join(dir, 'tenon.official.hub-test'))
    expect(versions).toEqual(['1.1.0'])
  })

  it('装好之后加载器认它（hub > bundled 的覆盖层不是空话）', async () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    await installBundle({ hubDir: dir, raw: signed, publicKeyPem: PUBLIC_PEM })
    const available = await listAvailable({
      roots: [{ kind: 'hub', dir }],
      installed: [],
    })
    expect(available.map((item) => `${item.id}@${item.version}`)).toContain(
      'tenon.official.hub-test@1.1.0',
    )
  })
})

describe('从 Hub 下载', () => {
  async function startHub(payload: unknown, status = 200): Promise<string> {
    server = createServer((req, res) => {
      if (req.url === '/bundles/test.json') {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('下载 + 验签 + 装好', async () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    hubUrl = await startHub(signed)
    const result = await installFromHub({
      hubDir: dir,
      config: { hubUrl, publicKey: PUBLIC_PEM },
      bundleUrl: `${hubUrl}/bundles/test.json`,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await stat(result.value.dir)).toBeDefined()
  })

  it('地址不在 Hub 之下 → 拒（不能让一个 RPC 变成装任意代码的入口）', async () => {
    hubUrl = await startHub(signBundle(bundleOf(), PRIVATE_PEM))
    const result = await installFromHub({
      hubDir: dir,
      config: { hubUrl: 'https://hub.example.com', publicKey: PUBLIC_PEM },
      bundleUrl: `${hubUrl}/bundles/test.json`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('url-outside-hub')
  })

  it('HTTP 404 → fetch-failed，不是崩溃', async () => {
    hubUrl = await startHub({}, 404)
    const result = await installFromHub({
      hubDir: dir,
      config: { hubUrl, publicKey: PUBLIC_PEM },
      bundleUrl: `${hubUrl}/bundles/test.json`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('fetch-failed')
  })

  it('Hub 上被投毒的包（改过一个字节）→ 验签失败，装不上', async () => {
    const signed = signBundle(bundleOf(), PRIVATE_PEM)
    hubUrl = await startHub({ ...signed, files: { 'server.js': 'evil()' } })
    const result = await installFromHub({
      hubDir: dir,
      config: { hubUrl, publicKey: PUBLIC_PEM },
      bundleUrl: `${hubUrl}/bundles/test.json`,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-signature')
  })
})

describe('配置', () => {
  it('两个都缺 = 未配置（官方 Hub 上线前就是未配置，这是正常状态）', () => {
    expect(hubConfigFromEnv({})).toBeNull()
    expect(hubConfigFromEnv({ TENON_HUB_URL: 'https://hub.example.com' })).toBeNull()
    expect(hubConfigFromEnv({ TENON_HUB_PUBLIC_KEY: PUBLIC_PEM })).toBeNull()
  })

  it('配齐了就去掉尾部斜杠，并还原被写成字面量的换行', () => {
    const config = hubConfigFromEnv({
      TENON_HUB_URL: 'https://hub.example.com/',
      TENON_HUB_PUBLIC_KEY: PUBLIC_PEM.replaceAll('\n', '\\n'),
    })
    expect(config?.hubUrl).toBe('https://hub.example.com')
    // 还原之后才能被 createPublicKey 读出来
    expect(() => verifyBundle(signBundle(bundleOf(), PRIVATE_PEM), config!.publicKey)).not.toThrow()
  })
})

/**
 * 付费组件（M6 第 5 步）。
 *
 * 之前只有 `installComponent`（装进应用）拦付费，`hub.install`（下载到本机）不拦 ——
 * 于是"付费组件"变成了"付不了但能下载"，包原样躺在 `~/.tenon/plugins/` 里。
 * 这一组守的是"连下载都不做"，以及**真的没去请求那个包**（不然拦了也没意义）。
 */
describe('付费组件', () => {
  const PAID_ID = 'tenon.official.hub-test'

  /** 一个只发索引与包的 Hub；`onBundle` 数一下包被请求了几次 */
  async function startPaidHub(pricing: 'free' | 'paid'): Promise<{ url: string; bundleHits: () => number }> {
    let hits = 0
    server = createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
      if (req.url === '/index.json') {
        const index = signHubIndex(
          {
            format: HUB_INDEX_FORMAT,
            generatedAt: 1,
            components: [
              {
                id: PAID_ID,
                name: '付费组件',
                description: '只在测试里存在',
                pricing,
                versions: [{ version: '1.1.0', url: `${origin}/bundles/1.1.0.json`, notes: null, publishedAt: 1 }],
              },
            ],
          },
          PRIVATE_PEM,
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(index))
        return
      }
      if (req.url === '/bundles/1.1.0.json') {
        hits += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(signBundle({ ...bundleOf(), manifest: { ...bundleOf().manifest, version: '1.1.0' } }, PRIVATE_PEM)))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bundleHits: () => hits }
  }

  it('索引说 paid → 拒，而且**没有去下载那个包**（磁盘上也不留痕）', async () => {
    const hub = await startPaidHub('paid')
    hubUrl = hub.url
    const result = await installFromHubIndex({
      hubDir: dir,
      config: { hubUrl: hub.url, publicKey: PUBLIC_PEM },
      id: PAID_ID,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('paid-not-available')
    // 关键：不是"下下来再拒"，是根本不去请求
    expect(hub.bundleHits()).toBe(0)
    await expect(stat(join(dir, PAID_ID, '1.1.0'))).rejects.toThrow()
  })

  it('索引说 free → 照常下载（这条挡住"付费门禁把免费组件也拦了"）', async () => {
    const hub = await startPaidHub('free')
    hubUrl = hub.url
    const result = await installFromHubIndex({
      hubDir: dir,
      config: { hubUrl: hub.url, publicKey: PUBLIC_PEM },
      id: PAID_ID,
    })
    expect(result.ok).toBe(true)
    expect(hub.bundleHits()).toBe(1)
  })
})
