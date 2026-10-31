/**
 * Spike 1：pi-durable 最小闭环。
 * 验证 STATUS §4.1 第 1 条与 §4.3 DoD 第 4 条（杀进程重启后能续跑）。
 *
 * 用 pi-ai 自带的 faux provider 代替真模型：不开 API Key 也能验证「提交→流式→落库→续跑」
 * 这条链路本身。真模型的差异只在 stream 的字节来源，不在 harness 语义。
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AssistantEntry, Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const ctx = BACKGROUND_CONTEXT
const ROOT = new URL('..', import.meta.url).pathname
const WORK = join(ROOT, 'work')
const RESULTS = join(ROOT, 'results')

type Fact = { name: string; ok: boolean; detail: string }
const facts: Fact[] = []
function fact(name: string, ok: boolean, detail: string): void {
  facts.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

/** 应用级结构化状态（DESIGN §6.3 的 tenon.app）*/
const AppDoc = defineDoc<{ name: string; styleId: string; routes: string[] }>({
  kind: 'tenon.app',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'current',
  initial: () => ({ name: '未命名应用', styleId: 'notion', routes: [] }),
  checkpointWhen: () => false,
})

type Block = { type: string; text?: string }
/** tx.entry(AssistantEntry, id) 返回 { model: [AssistantMessage], kind, id } */
function textOf(entry: unknown): string {
  const holder = entry as { model?: Array<{ content?: Block[] }>; content?: Block[] }
  const blocks = holder?.model?.[0]?.content ?? holder?.content ?? []
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

async function main(): Promise<void> {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })
  await mkdir(RESULTS, { recursive: true })

  const dbPath = join(WORK, 'session.sqlite')
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-mini', contextWindow: 32_000 }], tokensPerSecond: 240 })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = { provider: 'faux', modelId: 'faux-mini' }
  const registry = createRegistry()

  // ---------- 阶段 1：打开 + 提交 + 流式 ----------
  const t0 = performance.now()
  const storage = await openNodeSqliteStorage(dbPath, { prefix: 'pi_' })
  const openMs = performance.now() - t0
  const harness = await Harness.open(storage, { models, registry }, ctx)
  const root = await harness.root(ctx, { agent: { model } })
  fact('Harness.open + root', true, `node:sqlite storage 打开 ${openMs.toFixed(0)}ms，root 会话 id=${root.id}`)

  const revisions: Array<{ at: number; entries: number; live: string }> = []
  const view = await root.viewState(ctx)
  const start = performance.now()
  const unsubscribe = view.subscribe((value) => {
    const live = value.docs['pi.live'] as Record<string, unknown> | undefined
    revisions.push({
      at: Math.round(performance.now() - start),
      entries: value.entries.length,
      live: live === undefined ? '' : JSON.stringify(live).slice(0, 60),
    })
  })

  faux.setResponses([
    fauxAssistantMessage(
      '好的，我先建数据表，再写接口。第一轮我会生成 products 实体与迁移，然后把前端列表页接上，最后跑一遍类型检查。',
    ),
  ])
  const submitStart = performance.now()
  const submission = await root.submit({ type: 'input', content: '做一个商品管理应用', requestId: 'req-1' }, ctx)
  const settled = await submission.wait(ctx)
  const submitMs = performance.now() - submitStart
  const answerId = settled.status === 'done' ? settled.answer : undefined
  const answerMessage = answerId === undefined ? undefined : await root.commit((tx) => tx.entry(AssistantEntry, answerId), ctx)
  unsubscribe()

  fact(
    '提交 → 等待 → 落库',
    settled.status === 'done',
    `status=${settled.status} 用 ${submitMs.toFixed(0)}ms；view 订阅收到 ${revisions.length} 次 revision；` +
      `答案长度 ${textOf(answerMessage).length} 字`,
  )
  fact(
    '流式（pi.live 增量）',
    revisions.length > 1,
    `revision 序列（ms/entries）：${revisions.map((r) => `${r.at}:${r.entries}`).join(' → ').slice(0, 200)}`,
  )

  // ---------- 阶段 2：requestId 幂等 ----------
  const again = await root.submit({ type: 'input', content: '做一个商品管理应用', requestId: 'req-1' }, ctx)
  fact(
    'requestId 幂等（同一 Submission）',
    again.id === submission.id,
    `第一次 id=${submission.id}，重放 id=${again.id} → ${again.id === submission.id ? '命中同一提交' : '新建了提交（幂等失效）'}`,
  )

  // ---------- 阶段 3：自定义文档（tenon.app）----------
  const docStart = performance.now()
  await root.commit(async (tx) => {
    const doc = await tx.doc(AppDoc, root.id)
    doc.name = '商品管理'
    doc.routes.push('/products')
  }, ctx)
  const snap = await harness.snapshot(AppDoc, root.id, ctx)
  fact(
    '自定义文档提交 + 快照',
    snap?.name === '商品管理' && snap.routes.length === 1,
    `${(performance.now() - docStart).toFixed(0)}ms，snapshot=${JSON.stringify(snap)}`,
  )

  // ---------- 阶段 4：任务图（必须在跑动中采样，静止时节点会回收）----------
  faux.setResponses([
    fauxAssistantMessage('我会把这次改造拆成四步：建表、写接口、接前端、跑验证。'.repeat(14)),
  ])
  const longRun = root.submit({ type: 'input', content: '再拆细一点', requestId: 'req-2' }, ctx)
  await new Promise<void>((r) => setTimeout(r, 220))
  const graph = await harness.taskGraph(ctx)
  const tasks = Object.values(graph.value.tasks)
  fact(
    'taskGraph 跑动中可采样',
    tasks.length > 0,
    `节点 ${tasks.length} 个：${tasks
      .map((t) => `${t.kind}/${t.state.status}`)
      .join(',')}；background 标记可用=${tasks.every((t) => typeof t.background === 'boolean')}`,
  )
  await (await longRun).wait(ctx)

  // ---------- 阶段 5：关闭 + 重开 + resume ----------
  await harness.close(ctx)
  const reopenStart = performance.now()
  const storage2 = await openNodeSqliteStorage(dbPath, { prefix: 'pi_' })
  const harness2 = await Harness.open(storage2, { models, registry }, ctx)
  harness2.resume()
  const root2 = await harness2.root(ctx)
  const view2 = await root2.viewState(ctx)
  const reacquired = await harness2.submission(submission.id, ctx)
  const state = await reacquired!.status(ctx)
  fact(
    '重开 + resume + 按 id 取回提交',
    state.status === 'done',
    `重开 ${(performance.now() - reopenStart).toFixed(0)}ms；root id 一致=${root2.id === root.id}；` +
      `transcript ${view2.value.entries.length} 条；提交状态=${state.status}`,
  )
  const snap2 = await harness2.snapshot(AppDoc, root2.id, ctx)
  fact('文档跨重启存活', snap2?.name === '商品管理', `snapshot=${JSON.stringify(snap2)}`)
  await view2.dispose?.()
  await harness2.close(ctx)

  // ---------- 阶段 6：硬杀进程后续跑（DoD 第 4 条）----------
  const crashDb = join(WORK, 'crash.sqlite')
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'crash-child.ts'), crashDb], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  let childOut = ''
  child.stdout.on('data', (b: Buffer) => {
    childOut += b.toString()
  })
  child.stderr.on('data', (b: Buffer) => {
    childOut += b.toString()
  })
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  const submissionIdLine = childOut.split('\n').find((l) => l.startsWith('SUBMISSION_ID='))
  const parsedId = Number(submissionIdLine?.slice('SUBMISSION_ID='.length).trim())
  const crashedSubmissionId = Number.isFinite(parsedId) ? (parsedId as typeof submission.id) : undefined
  fact(
    '子进程流式中途被 SIGKILL',
    exit.signal === 'SIGKILL' && crashedSubmissionId !== undefined,
    `exit=${JSON.stringify(exit)}；子进程输出：${childOut.trim().split('\n').slice(-2).join(' / ').slice(0, 200)}`,
  )

  if (crashedSubmissionId !== undefined) {
    const storage3 = await openNodeSqliteStorage(crashDb, { prefix: 'pi_' })
    const harness3 = await Harness.open(storage3, { models, registry }, ctx)
    const beforeResume = await harness3.submission(crashedSubmissionId, ctx)
    if (beforeResume === undefined) throw new Error('找不到提交')
    const beforeState = await beforeResume.status(ctx)
    const resumeStart = performance.now()
    harness3.resume()
    // 续跑用的响应队列必须重新给：崩溃前那次生成已经消费掉第一条
    faux.appendResponses([
      fauxAssistantMessage('崩溃后继续：我在上次中断的地方接着写，已补完 products 模块。'),
    ])
    let afterState: Awaited<ReturnType<typeof beforeResume.wait>> | undefined
    let resumeErr: string | undefined
    try {
      afterState = await Promise.race([
        beforeResume.wait(ctx),
        new Promise<undefined>((_resolve, reject) => setTimeout(() => reject(new Error('resume 15s 超时')), 15_000)),
      ])
    } catch (err) {
      resumeErr = err instanceof Error ? err.message : String(err)
    }
    fact(
      '重启后续跑同一提交',
      afterState?.status === 'done',
      `崩溃前状态=${beforeState.status}；resume 后 status=${afterState?.status ?? 'n/a'}` +
        `${resumeErr === undefined ? '' : `（${resumeErr}）`}；耗时 ${(performance.now() - resumeStart).toFixed(0)}ms`,
    )
    await harness3.close(ctx)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    dbPath,
    facts,
  }
  await writeFile(join(RESULTS, 'spike-agent.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const failed = facts.filter((f) => !f.ok)
  console.log(`\n合计 ${facts.length} 项，通过 ${facts.length - failed.length}，失败 ${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('spike-agent 失败：', err)
  process.exitCode = 1
})
