/**
 * CodeAct 子 Agent 的集成测试（M4 第 6 步）。
 *
 * 验的是**沙箱真的在跑、边界真的在**，不是模型会不会写脚本（`faux` 不会推理事）：
 * 1. 派活给 codeact → 子会话里模型只拿到 `codemode` 一个工具，`read/ls/glob/grep` 在
 *    `callable` 里（给脚本调），**不在** `tools` 里（不给模型）；
 * 2. 脚本在真 QuickJS 里 fan-out 读了仓库里的真文件，算出来的数字与测试自己算的一致 ——
 *    这是"它真的读到盘了"的证据，比对一句话的措辞可靠得多；
 * 3. 沙箱里 `tools.write` / `tools.bash` **不存在**：能力边界由注入的工具决定，不由提示词决定；
 * 4. 脚本报错时模型看到的是 `Script failed` + 栈，而不是"工具坏了"；
 * 5. 结论回到父轮，这一轮照常提交（一次工具调用、一个 commit）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentContext } from '@tenon/agent'
import type { NormalizedMessage, SseEvent } from '@tenon/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { boot as bootServer, openSse, rpc } from './support.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-codeact-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true })
})

interface ToolResultRow {
  toolName?: string
  content?: { type: string; text?: string }[]
  isError?: boolean
}

function textOf(row: ToolResultRow | undefined): string {
  return row?.content?.map((part) => part.text ?? '').join('') ?? ''
}

/** 某个会话自己的工具结果（子会话的调用要到它自己的 transcript 里找） */
async function toolResultsOf(appId: string, conversationId?: string): Promise<ToolResultRow[]> {
  const session = await (running as RunningServer).agent.pool?.acquire(appId)
  if (session === undefined) return []
  const conversation =
    conversationId === undefined
      ? session.root
      : await session.harness.conversation(conversationId as never, agentContext)
  if (conversation === undefined) return []
  const view = await conversation.viewState(agentContext)
  try {
    const entries = view.value.entries as unknown as Array<{ kind: string; model?: ToolResultRow[] }>
    return entries.filter((entry) => entry.kind === 'pi.tool-result').flatMap((entry) => entry.model ?? [])
  } finally {
    await view.dispose?.()
  }
}

async function childConversationId(appId: string): Promise<string | undefined> {
  const session = await (running as RunningServer).agent.pool?.acquire(appId)
  if (session === undefined) return undefined
  const page = await session.root.commit(async (tx) => (await tx.scanConversations({}, 20)).items, agentContext)
  const child = page.find((record) => record.owner !== undefined)
  return child === undefined ? undefined : String(child.id)
}

async function runTurn(appId: string, requestId: string): Promise<SseEvent[]> {
  const server = running as RunningServer
  const sse = openSse(server, appId)
  await sse.connected
  await rpc(server, 'chat.submit', { appId, content: '按剧本执行', requestId })
  await sse.waitFor((events) => events.some((event) => event.type === 'app.status' && event.status === 'idle'))
  sse.close()
  return sse.events
}

async function lastAssistantText(appId: string): Promise<string> {
  const { messages } = await rpc<{ messages: NormalizedMessage[] }>(running as RunningServer, 'chat.history', {
    appId,
  })
  const last = [...messages].reverse().find((message) => message.role === 'assistant')
  return (last?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** 测试自己算一遍期望值：脚本里那套统计的"标准答案"（与沙箱无关的实现） */
async function expectedCounts(repoDir: string): Promise<{ files: number; useState: number }> {
  const entries = await readdir(join(repoDir, 'src'))
  const sources = entries.filter((name) => /\.tsx?$/.test(name)).sort()
  let useState = 0
  for (const name of sources) {
    const text = await readFile(join(repoDir, 'src', name), 'utf8')
    useState += text.split('useState').length - 1
  }
  return { files: sources.length, useState }
}

/** 统计 `src/` 下每个源文件里出现多少次 useState —— 四十次 read 只回一行结论，就是这意思 */
const COUNT_SCRIPT = `
const files = (await tools.glob({ pattern: 'src/*.ts*' })).split('\\n').filter(Boolean);
const texts = await Promise.all(files.map((path) => tools.read({ path })));
const hits = texts.reduce((total, source) => total + source.split('useState').length - 1, 0);
text('files=' + files.length + ' useState=' + hits);
return { files: files.length, useState: hits };
`

describe('codeact 子 Agent', () => {
  it('★ 派活写脚本：模型只拿到 codemode，脚本在真 QuickJS 里读真文件并算出数字', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '脚本' })
    const repoDir = join(dir, 'apps', app.id, 'repo')

    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'codeact', task: '统计 src 下每个源文件里 useState 出现几次' } },
      { text: '收到统计结果。' },
      // 子轮：一次工具调用，脚本自己 fan-out
      { as: 'codeact', tool: 'codemode', args: { code: COUNT_SCRIPT } },
      { as: 'codeact', text: 'src 下 8 个源文件，useState 出现在 App.tsx 里。' },
    ])

    const events = await runTurn(app.id, 'c1')

    const started = events.find((event) => event.type === 'tool.start' && event.name === 'subagent')
    if (started?.type === 'tool.start') expect(started.args?.['role']).toBe('codeact')

    // 1. 工具集：模型只看见 codemode；脚本能调四个只读工具；写工具一个都没有
    const session = await running.agent.pool?.acquire(app.id)
    const childId = await childConversationId(app.id)
    expect(childId).toBeDefined()
    const child = await session!.harness.conversation(childId as never, agentContext)
    const childAgent = await child?.agent(agentContext)
    expect((childAgent?.tools ?? []).map((tool) => tool.name)).toEqual(['codemode'])
    const callable = (childAgent?.callable ?? []).map((tool) => tool.name).sort()
    expect(callable).toEqual(['glob', 'grep', 'ls', 'read'])
    for (const forbidden of ['write', 'edit', 'bash', 'subagent', 'codemode']) {
      expect(callable).not.toContain(forbidden)
    }

    // 2. ★ 沙箱真读了盘：脚本算出的数字与测试自己算的必须一致
    const expected = await expectedCounts(repoDir)
    const script = (await toolResultsOf(app.id, childId)).find((row) => row.toolName === 'codemode')
    const output = textOf(script)
    expect(script?.isError).toBeFalsy()
    expect(output).toContain('Script completed')
    expect(output).toContain(`files=${expected.files}`)
    expect(output).toContain(`useState=${expected.useState}`)
    expect(expected.useState).toBeGreaterThan(0)
    // 返回值也回来（`return` 与 `text()` 是两条路）
    expect(output).toContain(`"files":${expected.files}`)
    // 四十次嵌套调用，父轮只看到一段收尾输出
    expect(output.length).toBeLessThan(2000)

    // 3. 结论回到父轮
    expect(await lastAssistantText(app.id)).toContain('收到统计结果')

    // 4. 一轮一 commit：没改文件，所以只有建应用那个提交
    const { commits } = await rpc<{ commits: unknown[] }>(running, 'git.log', { appId: app.id })
    expect(commits).toHaveLength(1)
  })

  it('沙箱的能力边界由注入的工具决定：脚本里没有 write / edit / bash', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '边界' })

    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'codeact', task: '看看你能调什么' } },
      { text: '好，它只能读。' },
      {
        as: 'codeact',
        tool: 'codemode',
        args: {
          /*
           * 注意 `tools` 是个会**抛异常**的代理（不是缺属性返回 undefined）：
           * `typeof tools.write` 直接抛 `tools.write does not exist. Available: read, ls, glob, grep`。
           * 所以这里要 try/catch —— 顺便验证"模型写错了也能拿到有用的报错"。
           */
          code: `
const names = ['read', 'ls', 'glob', 'grep', 'write', 'edit', 'bash', 'subagent', 'codemode'];
const missing = [];
for (const name of names) {
  try {
    if (typeof tools[name] !== 'function') missing.push(name);
  } catch (error) {
    missing.push(name);
  }
}
text('not callable: ' + missing.join(','));
try {
  await tools.write({ path: 'src/App.tsx', content: 'x' });
  text('WRITE WENT THROUGH');
} catch (error) {
  text('blocked with: ' + error.message);
}
`,
        },
      },
      { as: 'codeact', text: '它只有四个只读工具。' },
    ])
    await runTurn(app.id, 'c2')

    const childId = await childConversationId(app.id)
    const output = textOf((await toolResultsOf(app.id, childId)).find((row) => row.toolName === 'codemode'))
    expect(output).toContain('Script completed')
    // 五个写/派活/自我调用的名字在脚本里都不存在
    expect(output).toContain('not callable: write,edit,bash,subagent,codemode')
    // 真去调也调不动，而且报错本身是有用的（告诉它有哪些工具）
    expect(output).not.toContain('WRITE WENT THROUGH')
    expect(output).toContain('tools.write does not exist')
    // 报错会把它真有哪些工具列出来 —— 模型看得到自己错在哪，而不是"未知错误"
    expect(output).toContain('Available: read, ls, glob, grep')
  })

  it('脚本写错时模型看到的是 Script failed + 栈，不是"工具坏了"', async () => {
    running = await bootServer(dir)
    const { app } = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '写错' })

    running.agent.model?.script([
      { tool: 'subagent', args: { role: 'codeact', task: '跑个错的' } },
      { text: '那我自己写。' },
      { as: 'codeact', tool: 'codemode', args: { code: 'const x = ;' } },
      { as: 'codeact', text: '脚本语法错了，我修一下重写。' },
    ])
    await runTurn(app.id, 'c3')

    const childId = await childConversationId(app.id)
    const row = (await toolResultsOf(app.id, childId)).find((result) => result.toolName === 'codemode')
    const output = textOf(row)
    expect(output).toContain('Script failed')
    expect(output).toContain('Script error:')
    // 语法错误时 VM 连跑都没跑起来，栈要指向脚本那一行（QuickJS 的格式），别只说"失败了"
    expect(output).toMatch(/codemode\.js:\d+/)
    // 子 Agent 自己收尾，父轮继续
    expect(await lastAssistantText(app.id)).toContain('那我自己写')
  })
})
