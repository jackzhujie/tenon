/**
 * 清单校验：**写错了必须拦住，而且要说清哪一行**。
 *
 * 这里最要紧的两条不是"字段缺失"，而是：
 * - 未知权限**必须拒绝**整份清单 —— 否则用户以为它只能读库，代码里它却能随便联网
 * - facet 路径不能跑出插件目录 —— 否则一个清单就能让宿主读到 `/etc/passwd`
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isKnownPermission, parseManifest, readManifest } from '../src/manifest.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-manifest-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 一份"最小但合法"的官方组件清单，用例按需改字段 */
function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tenon.official.ai-assistant',
    name: 'AI 小助手',
    version: '1.0.0',
    description: '在应用右下角放一个会聊天的助手',
    source: 'bundled',
    minTenonVersion: '1.0.0',
    signature: null,
    permissions: ['fs:app', 'net:fetch:api.openai.com'],
    agentHints: '用 tenon.official.ai-assistant 提供的悬浮球，不要自己写一个聊天框',
    pricing: { type: 'free' },
    facets: { server: 'server.js', web: 'web.js' },
    slots: ['app.shell.overlay', 'app.api'],
    ...overrides,
  }
}

describe('parseManifest', () => {
  it('最小合法清单通过', () => {
    const { manifest, issues } = parseManifest(valid())
    expect(issues).toEqual([])
    expect(manifest?.id).toBe('tenon.official.ai-assistant')
    expect(manifest?.dependencies).toEqual({})
  })

  it('缺 agentHints 被拒（没它 Agent 会绕过组件自己写一个）', () => {
    const { manifest, issues } = parseManifest(valid({ agentHints: undefined }))
    expect(manifest).toBeNull()
    expect(issues.join()).toContain('agentHints')
  })

  it('id 必须是反向域名', () => {
    const { issues } = parseManifest(valid({ id: 'AI-Assistant' }))
    expect(issues.join()).toContain('id')
  })

  it('未知权限被拒，且指出是哪一个', () => {
    const { manifest, issues } = parseManifest(valid({ permissions: ['fs:app', 'root:all'] }))
    expect(manifest).toBeNull()
    expect(issues.join()).toContain('root:all')
  })

  it('net:fetch:<域名> 是合法权限，裸 net:fetch 也合法', () => {
    expect(isKnownPermission('net:fetch')).toBe(true)
    expect(isKnownPermission('net:fetch:api.openai.com')).toBe(true)
    expect(isKnownPermission('net:fetch:api.openai.com:443')).toBe(true)
    expect(isKnownPermission('net:fetch:')).toBe(false)
    expect(isKnownPermission('net:upload:x.com')).toBe(false)
  })

  it('facet 路径不能跑出插件目录', () => {
    const { manifest, issues } = parseManifest(valid({ facets: { web: '../../etc/passwd' } }))
    expect(manifest).toBeNull()
    expect(issues.join()).toContain('插件目录内')
  })

  it('绝对路径同样被拒', () => {
    const { issues } = parseManifest(valid({ facets: { web: '/tmp/evil.js' } }))
    expect(issues.join()).toContain('插件目录内')
  })

  it('未知插槽被拒', () => {
    const { issues } = parseManifest(valid({ slots: ['app.shell.overlay', 'app.nowhere'] }))
    expect(issues.join()).toContain('app.nowhere')
  })

  it('重复权限 / 重复插槽被拒', () => {
    const { issues } = parseManifest(
      valid({ permissions: ['fs:app', 'fs:app'], slots: ['app.api', 'app.api'] }),
    )
    expect(issues.filter((i) => i.includes('重复')).length).toBe(2)
  })

  it('收费组件必须带 sku', () => {
    const { issues } = parseManifest(valid({ pricing: { type: 'paid' } }))
    expect(issues.join()).toContain('sku')
  })

  it('local 来源不该有签名', () => {
    const { issues } = parseManifest(valid({ source: 'local', signature: 'abc' }))
    expect(issues.join()).toContain('signature')
  })
})

describe('readManifest', () => {
  it('文件不存在时是 missing（不是错误）', async () => {
    expect((await readManifest(dir)).kind).toBe('missing')
  })

  it('不是合法 JSON 时是 invalid，并带上原因', async () => {
    await writeFile(join(dir, 'manifest.json'), '{ oops', 'utf8')
    const read = await readManifest(dir)
    expect(read.kind).toBe('invalid')
    if (read.kind === 'invalid') expect(read.issues.join()).toContain('JSON')
  })

  it('合法文件读得出来', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub', 'manifest.json'), JSON.stringify(valid()), 'utf8')
    const read = await readManifest(join(dir, 'sub'))
    expect(read.kind).toBe('ok')
  })
})
