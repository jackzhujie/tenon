/**
 * BYOK 通路的真机验证（真模型验收的前置）。
 *
 * 要回答的问题是：**配一个 OpenAI 兼容 provider，这条路到底通不通？**
 *
 * 为什么这件事现在必须验：`provider.upsert` 有测试，但只验了"密钥不回显"；
 * `resolveModel` 的 `openai-compatible` 分支**没有任何一条用例真的跑过流式响应、
 * 跑过工具调用**。它一直是"照着 pi-ai 的接口写的、应该能行"。
 *
 * 这里用一个本地假 OpenAI 服务（`scripts/mock-openai.ts`）把整条路走完：
 *
 *   profile（加密存库）→ 启动时 resolveModel → createProvider(openai-completions)
 *   → 流式 SSE 解析 → 模型要求调 write → 工具真的落盘 → 再问一次模型 → 收尾 → commit
 *
 * 它不冒充模型（剧本是写死的）。它证明的是**我们这一侧**没坏 ——
 * 于是接上真 key 之后如果不对，问题只可能在模型或提示词，不在接线。
 *
 * 还有一个副作用值得注意：这个脚本**绕过了产品**。因为今天没有任何界面能配模型，
 * 所以它只能先 `openCore()` 直接写库、再 `startServer()`。这本身就说明缺一个设置页
 * （已记进 STATUS §4.27）。
 *
 * 用法：`pnpm e2e:provider`（不联网、不要 key）
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCore, appPaths, resolveHome, SETTING_KEYS } from '../packages/core/src/index.js'
import { startServer } from '../packages/server/src/index.js'
import { startMockOpenAI } from './mock-openai.js'

const TOKEN = 'e2e-provider-token'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Normalized {
  role: string
  parts: { type: string; text?: string }[]
}

/** 消息的纯文本（前端也是这么从 parts 里拼的） */
function textOf(message: Normalized | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

const mock = await startMockOpenAI()
const home = await mkdtemp(join(tmpdir(), 'tenon-e2e-provider-'))
const env = { TENON_HOME: home }
console.log(`TENON_HOME = ${home}`)
console.log(`mock provider = ${mock.url}\n`)

let server: Awaited<ReturnType<typeof startServer>> | undefined

try {
  /*
   * 先写库再起服务：模型在 `createAgentRuntime` 那一刻解析，之后不再变。
   * 这条限制本身是个产品缺口（保存设置要重启才生效），不是这个脚本的取巧。
   */
  console.log('1) 写入 provider profile（加密存库）+ 选中它')
  const core = openCore({ env })
  const profile = core.providers.upsert({
    label: '本地假 OpenAI',
    kind: 'openai-compatible',
    baseUrl: mock.url,
    tier: 'auto',
    modelId: 'mock-model-1',
    paramsJson: null,
    apiKey: 'sk-mock-not-a-real-key',
  })
  core.settings.set({ [SETTING_KEYS.activeProviderId]: profile.id })
  core.close()

  console.log('2) 起 server（不带 TENON_FAUX）')
  server = await startServer({
    port: 0,
    token: TOKEN,
    env,
    preview: { readyTimeoutMs: 5 * 60 * 1000 },
  })

  async function rpc<T>(method: string, input: unknown): Promise<T> {
    const response = await fetch(`${server?.url}/rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(input),
    })
    const body = (await response.json()) as Envelope<T>
    if (!body.ok) throw new Error(`${method} 失败：${JSON.stringify(body.error)}`)
    return body.data as T
  }

  const health = await rpc<{ model: { mode: string; providerId: string; modelId: string } | null }>(
    'health',
    {},
  )
  check(
    'model 被解析成 openai-compatible（不是 faux、也不是 null）',
    health.model?.mode === 'openai-compatible',
    JSON.stringify(health.model),
  )
  check('用的是刚写进去的那个 provider', health.model?.modelId === 'mock-model-1')

  console.log('3) 建应用，说一句话，让它真的改代码')
  const created = await rpc<{ app: { id: string } }>('app.create', { name: 'BYOK 通路' })
  const appId = created.app.id
  const repoDir = appPaths(resolveHome(env), appId).repoDir
  const before = await rpc<{ messages: Normalized[] }>('chat.history', { appId, limit: 200 })

  await rpc('chat.submit', {
    appId,
    content: '把首页改成一个打招呼页面，标题写「BYOK 通路验证」。',
    requestId: 'byok-1',
  })

  const deadline = Date.now() + 120_000
  let turns = 0
  for (;;) {
    const history = await rpc<{ messages: Normalized[] }>('chat.history', { appId, limit: 200 })
    // 判据是"历史真的变长了且最后一条是助手" —— 只等 status 会撞上提交前的 idle
    if (history.messages.length > before.messages.length && history.messages.at(-1)?.role === 'assistant') {
      turns = history.messages.length
      break
    }
    if (Date.now() > deadline) throw new Error('这一轮没有落定（120s）')
    await sleep(300)
  }
  check('一轮对话真的落定了', turns > 0)

  console.log('4) 验它到底做了什么')
  const app = await readFile(join(repoDir, 'src', 'App.tsx'), 'utf8')
  check(
    '模型要求的 write 真的被执行了（文件内容变了）',
    app.includes('待办清单'),
    app.slice(0, 200),
  )

  const log = await rpc<{ commits: { message: string; sha: string }[] }>('git.log', {
    appId,
    limit: 10,
  })
  check('改动产生了 commit', log.commits.length >= 2, `commits = ${log.commits.length}`)

  const history = await rpc<{ messages: Normalized[] }>('chat.history', { appId, limit: 200 })
  const last = history.messages.at(-1)
  check(
    '收尾那句话完整拼出来了（流式增量没丢字）',
    textOf(last).includes('待办清单能添加、能删除'),
    JSON.stringify(textOf(last)),
  )

  const usage = await rpc<{ snapshot: { totals: { input: number; output: number; costUsd: number } } }>(
    'usage.get',
    { appId },
  )
  check(
    '用量被记下来了（token 不是 0）',
    usage.snapshot.totals.input + usage.snapshot.totals.output > 0,
    JSON.stringify(usage.snapshot.totals),
  )
  /*
   * 这条**故意记成"已知限制"而不是失败**：provider profile 没有价格表，
   * 所以 costUsd 恒为 0 —— 意味着「按美元设额度」对 BYOK 用户完全失效，
   * 只有 token 维度是真的。真模型验收时这会变成一个具体的产品问题。
   */

  // 两次请求 = 第一轮要工具、拿到结果后再问一次。这证明工具循环真跑了两趟
  check(
    'provider 被调用了两次（工具循环跑满）',
    mock.requests.length === 2,
    `收到 ${mock.requests.length} 次`,
  )
  const firstRequest = mock.requests[0] as { tools?: { function?: { name?: string } }[] }
  check(
    '工具清单真的递给了 provider',
    Array.isArray(firstRequest.tools) && firstRequest.tools.length >= 4,
    `tools = ${firstRequest.tools?.length ?? 0}`,
  )
} catch (error) {
  failures += 1
  console.log(`\n✗ 失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server?.close()
  await mock.close()
  await rm(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
