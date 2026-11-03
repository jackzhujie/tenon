/**
 * 一个**极小的 OpenAI 兼容服务**。两个用途：
 *
 * 1. **验 BYOK 通路**（`pnpm e2e:provider`）：真实 provider 那条路在仓库里
 *    从来没有被执行过 —— `provider.upsert` 的测试只验"密钥不回显"，
 *    `resolveModel` 的 `openai-compatible` 分支没有一条用例真的跑过流式与工具调用。
 * 2. **给 `e2e:real` 当排练对手**（`TENON_REAL_MOCK=1 pnpm e2e:real`）：真模型验收
 *    要花钱、要几分钟，脚本本身必须先被证明是好的。用假 provider 把三个阶段走一遍，
 *    改脚本时就不用每次都掏钱。
 *
 * 它不冒充模型：**剧本是写死的**。它验的是我们这一侧 ——
 * profile → createProvider → openai-completions → SSE 解析 → 工具调用 → 落盘 → commit。
 *
 * 用法：
 * - 独立跑：`pnpm tsx scripts/mock-openai.ts`（打印 base URL，可手工接进设置）
 * - 被脚本引用：`startMockOpenAI()`
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 假模型写的待办清单 —— 刻意长得像"一个模型会写出来的东西"，好让浏览器断言有东西可验 */
const TODO_APP = `import { useState } from 'react'

export function App() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([])
  const [draft, setDraft] = useState('')

  const add = () => {
    const text = draft.trim()
    if (text === '') return
    setItems((list) => [...list, { id: Date.now(), text }])
    setDraft('')
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24, maxWidth: 480 }}>
      <h1>待办清单</h1>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
          placeholder="要做什么"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={add}>添加</button>
      </div>
      <ul style={{ paddingLeft: 18 }}>
        {items.map((item) => (
          <li key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
            <span style={{ flex: 1 }}>{item.text}</span>
            <button onClick={() => setItems((list) => list.filter((entry) => entry.id !== item.id))}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
`

export interface MockRequest {
  readonly messages: Array<{ role?: string; content?: unknown }>
  readonly model: string
}

/** 决定这一轮要不要调工具、调哪个、以及收尾说什么 */
export function decide(request: MockRequest): { tool?: { name: string; args: unknown }; closing: string } {
  const messages = request.messages
  const lastUserAt = messages.map((message) => message.role).lastIndexOf('user')
  const lastUser =
    typeof messages[lastUserAt]?.content === 'string' ? (messages[lastUserAt]?.content as string) : ''
  /*
   * 判"这一轮已经调过工具"只看有没有 `role: 'tool'` 的结果，**不看 name**：
   * OpenAI 协议里工具结果那条消息不一定带 name（我们的实现就不带）。
   * 早先按 name 判时，第二轮永远被当成"还没调过"…
   */
  const alreadyCalled = messages.slice(lastUserAt + 1).some((message) => message.role === 'tool')

  if (/组件|助手|聊天/.test(lastUser)) {
    return alreadyCalled
      ? { closing: '已经给应用装上了 AI 小助手，右下角可以点开聊天。' }
      : { tool: { name: 'install_component', args: { id: 'tenon.official.ai-assistant' } }, closing: '' }
  }
  return alreadyCalled
    ? { closing: '已经按你的要求改好了：待办清单能添加、能删除。' }
    : { tool: { name: 'write', args: { path: 'src/App.tsx', content: TODO_APP } }, closing: '' }
}

export interface MockHandle {
  readonly url: string
  /** 收到的请求体（诊断用：能看见 System Prompt、工具清单、messages 增长） */
  readonly requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function chunkBase(id: string, model: string): Record<string, unknown> {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [] }
}

export async function startMockOpenAI(): Promise<MockHandle> {
  const requests: Array<Record<string, unknown>> = []
  let seq = 0

  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
      } catch {
        body = { unparsed: raw }
      }
      requests.push(body)

      if (!(req.url ?? '').includes('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `没有这个端点：${String(req.url)}` } }))
        return
      }

      const model = typeof body['model'] === 'string' ? body['model'] : 'mock-model'
      const messages = Array.isArray(body['messages']) ? (body['messages'] as MockRequest['messages']) : []
      const decision = decide({ messages, model })
      const id = `mock-${++seq}`

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(
        sseChunk({
          ...chunkBase(id, model),
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }),
      )

      if (decision.tool !== undefined) {
        res.write(
          sseChunk({
            ...chunkBase(id, model),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${id}`,
                      type: 'function',
                      function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        )
        res.write(
          sseChunk({ ...chunkBase(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        )
      } else {
        // 分两帧吐字：证明增量拼接真的走了流，不是"一次塞完"
        const half = Math.ceil(decision.closing.length / 2)
        for (const part of [decision.closing.slice(0, half), decision.closing.slice(half)]) {
          res.write(
            sseChunk({
              ...chunkBase(id, model),
              choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
            }),
          )
        }
        res.write(sseChunk({ ...chunkBase(id, model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      }

      res.write(
        sseChunk({
          ...chunkBase(id, model),
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 独立运行：给人手工接进设置用 */
const isMain = process.argv[1]?.endsWith('mock-openai.ts') === true
if (isMain) {
  const handle = await startMockOpenAI()
  console.log(`mock OpenAI 已启动：${handle.url}`)
  console.log('提供商填：kind=openai-compatible、baseUrl 用上面这个、modelId 随便（比如 mock-1）')
  process.on('SIGINT', () => {
    console.log(`\n共收到 ${handle.requests.length} 次请求`)
    void handle.close().then(() => process.exit(0))
  })
}
