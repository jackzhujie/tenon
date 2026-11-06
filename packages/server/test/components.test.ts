/**
 * 组件宿主与第一个真组件（AI 小助手）的验收。
 *
 * 两段：
 *
 * 1. **加载器**：`server.js` 被真的 `import()` 起来、`activate` 被调用、坏插件只落一条
 *    `load-failed` 而不连累别人。夹具用纯 JS（不碰 chord），验的就只是"装载"这一件事。
 * 2. **AI 小助手**：用 `memoryLinkPair` 假装浏览器那半边，走**跟真浏览器一样的路径**
 *    （`createHost({kind:'client'})` → `ctx.get` → 调方法 → 读状态）。
 *    这里刻意**跨两个 root**断言：`linger` 没给的话第二次读到的会是空对话，
 *    而界面上表现就是"聊到一半刷新一下，记录没了"。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHost, memoryLinkPair, type Host } from '@earendil-works/chord'
import { writeAssembly } from '@tenon/component-host'
import { activateComponents, type Principal } from '../src/components.js'
import { activate, type AssistantBrain } from '../../../plugins/bundled/tenon.official.ai-assistant/server.js'
import { Assistant } from '../../../plugins/bundled/tenon.official.ai-assistant/contract.js'

let dir: string
let roots: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-comp-'))
  roots = join(dir, 'plugins')
  await mkdir(roots, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const MANIFEST = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  version: '1.0.0',
  description: '夹具',
  source: 'bundled',
  minTenonVersion: '0.0.0',
  signature: null,
  permissions: [],
  agentHints: '夹具组件，不该出现在真应用里',
  pricing: { type: 'free' },
  facets: { server: 'server.js' },
  slots: [],
  ...extra,
})

async function fixture(id: string, serverJs: string, extra: Record<string, unknown> = {}): Promise<void> {
  const pluginDir = join(roots, id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'manifest.json'), JSON.stringify(MANIFEST(id, extra)), 'utf8')
  await writeFile(join(pluginDir, 'server.js'), serverJs, 'utf8')
}

async function assemble(ids: readonly string[]): Promise<string> {
  const repoDir = join(dir, 'repo')
  await mkdir(repoDir, { recursive: true })
  await writeAssembly(repoDir, {
    version: 1,
    components: ids.map((id) => ({ id, version: '*', license: 'free', enabled: true, mount: [] })),
  })
  return repoDir
}

const brain: AssistantBrain = {
  complete: async ({ text }) => `回答：${text}`,
}

describe('装载 server facet', () => {
  it('import 起来并调用 activate；没激活的组件不会出现在 loaded 里', async () => {
    await fixture(
      'tenon.test.hello',
      'export function activate({ appId }) { globalThis.__tenonHello = appId }',
    )
    await fixture('tenon.test.quiet', 'export const something = 1') // 没有 activate
    const repoDir = await assemble(['tenon.test.hello', 'tenon.test.quiet'])

    const activated = await activateComponents({
      appId: 'app-1',
      repoDir,
      roots: [{ kind: 'bundled', dir: roots }],
      tenonVersion: '0.0.0',
      brain,
    })

    expect(activated.loaded).toEqual(['tenon.test.hello'])
    expect((globalThis as { __tenonHello?: string }).__tenonHello).toBe('app-1')
    expect(activated.problems).toMatchObject([
      { code: 'load-failed', componentId: 'tenon.test.quiet' },
    ])
    await activated.host.close()
  })

  it('activate 里抛错只落一条problem，别的组件照常挂上', async () => {
    await fixture('tenon.test.bad', 'export function activate() { throw new Error("故意的") }')
    await fixture('tenon.test.good', 'export function activate() {}')
    const repoDir = await assemble(['tenon.test.bad', 'tenon.test.good'])

    const activated = await activateComponents({
      appId: 'app-2',
      repoDir,
      roots: [{ kind: 'bundled', dir: roots }],
      tenonVersion: '0.0.0',
      brain,
    })

    expect(activated.loaded).toEqual(['tenon.test.good'])
    expect(activated.problems[0]?.message).toContain('故意的')
    await activated.host.close()
  })

  it('装配声明坏掉时不抛：host 照样建好，问题留给 component.list', async () => {
    const repoDir = join(dir, 'repo-broken')
    await mkdir(repoDir, { recursive: true })
    await writeFile(join(repoDir, 'app.components.json'), '{ nope', 'utf8')

    const activated = await activateComponents({
      appId: 'app-3',
      repoDir,
      roots: [{ kind: 'bundled', dir: roots }],
      tenonVersion: '0.0.0',
      brain,
    })
    expect(activated.loaded).toEqual([])
    expect(activated.plan.problems[0]?.code).toBe('assembly-invalid')
    await activated.host.close()
  })
})

describe('AI 小助手（真组件，走跟浏览器一样的路径）', () => {
  /** 服务端那边挂好组件，再给一条 memory link 当传输 */
  async function connect(): Promise<{
    host: Host<Principal>
    remote: Host<Principal>
    close: () => Promise<void>
  }> {
    const host = createHost<Principal>({
      name: 'server',
      self: { appId: 'app-1' },
      principalKey: (principal) => principal.appId,
      dev: true,
    })
    activate({ host, appId: 'app-1', brain })
    const [serverSide, clientSide] = memoryLinkPair()
    host.accept(serverSide, { principal: { appId: 'app-1' } })
    const remote = createHost<Principal>({
      name: 'ui',
      self: { appId: 'app-1' },
      principalKey: (principal) => principal.appId,
      kind: 'client',
      upstream: { link: clientSide, principal: { appId: 'app-1' } },
    })
    return {
      host,
      remote,
      close: async () => {
        await remote.close()
        await host.close()
      },
    }
  }

  it('问一句：问题与回答都进状态，turns 加 1', async () => {
    const { remote, close } = await connect()
    try {
      const seen = await remote.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId: 'app-1' })
        await ref.ask({ text: '你好' }, ctx)
        return {
          messages: ref.messages.value,
          turns: ref.turns.value,
          phase: ref.phase.value,
        }
      })
      expect(seen.messages).toEqual([
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '回答：你好' },
      ])
      expect(seen.turns).toBe(1)
      expect(seen.phase).toBe('idle')
    } finally {
      await close()
    }
  })

  it('对话跨 root 还在（linger 起作用的证据）', async () => {
    const { remote, close } = await connect()
    try {
      await remote.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId: 'app-1' })
        await ref.ask({ text: '第一句' }, ctx)
      })
      // 新的 root = 一次新的请求周期（浏览器刷新、断线重连都是这个形状）。
      // 没给 linger 的话这里读到的是**新对象**：0 条消息、turns=0，且不报任何错。
      const after = await remote.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId: 'app-1' })
        return { count: ref.messages.value.length, turns: ref.turns.value }
      })
      expect(after).toEqual({ count: 2, turns: 1 })
    } finally {
      await close()
    }
  })

  it('大脑出错写进对话，而不是把调用打红', async () => {
    const host = createHost<Principal>({
      name: 'server',
      self: { appId: 'app-1' },
      principalKey: (principal) => principal.appId,
      dev: true,
    })
    activate({
      host,
      appId: 'app-1',
      brain: {
        complete: async () => {
          throw new Error('还没配模型')
        },
      },
    })
    const [serverSide, clientSide] = memoryLinkPair()
    host.accept(serverSide, { principal: { appId: 'app-1' } })
    const remote = createHost<Principal>({
      name: 'ui-fail',
      self: { appId: 'app-1' },
      principalKey: (principal) => principal.appId,
      kind: 'client',
      upstream: { link: clientSide, principal: { appId: 'app-1' } },
    })
    try {
      const messages = await remote.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId: 'app-1' })
        await ref.ask({ text: '在吗' }, ctx)
        return ref.messages.value
      })
      expect(messages[0]).toEqual({ role: 'user', text: '在吗' })
      expect(messages[1]?.role).toBe('system')
      expect(messages[1]?.text).toContain('还没配模型')
    } finally {
      await remote.close()
      await host.close()
    }
  })

  it('clear 清空对话；空问题被拒', async () => {
    const { remote, close } = await connect()
    try {
      const outcome = await remote.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId: 'app-1' })
        await ref.ask({ text: '一句话' }, ctx)
        const empty = await ref.ask({ text: '   ' }, ctx).then(
          () => 'allowed',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        await ref.clear(ctx)
        return { empty, messages: ref.messages.value, turns: ref.turns.value }
      })
      expect(outcome.empty).not.toBe('allowed')
      expect(outcome.messages).toEqual([])
      expect(outcome.turns).toBe(0)
    } finally {
      await close()
    }
  })

  it('别的应用拿不到这个应用的对象', async () => {
    const { close } = await connect()
    const intruder = createHost<Principal>({
      name: 'intruder',
      self: { appId: 'app-2' },
      principalKey: (principal) => principal.appId,
      kind: 'client',
    })
    try {
      // 直接用 app-2 的 input 去 get：factory 里的 appId 守卫要把它挡下来
      const result = await intruder
        .root(async (ctx) => {
          const ref = await ctx.get(Assistant, { appId: 'app-2' })
          return ref.phase.value
        })
        .then(
          () => 'allowed',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
      expect(result).not.toBe('allowed')
    } finally {
      await intruder.close()
      await close()
    }
  })
})
