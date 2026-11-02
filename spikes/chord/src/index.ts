/**
 * Spike 5：chord 宿主接入。
 *
 * 为什么单独写一个 spike 而不是直接进 M5：DESIGN §21 把整个组件体系押在 chord 上
 * （「不要自研插件框架，直接用 chord」），而它对我们有四个**没验过就不知道**的问题：
 *
 * 1. 它的对象/状态模型能不能装下"一个组件 = 一份 contract + 每宿主一个 facet"（§21.2）
 * 2. `principal` + `variants` 真的能让"没买的用户连方法都没有"（收费不是前端藏按钮）
 * 3. 浏览器那半边怎么拿到服务端对象、状态怎么过链、**断线之后调用会怎样**
 * 4. 它能不能被 esbuild 打成单文件 —— pi-codemode 的 worker/wasm 就是在这一步静默失效的
 *    （见 STATUS §5），这类坑必须在选型阶段就撞出来，而不是写完 6 个插槽才发现
 *
 * 结论只认实测：每条都打印实测值，不是"应该能行"。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Type } from 'typebox'
import {
  createHost,
  defineFacet,
  invalid,
  isChordError,
  memoryLinkPair,
  type Ctx,
  type Facet,
  type Host,
} from '@earendil-works/chord'
import { GUEST, OWNER, Probe, Sheet, type Principal } from './contract.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

type Fact = { name: string; ok: boolean; detail: string }
const facts: Fact[] = []

function fact(name: string, ok: boolean, detail: string): void {
  facts.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

/** 同一个 principal 的两处调用要落到同一个对象上；不同 principal 必须是两个对象 */
const principalKey = (p: Principal): string => (p.kind === 'owner' ? 'owner' : `guest:${p.id}`)

function codeOf(error: unknown): string {
  if (isChordError(error)) return `${error.code}: ${error.message}`
  return `NOT_CHORD: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * 一个组件的服务端半边。注意它长得跟 DESIGN §21.2 的 `server.ts` 一模一样 ——
 * factory 里声明 state，按 principal 决定返回哪个 variant。**判断在 factory 里，不在方法里。**
 */
function serveSheet(host: Host<Principal>, linger?: number): void {
  host.serve(
    Sheet,
    ({ docId }, principal, self) => {
      const title = self.state('title', Type.String(), docId)
      const rows = self.state('rows', Type.Number(), 0)
      const revision = self.state('revision', Type.Number(), 0)

      if (principal.kind === 'guest') {
        return { variant: 'viewer', title, rows, revision }
      }
      return {
        variant: 'editor',
        title,
        rows,
        revision,
        append: async ({ n }, ctx) => {
          rows.change(ctx, (current) => current + n)
          revision.change(ctx, (current) => current + 1)
          return { rows: rows.value }
        },
        rename: async ({ title: next }, ctx) => {
          title.replace(ctx, next)
        },
        boom: async () => {
          throw invalid('script', 'boom 是故意的')
        },
      }
    },
    ...(linger === undefined ? [] : [{ linger }]),
  )
}

function newServer(name = 'server', linger?: number): Host<Principal> {
  const host = createHost<Principal>({
    name,
    self: OWNER,
    principalKey,
    // dev 打开所有 schema 校验：spike 阶段宁可早点炸
    dev: true,
    onError: (error) => {
      console.error('[chord background]', error)
    },
  })
  serveSheet(host, linger)
  return host
}

/** ① 最小闭环 + ② 状态订阅 + ③ 错误语义 + ④ 默认生命周期 */
async function checkCore(): Promise<void> {
  const host = newServer()
  const seen: number[] = []

  const first = await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'D1' })
    if (sheet.variant !== 'editor') throw new Error(`owner 拿到的变体是 ${sheet.variant}`)
    sheet.rows.subscribe((n) => {
      seen.push(n)
    })
    const appended = await sheet.append({ n: 2 }, ctx)
    await sheet.append({ n: 3 }, ctx)
    return { appended, rows: sheet.rows.value, title: sheet.title.value, revision: sheet.revision.value }
  })

  fact(
    '1. 最小闭环：契约 → serve → get → 方法 → 状态',
    first.appended.rows === 2 && first.rows === 5 && first.revision === 2 && first.title === 'D1',
    `第一次 append 返回 rows=${first.appended.rows}，root 结束时 rows=${first.rows}、revision=${first.revision}、title=${first.title}`,
  )

  // 订阅拿到的应是「hydrate 的当前值 + 每一次变更」，不是只有最后一次
  fact('2. 状态订阅：先给快照，再逐次给变更', seen.join(',') === '0,2,5', `subscribe 收到 [${seen.join(', ')}]（期望 0, 2, 5）`)

  const failure = await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'D1' })
    if (sheet.variant !== 'editor') return 'wrong-variant'
    try {
      await sheet.boom(ctx)
      return 'no-error'
    } catch (error) {
      return codeOf(error)
    }
  })
  fact('3. 方法里抛的错原样回到调用方（带 code）', failure.startsWith('invalid'), `boom() → ${failure}`)

  // ★ 这条是整个 spike 最重要的发现：默认 lifetime=referenced，最后一个引用释放→对象销毁。
  //   组件如果按默认来写，界面每发一次请求，悬浮球/审批流的进度就归零，而且**不报任何错**。
  const secondRoot = await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'D1' })
    return sheet.variant === 'editor' ? sheet.rows.value : -1
  })
  fact(
    '4. 默认 lifetime=referenced：root 结束对象就销毁（state 归零）',
    secondRoot === 0,
    `上一个 root 里 rows 已经是 5，新 root 再 get 同一个 input：rows=${secondRoot} —— 是**新对象**，不是同一个`,
  )

  await host.close()
}

/** ⑤ 加 linger 才能跨 root 保住 state（组件该用的写法） */
async function checkLinger(): Promise<number> {
  const host = newServer('server', 60_000)
  await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'K1' })
    if (sheet.variant !== 'editor') throw new Error(`owner 拿到的是 ${sheet.variant}`)
    await sheet.append({ n: 4 }, ctx)
  })
  const reread = await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'K1' })
    return sheet.variant === 'editor' ? sheet.rows.value : -1
  })
  fact(
    '5. serve 时给 linger，state 才跨 root 存活',
    reread === 4,
    `带 linger: 60_000 之后新 root 读到 rows=${reread}（期望 4；这才是组件要的语义）`,
  )
  await host.close()
  return reread
}

/** ⑥ principal / variant：收费组件的安全依据 */
async function checkPrincipals(ownerRows: number): Promise<void> {
  const host = newServer('server', 60_000)
  await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'K1' })
    if (sheet.variant === 'editor') await sheet.append({ n: 4 }, ctx)
  })

  const guest = await host.root(async (ctx) => {
    const ref = await ctx.get(Sheet, { docId: 'K1' }, { principal: GUEST })
    // viewer 变体在类型上就没有 append，所以要显式绕过去试：这正是在验"改前端也没用"
    const probe = ref as unknown as { append?: (arg: { n: number }, ctx: Ctx<Principal>) => Promise<unknown> }
    let call = `typeof=${typeof probe.append}`
    if (typeof probe.append === 'function') {
      try {
        await probe.append({ n: 1 }, ctx)
        call = 'allowed'
      } catch (error) {
        call = codeOf(error)
      }
    }
    return { variant: ref.variant, rows: ref.rows.value, call }
  })
  const ownerAfter = await host.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'K1' })
    return sheet.variant === 'editor' ? sheet.rows.value : -1
  })

  fact(
    '6. principal 分流：guest 是 viewer，写方法真的调不动',
    guest.variant === 'viewer' && guest.rows === 0 && guest.call !== 'allowed' && ownerAfter === ownerRows,
    `guest → variant=${guest.variant}、rows=${guest.rows}、调 append 得到「${guest.call}」；owner 那份仍是 ${ownerAfter}`,
  )

  await host.close()
}

/** ⑦ 跨 host（模拟浏览器那半边）+ ⑧ 断链 */
async function checkLink(): Promise<void> {
  const server = newServer('server', 60_000)
  const [serverSide, uiSide] = memoryLinkPair()
  server.accept(serverSide, { principal: OWNER })

  // 浏览器那半边：kind:'client' 表示"不参与 reload、不带 code version"，正是 DESIGN 里 web facet 的位置
  const ui = createHost<Principal>({
    name: 'ui',
    self: OWNER,
    principalKey,
    kind: 'client',
    dev: true,
    readyTimeout: 2_000,
    upstream: { link: uiSide, principal: OWNER },
    onError: (error) => {
      console.error('[ui background]', error)
    },
  })

  const wrote = await ui.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'L1' })
    if (sheet.variant !== 'editor') throw new Error(`ui 拿到的是 ${sheet.variant}`)
    await sheet.append({ n: 7 }, ctx)
    return sheet.rows.value
  })
  const reRead = await ui.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'L1' })
    return sheet.variant === 'editor' ? sheet.rows.value : -1
  })
  const onServer = await server.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'L1' })
    return sheet.variant === 'editor' ? sheet.rows.value : -1
  })
  fact(
    '7. 跨 host：另一端写、两端都看见（memoryLink）',
    wrote === 7 && reRead === 7 && onServer === 7,
    `ui 写后读=${wrote}，ui 重开 root 读=${reRead}，server 自己读=${onServer}`,
  )

  // 模拟断网：frames 双向静默丢弃，且**不发 close**
  const severed = await ui.root(async (ctx) => {
    const sheet = await ctx.get(Sheet, { docId: 'L2' })
    if (sheet.variant !== 'editor') return 'wrong-variant'
    serverSide.sever()
    const call = sheet.append({ n: 1 }, ctx).then(
      () => 'returned',
      (error: unknown) => `threw ${codeOf(error)}`,
    )
    return await Promise.race([call, new Promise<string>((resolve) => setTimeout(() => resolve('hanged'), 1_500))])
  })
  fact(
    '8. 断链的语义（决定界面的超时策略）',
    severed !== 'returned',
    `sever() 之后调用：${severed}（不会假装成功；挂住就必须由调用方超时）`,
  )

  await ui.close()
  await server.close()
}

/** ⑨ 热重载：换一份实现，state 不许丢 */
async function checkReload(): Promise<void> {
  const host = createHost<Principal>({
    name: 'probe',
    self: OWNER,
    principalKey,
    dev: true,
    onError: (error) => {
      console.error('[probe background]', error)
    },
  })

  const facet = (stamp: string): Facet<Principal> => ({
    name: 'tenon.spike.probe',
    ...defineFacet<Principal>((api) => {
      api.serve(
        Probe,
        (_input, _principal, self) => {
          const hits = self.state('hits', Type.Number(), 0)
          return {
            variant: 'default',
            hits,
            hit: async (ctx) => {
              hits.change(ctx, (n) => n + 1)
            },
            stamp: async () => ({ value: stamp }),
          }
        },
        { linger: 60_000 },
      )
    }),
  })

  await host.install(facet('v1'))
  const before = await host.root(async (ctx) => {
    const probe = await ctx.get(Probe, { id: 'P' })
    await probe.hit(ctx)
    await probe.hit(ctx)
    return { hits: probe.hits.value, stamp: (await probe.stamp(ctx)).value, version: host.codeVersion }
  })

  const report = await host.reload([facet('v2')])
  const after = await host.root(async (ctx) => {
    const probe = await ctx.get(Probe, { id: 'P' })
    return { hits: probe.hits.value, stamp: (await probe.stamp(ctx)).value }
  })

  fact(
    '9. 热重载：代码换了，state 还在',
    before.hits === 2 && before.stamp === 'v1' && after.hits === 2 && after.stamp === 'v2',
    `reload 前 hits=${before.hits} stamp=${before.stamp}（codeVersion ${before.version}）→ ` +
      `reload 后 hits=${after.hits} stamp=${after.stamp}（codeVersion ${report.codeVersion}，changed ${report.changed.join(',') || '无'}）`,
  )

  await host.close()
}

async function runNode(entry: string): Promise<{ code: number | null; out: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      // 本机注入的 NODE_OPTIONS 会把任何子进程拖慢（见 STATUS §6），这里清掉
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('exit', (code) => resolve({ code, out: out.trim() }))
  })
}

/** ⑩ 打包：esbuild 打成单文件之后还能不能跑 */
async function checkBundle(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'tenon-spike-chord-'))
  const outfile = join(workDir, 'bundle.mjs')
  try {
    const started = Date.now()
    await build({
      entryPoints: [join(ROOT, 'src', 'bundle-entry.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    })
    const buildMs = Date.now() - started
    const ran = await runNode(outfile)
    const size = `${Math.round((await stat(outfile)).size / 1024)}KB`
    fact(
      '10. esbuild 单文件：打包后仍能跑',
      ran.code === 0 && ran.out.includes('BUNDLE_OK 2'),
      `bundle ${size}，构建 ${buildMs}ms，运行退出码 ${ran.code}，输出「${ran.out}」`,
    )
  } catch (error) {
    fact('10. esbuild 单文件：打包后仍能跑', false, `构建失败：${codeOf(error)}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  console.log(`chord spike　node ${process.version}　${ROOT}\n`)
  await checkCore()
  const ownerRows = await checkLinger()
  await checkPrincipals(ownerRows)
  await checkLink()
  await checkReload()
  await checkBundle()

  const failed = facts.filter((f) => !f.ok)
  console.log(
    `\n${failed.length === 0 ? '全部通过' : `${failed.length} 条不通过`}　${facts.length - failed.length}/${facts.length}`,
  )
  // 断链那一条会留下一个永不 settle 的 root（这正是它要说明的事），别让它拽住进程
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
