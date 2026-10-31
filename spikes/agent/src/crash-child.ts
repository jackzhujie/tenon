/**
 * 崩溃用子进程：提交一个长回答，在流式途中被 SIGKILL。
 * 父进程据此验证 pi-durable 的「中断的工作保持 pending，resume() 接着跑」。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const ctx = BACKGROUND_CONTEXT
const dbPath = process.argv[2]
if (dbPath === undefined) throw new Error('缺 sqlite 路径')

const long =
  '第一步创建数据表 products。第二步写 NestJS 模块。第三步接前端列表。第四步跑类型检查。'.repeat(12)

const faux = fauxProvider({
  provider: 'faux',
  models: [{ id: 'faux-mini', contextWindow: 32_000 }],
  tokensPerSecond: 8, // 故意慢，保证能被中途打断
})
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([fauxAssistantMessage(long)])

const harness = await Harness.open(await openNodeSqliteStorage(dbPath, { prefix: 'pi_' }), { models, registry: createRegistry() }, ctx)
const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-mini' } } })
const submission = await root.submit({ type: 'input', content: '做个商品管理应用', requestId: 'crash-1' }, ctx)

process.stdout.write(`SUBMISSION_ID=${submission.id}\n`)

// 等 600ms（此时必然还在流式），然后硬杀自己
setTimeout(() => {
  process.kill(process.pid, 'SIGKILL')
}, 600)

void submission.wait(ctx).catch(() => {})
