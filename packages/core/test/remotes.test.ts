import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretBox, TenonDatabase } from '../src/index.js'
import { RemoteStore, assertSafeRemoteUrl } from '../src/stores/remotes.js'

let dir: string
let db: TenonDatabase
let box: SecretBox
let remotes: RemoteStore

const URL = 'https://github.com/me/my-app.git'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-remotes-'))
  db = TenonDatabase.open(join(dir, 'tenon.db'))
  box = SecretBox.open(join(dir, 'secret.key'))
  remotes = new RemoteStore(db, box)
  seedApp('app_a')
  seedApp('app_b')
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

/** app_remotes 有外键，先得有一行 app（CASCADE 那条测试也依赖它） */
function seedApp(id: string): void {
  const now = Date.now()
  db.run(
    `INSERT INTO apps (id, name, slug, template_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    id,
    id,
    'react-vite',
    'idle',
    now,
    now,
  )
}

describe('远端仓库与令牌（app_remotes）', () => {
  it('读回来只有"有没有"和尾四位，永远没有令牌明文', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'ghp_abcdefghijklmnop1234' })
    const remote = remotes.get('app_a')

    expect(remote?.url).toBe(URL)
    expect(remote?.hasToken).toBe(true)
    expect(remote?.tokenHint).toBe('…1234')
    // 整个结构里不许出现明文 —— 用 JSON 兜一遍，防止以后有人加字段时手滑
    expect(JSON.stringify(remote)).not.toContain('ghp_abcdefghijklmnop1234')
  })

  it('令牌在库里是密文，解出来才是原文（这条验的是"真的加密了"）', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'ghp_abcdefghijklmnop1234' })

    const row = db.get<{ token_enc: Uint8Array }>('SELECT token_enc FROM app_remotes WHERE app_id = ?', 'app_a')
    const raw = Buffer.from(row?.token_enc ?? new Uint8Array())
    expect(raw.toString('utf8')).not.toContain('ghp_')
    // 长度对得上才是"iv + tag + 密文"这套封装，不是被截断过
    expect(raw.byteLength).toBeGreaterThan(12 + 16)

    expect(remotes.reveal('app_a')?.token).toBe('ghp_abcdefghijklmnop1234')
  })

  it('换地址不逼人重填令牌；给了新令牌才覆盖', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'first-token' })

    // 不传 token：保持原样
    remotes.upsert({ appId: 'app_a', url: 'https://github.com/me/renamed.git' })
    expect(remotes.reveal('app_a')?.token).toBe('first-token')

    // 传了新的：覆盖
    remotes.upsert({ appId: 'app_a', url: 'https://github.com/me/renamed.git', token: 'second-token' })
    expect(remotes.reveal('app_a')?.token).toBe('second-token')
  })

  it('分支默认 main，可以改；空串回落成 main 而不是存一个空分支名', () => {
    expect(remotes.upsert({ appId: 'app_a', url: URL }).branch).toBe('main')
    expect(remotes.upsert({ appId: 'app_a', url: URL, branch: 'trunk' }).branch).toBe('trunk')
    expect(remotes.upsert({ appId: 'app_a', url: URL, branch: '   ' }).branch).toBe('main')
  })

  it('按应用隔离：A 的令牌不会被 B 读到', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'token-a' })
    remotes.upsert({ appId: 'app_b', url: 'https://github.com/me/other.git' })

    expect(remotes.reveal('app_a')?.token).toBe('token-a')
    expect(remotes.get('app_b')?.hasToken).toBe(false)
    expect(remotes.reveal('app_b')?.token).toBeNull()
  })

  it('clear 之后什么都没了（令牌不会留在库里）', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'token-a' })
    remotes.clear('app_a')

    expect(remotes.get('app_a')).toBeNull()
    expect(remotes.reveal('app_a')).toBeNull()
    const left = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_remotes WHERE app_id = ?', 'app_a')
    expect(left?.n).toBe(0)
  })

  it('删应用时凭据跟着消失（CASCADE，不留孤儿密文）', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'token-a' })
    db.run('DELETE FROM apps WHERE id = ?', 'app_a')

    const left = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_remotes WHERE app_id = ?', 'app_a')
    expect(left?.n).toBe(0)
  })

  it('密钥文件换了 ⇒ 表现为"没配令牌"，不是让发布页崩掉', () => {
    remotes.upsert({ appId: 'app_a', url: URL, token: 'token-a' })

    // 模拟换机器：同一份库，另一把密钥
    const another = new RemoteStore(db, SecretBox.open(join(dir, 'other-secret.key')))
    expect(another.get('app_a')?.hasToken).toBe(false)
    expect(another.reveal('app_a')?.token).toBeNull()
    // 地址还在 —— 只有令牌解不开，不该连"推到哪"都读不出来
    expect(another.get('app_a')?.url).toBe(URL)
  })
})

describe('远端地址校验', () => {
  it('只收 https —— http 会把令牌明文发出去', () => {
    expect(() => assertSafeRemoteUrl('http://github.com/me/app.git')).toThrowError(/https/)
  })

  it('拒绝把用户名密码写在地址里', () => {
    // 用户从别处粘过来时，往往没注意到自己把密码带进来了
    expect(() => assertSafeRemoteUrl('https://me:secret@github.com/me/app.git')).toThrowError(/用户名或密码/)
  })

  it('不是 URL 就直说，别让人对着"推送失败"猜', () => {
    expect(() => assertSafeRemoteUrl('github.com/me/app')).toThrowError(/不是合法 URL/)
  })
})
