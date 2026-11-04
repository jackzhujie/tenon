/**
 * 组件的存储能力（M6 第 4 步）：**数据活过重启，且跨应用 / 跨组件互不可见**。
 *
 * 这里用**真的审批流组件**（`plugins/bundled/.../server.js`）+ 真的产品库
 * （`openCore` 的 sqlite），不写夹具 —— 因为这一步要证明的正是"那个假持久化的组件
 * 现在真持久化了"。
 *
 * "重启"怎么模拟：关掉旧的 chord host，用**新的** host + **新的** storage 再
 * `activate()` 一次，中间只共享产品库。对象、闭包、内存里的东西全部重建，
 * 能读到的东西只能来自存储。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHost, memoryLinkPair, type Host } from '@earendil-works/chord'
import { createComponentStorage, type ComponentStorage } from '@tenon/component-host'
import { openCore, type CoreServices } from '@tenon/core'
import { boot } from './support.js'
import { activate } from '../../../plugins/bundled/tenon.official.approval/server.js'
import { Approval } from '../../../plugins/bundled/tenon.official.approval/contract.js'
import { ComponentRuntime, type Principal } from '../src/components.js'

const COMPONENT = 'tenon.official.approval'
const PERMISSIONS = ['db:read', 'db:write']

let dir: string
let core: CoreServices
const hosts: Host<unknown>[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-storage-'))
  core = openCore({ env: { TENON_HOME: dir } })
})

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {})
  core.close()
  await rm(dir, { recursive: true, force: true })
})

/** 宿主在这一步做的事：把命名空间绑进闭包，再把面门交给组件 */
function storageFor(appId: string, permissions: readonly string[] = PERMISSIONS): ComponentStorage | undefined {
  return createComponentStorage({
    backend: {
      read: (key) => core.components.get(appId, COMPONENT, key),
      write: (key, value) => core.components.set(appId, COMPONENT, key, value),
      remove: (key) => core.components.delete(appId, COMPONENT, key),
      keys: (prefix) => core.components.keys(appId, COMPONENT, prefix),
    },
    permissions,
    componentId: COMPONENT,
  })
}

/** 起一次"进程"：新的 host + 新的 activate，共享同一个产品库 */
async function start(appId: string, permissions: readonly string[] = PERMISSIONS): Promise<Host<Principal>> {
  const pair = memoryLinkPair()
  const serverHost = createHost<Principal>({ name: 'server', self: { appId }, principalKey: (p) => p.appId })
  await activate({
    host: serverHost,
    appId,
    brain: { complete: async () => '' },
    ...(permissions.length === 0 ? {} : { storage: storageFor(appId, permissions) }),
    log: () => {},
  })
  const clientHost = createHost<Principal>({
    name: 'ui',
    self: { appId },
    principalKey: (p) => p.appId,
    kind: 'client',
    upstream: { link: pair[0], principal: { appId } },
  })
  serverHost.accept(pair[1], { principal: { appId } })
  hosts.push(clientHost as unknown as Host<unknown>, serverHost as unknown as Host<unknown>)
  return clientHost as unknown as Host<Principal>
}

describe('组件的存储', () => {
  it('审批数据活过"重启"（关掉 host 再重新 activate，单据还在）', async () => {
    const first = await start('app-1')
    const submitted = await first.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      const one = await ref.submit({ title: '报销 300 元' }, ctx)
      await ref.submit({ title: '采购键盘' }, ctx)
      return { id: one.id, items: ref.items.value.length }
    })
    expect(submitted).toEqual({ id: 'AP-1', items: 2 })
    await first.close()

    // ★ 重启：全新的 host、全新的 activate，只有产品库是同一个
    const second = await start('app-1')
    const after = await second.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      return {
        titles: ref.items.value.map((item) => item.title),
        pending: ref.pending.value,
      }
    })
    expect(after.titles).toEqual(['报销 300 元', '采购键盘'])
    expect(after.pending).toBe(2)

    // 编号也不能重：重启后再提交应该是 AP-3
    const next = await second.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      const one = await ref.submit({ title: '第三个' }, ctx)
      return one.id
    })
    expect(next).toBe('AP-3')
  })

  it('同一个组件装进另一个应用 → 看不到这边的单子（命名空间隔离）', async () => {
    const one = await start('app-1')
    await one.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      await ref.submit({ title: '只属于 app-1 的单子' }, ctx)
    })
    await one.close()

    const two = await start('app-2')
    const seen = await two.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-2' })
      return { items: ref.items.value.length, pending: ref.pending.value }
    })
    expect(seen).toEqual({ items: 0, pending: 0 })
  })

  it('两个组件在同一个应用里也互不可见（存储按组件 id 分）', () => {
    const a = storageFor('app-1')
    expect(a).toBeDefined()
    void a!.set('secret', 'a 的数据')
    // 另一个组件 id 的命名空间（同样的应用）
    const other = createComponentStorage({
      backend: {
        read: (key) => core.components.get('app-1', 'tenon.official.other', key),
        write: (key, value) => core.components.set('app-1', 'tenon.official.other', key, value),
        remove: (key) => core.components.delete('app-1', 'tenon.official.other', key),
        keys: (prefix) => core.components.keys('app-1', 'tenon.official.other', prefix),
      },
      permissions: PERMISSIONS,
      componentId: 'tenon.official.other',
    })
    expect(other).toBeDefined()
    expect(core.components.get('app-1', COMPONENT, 'secret')).toBe('a 的数据')
    expect(core.components.get('app-1', 'tenon.official.other', 'secret')).toBeNull()
  })

  it('清单里没有 db:* 权限 → 拿不到 storage，数据退回内存（重启即失）', async () => {
    const first = await start('app-1', [])
    await first.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      await ref.submit({ title: '只在内存里' }, ctx)
    })
    await first.close()

    const second = await start('app-1', [])
    const after = await second.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      return ref.items.value.length
    })
    // 降级是**看得见**的：不持久化就真的没有，而不是"有时有有时没有"
    expect(after).toBe(0)
    // 而且确实一个字节都没写进产品库
    expect(core.components.keys('app-1', COMPONENT)).toEqual([])
  })

  it('startServer 真的把产品库交给了组件宿主（少这一行，全组件悄悄退回内存）', async () => {
    const started = await boot(dir)
    try {
      expect(started.components.storageReady).toBe(true)
    } finally {
      await started.close()
    }
    // 而一个没给 store 的 runtime 必须自认没有持久化能力（否则这个标记就是假的）
    const bare = new ComponentRuntime({
      home: core.home,
      agent: { } as unknown as never,
      roots: [],
      tenonVersion: '0.0.0',
    })
    expect(bare.storageReady).toBe(false)
  })

  it('reset 之后再重启，单据不会"复活"', async () => {
    const first = await start('app-1')
    await first.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      await ref.submit({ title: '会被清掉' }, ctx)
      await ref.reset(ctx)
    })
    await first.close()

    const second = await start('app-1')
    const after = await second.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      return ref.items.value.length
    })
    expect(after).toBe(0)
  })
})
