/**
 * 另外两个官方插件（M5 第 7 步）：导出 CSV 与审批流。
 *
 * 这一步的真正目的是**检验组件规范能不能低成本复制** —— 所以测试不去重跑网关/链路
 * （那些在 `component-link.test.ts` 里已经验过），而是直接问两个问题：
 * 1. 契约 + `activate` 这套形状，第二个、第三个组件是不是照抄就能跑？
 * 2. 业务规则（CSV 转义、行数对齐、非法状态转移）有没有真的落在方法里？
 *
 * 两个插件都用 `memoryLinkPair` 连（Spike 5 验过的传输），因为这里要验的是**组件自己**。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createHost, memoryLinkPair, type Host } from '@earendil-works/chord'
import { activate as activateCsv, csvField, toCsv } from '../../../plugins/bundled/tenon.official.csv-export/server.js'
import { ExportTable } from '../../../plugins/bundled/tenon.official.csv-export/contract.js'
import { activate as activateApproval } from '../../../plugins/bundled/tenon.official.approval/server.js'
import { Approval } from '../../../plugins/bundled/tenon.official.approval/contract.js'

type Principal = { appId: string }

const brain = { complete: async () => '（这两个组件不需要模型）' }

let hosts: Host<Principal>[] = []
const closers: (() => Promise<void>)[] = []

beforeEach(() => {
  hosts = []
  closers.length = 0
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const host of hosts.splice(0)) await host.close()
})

/**
 * 起一个服务端 host + 一条 memory link，返回"浏览器那半边"。
 *
 * **必须 await activate**：组件的 activate 可以是 async 的（审批流要先从存储恢复数据，
 * 再 `host.serve`）。不等它就去连接，会撞上"这个 contract 还没人 serve" —— 而生产代码
 * 里 `activateComponents` 是 await 的，所以是测试要跟上，不是组件写错。
 */
async function connect(activate: (input: {
  host: Host<Principal>
  appId: string
  brain: typeof brain
}) => void | Promise<void>): Promise<Host<Principal>> {
  const appId = 'app-1'
  const server = createHost<Principal>({
    name: 'server',
    self: { appId },
    principalKey: (principal) => principal.appId,
    dev: true,
    onError: (error) => console.log('server host:', error instanceof Error ? error.message : error),
  })
  await activate({ host: server, appId, brain })
  hosts.push(server)

  const [serverSide, clientSide] = memoryLinkPair()
  server.accept(serverSide, { principal: { appId } })
  const client = createHost<Principal>({
    name: 'ui',
    self: { appId },
    principalKey: (principal) => principal.appId,
    kind: 'client',
    readyTimeout: 5_000,
    upstream: { link: clientSide, principal: { appId } },
    onError: (error) => console.log('client host:', error instanceof Error ? error.message : error),
  })
  hosts.push(client)
  closers.push(async () => {
    await client.close()
  })
  return client
}

describe('导出 CSV', () => {
  it('转义：逗号 / 引号 / 换行都要包起来，内部引号翻倍', () => {
    expect(csvField('普通')).toBe('普通')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('两行\n文本')).toBe('"两行\n文本"')
  })

  it('生成的文本带 BOM、CRLF，并且表头在第一行', () => {
    const csv = toCsv(['名称', '备注'], [['苹果', '脆'], ['梨', 'a,b']])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    // 第一行前面带 BOM —— 这正是 Excel 认出 UTF-8 的依据
    expect(csv.split('\r\n')[0]).toBe('\uFEFF名称,备注')
    expect(csv).toContain('"a,b"')
  })

  it('端到端：调 export 拿到 csv，state 记下文件名与行数', async () => {
    const ui = await connect(activateCsv)
    const result = await ui.root(async (ctx) => {
      const ref = await ctx.get(ExportTable, { appId: 'app-1' })
      const exported = await ref.export(
        { filename: '订单/明细.csv', columns: ['编号', '金额'], rows: [['A1', '12.00']] },
        ctx,
      )
      return { exported, lastFile: ref.lastFile.value, rows: ref.rows.value, phase: ref.phase.value }
    })
    expect(result.exported.csv).toContain('编号,金额')
    expect(result.exported.bytes).toBeGreaterThan(0)
    // 文件名里的 `/` 会被洗干净 —— 它本来要被当成路径分隔符
    expect(result.lastFile).toBe('订单-明细.csv')
    expect(result.rows).toBe(1)
    expect(result.phase).toBe('done')
  })

  it('列数对不上就拒绝，而不是导出一份错位的表', async () => {
    const ui = await connect(activateCsv)
    const outcome = await ui.root(async (ctx) => {
      const ref = await ctx.get(ExportTable, { appId: 'app-1' })
      return ref
        .export({ filename: 'x', columns: ['a', 'b'], rows: [['只有一列']] }, ctx)
        .then(() => 'allowed', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    })
    expect(outcome).not.toBe('allowed')
    // 组件 server 侧的报错是英文单语：`plugins/bundled/**` 的字符串字面量不许有 CJK
    // （i18n-guard 的硬约束，见 STATUS §2「生成应用的模板与导出产物」那行）
    expect(String(outcome)).toContain('misaligned')
  })
})

describe('审批流', () => {
  it('提交 → 通过；待审数量跟着走', async () => {
    const ui = await connect(activateApproval)
    const result = await ui.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      const first = await ref.submit({ title: '报销 120 元' }, ctx)
      await ref.submit({ title: '采购键盘' }, ctx)
      const pendingBefore = ref.pending.value
      await ref.decide({ id: first.id, approve: true }, ctx)
      return {
        pendingBefore,
        pendingAfter: ref.pending.value,
        items: ref.items.value as { id: string; state: string }[],
        phase: ref.phase.value,
      }
    })
    expect(result.pendingBefore).toBe(2)
    expect(result.pendingAfter).toBe(1)
    expect(result.items[0]).toMatchObject({ state: 'approved' })
    expect(result.phase).toBe('approved')
  })

  it('空标题被拒；已决的单子不能再审一次', async () => {
    const ui = await connect(activateApproval)
    const outcome = await ui.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      const empty = await ref
        .submit({ title: '   ' }, ctx)
        .then(() => 'allowed', (error: unknown) => (error instanceof Error ? error.message : String(error)))
      const created = await ref.submit({ title: '一张单子' }, ctx)
      await ref.decide({ id: created.id, approve: false }, ctx)
      const again = await ref
        .decide({ id: created.id, approve: true }, ctx)
        .then(() => 'allowed', (error: unknown) => (error instanceof Error ? error.message : String(error)))
      return { empty, again }
    })
    expect(outcome.empty).not.toBe('allowed')
    expect(outcome.again).not.toBe('allowed')
    // 同上：组件 server 侧英文单语
    expect(String(outcome.again)).toContain('cannot be reviewed again')
  })

  it('状态跨 root 还在（linger）', async () => {
    const ui = await connect(activateApproval)
    await ui.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      await ref.submit({ title: '刷新之后还要在' }, ctx)
    })
    const after = await ui.root(async (ctx) => {
      const ref = await ctx.get(Approval, { appId: 'app-1' })
      return { count: ref.items.value.length, pending: ref.pending.value }
    })
    expect(after).toEqual({ count: 1, pending: 1 })
  })
})
