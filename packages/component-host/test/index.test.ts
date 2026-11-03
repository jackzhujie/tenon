/**
 * Hub 索引（M6 第 2 步）：目录、最新版本判定、更新计划。
 *
 * 这一层最要紧的**不是**"能列出有什么"，而是三种"看起来正常但其实错"的判断：
 *
 * 1. 索引不签名 → 可以把"最新"指向一个旧的、确实签过名的版本，用户点更新就**降级**了。
 *    包签名拦不住这个，因为回滚到的包是合法的。
 * 2. 版本数组不保证有序 → `versions.at(-1)` 拿到的可能不是最新。
 * 3. 应用声明了 `^1.0.0` 而 Hub 上最新是 `2.0.0` → 装上去也不会被用（解析器只挑满足区间的），
 *    界面上却显示"已更新"，用户看到版本没变会以为功能坏了。
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HUB_INDEX_FORMAT,
  fetchHubIndex,
  hubIndexSigningBytes,
  hubIndexUrl,
  latestVersion,
  listInstalledHubComponents,
  planHubUpdates,
  signHubIndex,
  verifyHubIndex,
  type HubIndex,
  type HubIndexComponent,
} from '../src/hub.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const CONFIG = { hubUrl: 'https://hub.example.com', publicKey: PUBLIC_PEM }

function componentOf(overrides: Partial<HubIndexComponent> = {}): HubIndexComponent {
  return {
    id: 'tenon.official.hub-test',
    name: 'Hub 测试组件',
    description: '只在测试里存在',
    versions: [
      { version: '1.0.0', url: 'https://hub.example.com/a-1.0.0.json', notes: '首版', publishedAt: 1 },
    ],
    ...overrides,
  }
}

function indexOf(components: HubIndexComponent[], overrides: Partial<Omit<HubIndex, 'sig'>> = {}): HubIndex {
  return signHubIndex(
    { format: HUB_INDEX_FORMAT, generatedAt: 1_700_000_000_000, components, ...overrides },
    PRIVATE_PEM,
  )
}

let dir: string
let server: Server | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-index-'))
})

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  await rm(dir, { recursive: true, force: true })
})

async function startHub(payload: unknown): Promise<string> {
  server = createServer((req, res) => {
    if ((req.url ?? '') === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('索引验签', () => {
  it('签过的索引能验过，指纹是 16 位', () => {
    const result = verifyHubIndex(indexOf([componentOf()]), PUBLIC_PEM)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.index.components).toHaveLength(1)
    expect(result.value.keyFingerprint).toHaveLength(16)
  })

  it('改了"最新指向哪个地址"就验不过（降级攻击的入口）', () => {
    const signed = indexOf([componentOf()])
    const tampered: HubIndex = {
      ...signed,
      components: [
        {
          ...signed.components[0]!,
          versions: [
            { version: '0.9.0', url: 'https://evil.example.com/old.json', notes: '旧版', publishedAt: 0 },
          ],
        },
      ],
    }
    const result = verifyHubIndex(tampered, PUBLIC_PEM)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-signature')
  })

  it('没有签名直接拒，而且理由说的是"降级"', () => {
    const unsigned = { ...indexOf([componentOf()]), sig: '' }
    const result = verifyHubIndex(unsigned, PUBLIC_PEM)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-signature')
    expect(result.problem.hint ?? '').toContain('降级')
  })

  it('格式版本不对就拒（旧客户端不许猜着读）', () => {
    const result = verifyHubIndex({ ...indexOf([componentOf()]), format: 99 }, PUBLIC_PEM)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.message).toContain('99')
  })

  it('键序不影响验签（canonicalJson 的用处）', () => {
    const signed = indexOf([componentOf()])
    // 把每个对象的键顺序打乱再序列化：签名应当仍然有效
    const reordered = JSON.parse(
      JSON.stringify(signed, (_key, value: unknown) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse())
      }),
    ) as HubIndex
    expect(verifyHubIndex(reordered, PUBLIC_PEM).ok).toBe(true)
    // 而签名字节本身不随键序变
    expect(hubIndexSigningBytes(reordered).toString()).toBe(hubIndexSigningBytes(signed).toString())
  })
})

describe('下载索引', () => {
  it('地址固定是 <hubUrl>/index.json（不让调用方指定）', () => {
    expect(hubIndexUrl(CONFIG)).toBe('https://hub.example.com/index.json')
  })

  it('正常取回并验签', async () => {
    const url = await startHub(indexOf([componentOf()]))
    const result = await fetchHubIndex({ config: { ...CONFIG, hubUrl: url } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.index.components[0]?.id).toBe('tenon.official.hub-test')
  })

  it('404 → fetch-failed（不是"没有组件"）', async () => {
    const url = await startHub({})
    const result = await fetchHubIndex({ config: { ...CONFIG, hubUrl: `${url}/nope` } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('fetch-failed')
  })

  it('索引被改过 → bad-signature，且不返回任何组件', async () => {
    const signed = indexOf([componentOf()])
    const url = await startHub({ ...signed, generatedAt: 2 })
    const result = await fetchHubIndex({ config: { ...CONFIG, hubUrl: url } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.code).toBe('bad-signature')
  })
})

describe('最新版本', () => {
  it('不依赖数组顺序（索引是别人生成的，可能没排序）', () => {
    const component = componentOf({
      versions: [
        { version: '1.2.0', url: 'x', notes: null, publishedAt: null },
        { version: '1.10.0', url: 'y', notes: null, publishedAt: null },
        { version: '1.9.0', url: 'z', notes: null, publishedAt: null },
      ],
    })
    // 字符串比较会挑 1.9.0（"1.9" > "1.10"），语义比较才是 1.10.0
    expect(latestVersion(component)?.version).toBe('1.10.0')
  })

  it('空版本列表 → undefined（不抛）', () => {
    expect(latestVersion(componentOf({ versions: [] }))).toBeUndefined()
  })
})

describe('本机已装', () => {
  async function install(id: string, version: string): Promise<void> {
    const at = join(dir, id, version)
    await mkdir(at, { recursive: true })
    await writeFile(
      join(at, 'manifest.json'),
      // 清单校验要求 description / agentHints 非空 —— 缺了它就是"坏清单"，
      // 而 listInstalledHubComponents 会**跳过**坏清单（装不上的东西不算"已装"）
      JSON.stringify({
        id,
        name: id,
        version,
        description: '测试用',
        source: 'hub',
        minTenonVersion: '0.0.0',
        signature: null,
        permissions: [],
        agentHints: '测试用',
        pricing: { type: 'free' },
        facets: {},
        slots: [],
      }),
      'utf8',
    )
  }

  it('每个 id 取最高版本', async () => {
    await install('a.b', '1.0.0')
    await install('a.b', '1.2.0')
    await install('a.b', '1.1.0')
    expect(await listInstalledHubComponents(dir)).toEqual([{ id: 'a.b', version: '1.2.0' }])
  })

  it('清单坏掉的目录不算"已装"（装不上就不该出现在"有更新"里）', async () => {
    const at = join(dir, 'bad.one', '1.0.0')
    await mkdir(at, { recursive: true })
    await writeFile(join(at, 'manifest.json'), '{"id":"bad.one"}', 'utf8')
    expect(await listInstalledHubComponents(dir)).toEqual([])
  })

  it('目录不存在 → 空列表（第一次装之前就是它）', async () => {
    expect(await listInstalledHubComponents(join(dir, 'missing'))).toEqual([])
    expect(await listInstalledHubComponents('')).toEqual([])
  })
})

describe('更新计划', () => {
  it('没装过 → installedVersion 为 null，且不算更新', () => {
    const [plan] = planHubUpdates({ index: indexOf([componentOf()]), installed: [] })
    expect(plan).toMatchObject({ installedVersion: null, latest: '1.0.0', update: false })
  })

  it('装了旧版 → 有更新', () => {
    const [plan] = planHubUpdates({
      index: indexOf([componentOf({ versions: [
        { version: '1.2.0', url: 'x', notes: '修了个 bug', publishedAt: 2 },
        { version: '1.0.0', url: 'y', notes: null, publishedAt: 1 },
      ] })]),
      installed: [{ id: 'tenon.official.hub-test', version: '1.0.0' }],
    })
    expect(plan).toMatchObject({ installedVersion: '1.0.0', latest: '1.2.0', update: true, notes: '修了个 bug' })
  })

  it('本机比索引新 → **不算更新**（官方回滚或镜像过期时不能把人往旧版本推）', () => {
    const [plan] = planHubUpdates({
      index: indexOf([componentOf()]),
      installed: [{ id: 'tenon.official.hub-test', version: '1.5.0' }],
    })
    expect(plan).toMatchObject({ installedVersion: '1.5.0', latest: '1.0.0', update: false })
  })

  it('同版本 → 不算更新', () => {
    const [plan] = planHubUpdates({
      index: indexOf([componentOf()]),
      installed: [{ id: 'tenon.official.hub-test', version: '1.0.0' }],
    })
    expect(plan?.update).toBe(false)
  })

  it('应用声明 ^1.0.0 而最新是 2.0.0 → 列进 blockedBy（装了也不会被用）', () => {
    const [plan] = planHubUpdates({
      index: indexOf([componentOf({ versions: [{ version: '2.0.0', url: 'x', notes: null, publishedAt: 2 }] })]),
      installed: [{ id: 'tenon.official.hub-test', version: '1.0.0' }],
      declarations: [{ appId: 'app-1', id: 'tenon.official.hub-test', range: '^1.0.0' }],
    })
    expect(plan?.update).toBe(true)
    expect(plan?.blockedBy).toEqual(['app-1'])
  })

  it('区间接受 → blockedBy 为空', () => {
    const [plan] = planHubUpdates({
      index: indexOf([componentOf({ versions: [{ version: '1.5.0', url: 'x', notes: null, publishedAt: 2 }] })]),
      installed: [{ id: 'tenon.official.hub-test', version: '1.0.0' }],
      declarations: [{ appId: 'app-1', id: 'tenon.official.hub-test', range: '^1.0.0' }],
    })
    expect(plan?.blockedBy).toEqual([])
  })

  it('区间写法不认识 → 当作不接受（宁可少提示，也不推装不上的版本）', () => {
    const [plan] = planHubUpdates({
      index: indexOf([componentOf({ versions: [{ version: '1.5.0', url: 'x', notes: null, publishedAt: 2 }] })]),
      installed: [{ id: 'tenon.official.hub-test', version: '1.0.0' }],
      declarations: [{ appId: 'app-1', id: 'tenon.official.hub-test', range: '>=banana' }],
    })
    expect(plan?.blockedBy).toEqual(['app-1'])
  })

  it('装过的排在没装过的前面', () => {
    const plan = planHubUpdates({
      index: indexOf([
        componentOf({ id: 'z.not-installed', versions: [{ version: '1.0.0', url: 'x', notes: null, publishedAt: 1 }] }),
        componentOf({ id: 'a.installed', versions: [{ version: '1.0.0', url: 'y', notes: null, publishedAt: 1 }] }),
      ]),
      installed: [{ id: 'a.installed', version: '1.0.0' }],
    })
    expect(plan.map((item) => item.id)).toEqual(['a.installed', 'z.not-installed'])
  })
})
