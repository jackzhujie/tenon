import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretBox, TenonDatabase, openCore } from '../src/index.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-core-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('tenon.db（node:sqlite 产品库）', () => {
  it('打开即迁移到最新版本，且四张核心表都在', () => {
    const db = TenonDatabase.open(join(dir, 'tenon.db'))
    expect(db.schemaVersion).toBe(1)
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'apps',
        'error_groups',
        'provider_profiles',
        'releases',
        'settings',
      ]),
    )
    db.close()
  })

  it('重复打开不会重跑迁移（幂等）', () => {
    TenonDatabase.open(join(dir, 'tenon.db')).close()
    const db = TenonDatabase.open(join(dir, 'tenon.db'))
    expect(db.schemaVersion).toBe(1)
    db.close()
  })
})

describe('SecretBox', () => {
  it('密文往返一致，且密文里不含明文', () => {
    const box = SecretBox.open(join(dir, 'secret.key'))
    const plaintext = 'sk-tenon-test-1234567890'
    const sealed = box.seal(plaintext)
    expect(sealed.toString('utf8')).not.toContain(plaintext)
    expect(box.unseal(sealed)).toBe(plaintext)
  })

  it('换一个密钥文件就解不开（不是静默返回空串）', () => {
    const first = SecretBox.open(join(dir, 'a.key'))
    const sealed = first.seal('secret')
    const second = SecretBox.open(join(dir, 'b.key'))
    expect(() => second.unseal(sealed)).toThrowError(/无法解密/)
  })
})

describe('应用注册表', () => {
  it('建应用会落库、建目录、git init 并产生首个 commit', async () => {
    const core = openCore({ env: { TENON_HOME: join(dir, 'home') } })
    try {
      const app = await core.apps.create({
        name: '商品管理',
        templateId: 'blank',
        styleId: null,
      })
      expect(app.name).toBe('商品管理')
      expect(core.apps.list()).toHaveLength(1)

      const { appPaths } = await import('../src/index.js')
      const paths = appPaths(core.home, app.id)
      const { gitops } = await import('../src/index.js')
      const commits = await gitops.log(paths.repoDir, 5)
      expect(commits).toHaveLength(1)
      expect(commits[0]?.message).toContain('初始化应用')
    } finally {
      core.close()
    }
  })

  it('重名会拿到不同 slug，删除会清掉目录', async () => {
    const core = openCore({ env: { TENON_HOME: join(dir, 'home') } })
    const a = await core.apps.create({ name: 'todo', templateId: 'blank', styleId: null })
    const b = await core.apps.create({ name: 'todo', templateId: 'blank', styleId: null })
    expect(a.slug).toBe('todo')
    expect(b.slug).toBe('todo-2')

    await core.apps.delete(a.id)
    expect(core.apps.find(a.id)).toBeUndefined()

    const { appPaths } = await import('../src/index.js')
    const { existsSync } = await import('node:fs')
    expect(existsSync(appPaths(core.home, a.id).dir)).toBe(false)
    core.close()
  })

  it('不存在的应用抛 APP_NOT_FOUND（不是返回 undefined 让上层崩）', () => {
    const core = openCore({ env: { TENON_HOME: join(dir, 'home') } })
    expect(() => core.apps.require('app_nope')).toThrowError(/应用不存在/)
    core.close()
  })
})
