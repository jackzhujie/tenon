/**
 * 真模型验收（`pnpm e2e:real`）—— 到目前为止**唯一**能验证产品主张的东西。
 *
 * 为什么必须单独做这一条：仓库里 500+ 个测试与 8 套端到端**全部跑在 faux 上**
 * （`TENON_FAUX=1`，按剧本回台词的假模型）。faux 能证明管线通 —— 工具调用了、
 * 文件写了、commit 了、页面变了。它**不能**证明模型按提示词把事做完。
 *
 * 而只在真模型下才第一次被检验的东西，恰好是产品主张的全部：
 * 系统提示词、工具描述、`docs/AGENTS.md`、组件的 `agentHints`、CodeAct 脚本、
 * 以及「先说需求 → 页面真的能用」这条闭环。
 *
 * 三个阶段，每段都记耗时与 token（顺带部分回答了"哪一步贵"）：
 *
 *   1. 生成 —— 一句话做一个待办清单（模型自己决定怎么写）
 *   2. 装组件 —— 一句话要求装 AI 助手（验工具描述与 AGENTS.md 是否足够让模型自己动手）
 *   3. 真浏览器 —— 输入 → 添加 → 出现 → 删除 → 消失；再点悬浮球问一句拿到回答
 *
 * 第三阶段是**判据**：模型说自己做完了不算，页面上真的能加能删才算。
 *
 * 用法：
 *   TENON_REAL_KEY=sk-... TENON_REAL_MODEL=gpt-4o-mini pnpm e2e:real
 * 可选：
 *   TENON_REAL_BASE_URL=https://api.deepseek.com/v1   （默认 OpenAI）
 *   TENON_REAL_LABEL=DeepSeek
 *   TENON_REAL_HOME=/some/dir   复用已有 home（省掉每次装 React 的几十秒）
 *   TENON_REAL_BUDGET_TOKENS=400000   额度（默认 40 万 token，超了当场熔断）
 *   TENON_REAL_MODEL=auto             让脚本问端点要模型清单自己挑（配 TENON_REAL_MODEL_HINT=flash）
 *   TENON_REAL_CONTEXT / _MAX_TOKENS  上下文与单次输出上限（默认 200k / 32k）
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCore, appPaths, resolveHome, SETTING_KEYS } from '../packages/core/src/index.js'
import { startServer } from '../packages/server/src/index.js'
import { startMockOpenAI } from './mock-openai.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'e2e-real-token'
const COMPONENT = 'tenon.official.ai-assistant'
const BALL = `[data-tenon-component="${COMPONENT}"]`
const MARKER = '端到端验收条目'

/*
 * 排练模式：用本地假 provider 把三个阶段走一遍。
 * 它的意义不是"验模型"，而是**先证明这个脚本自己是好的** ——
 * 真模型一跑要花钱、要几分钟，不该拿它来调试断言。
 */
const useMock = process.env['TENON_REAL_MOCK'] === '1'
const mock = useMock ? await startMockOpenAI() : undefined
const key = useMock ? 'sk-mock-not-a-real-key' : (process.env['TENON_REAL_KEY'] ?? '')
// 排练模式也有默认 id，但 `auto` 要能穿过 —— 否则"自动挑模型"这条路从没被跑过
const modelId = process.env['TENON_REAL_MODEL'] ?? (useMock ? 'mock-model-1' : '')
const baseUrl = useMock ? (mock?.url ?? '') : (process.env['TENON_REAL_BASE_URL'] ?? 'https://api.openai.com/v1')
const label = useMock ? '本地排练用假 provider' : (process.env['TENON_REAL_LABEL'] ?? new URL(baseUrl).host)
const budgetTokens = Number(process.env['TENON_REAL_BUDGET_TOKENS'] ?? 400_000)
/*
 * 上下文与单次输出上限。provider profile 的默认值（128k / 8k）是按"通用模型"定的，
 * 而一次"写一整个页面"很容易超过 8k 输出 —— 被截断的表现是一段写了一半的 JSX，
 * 然后模型在下一轮里反复修补。这里显式给参数，环境变量可覆盖。
 */
const contextWindow = Number(process.env['TENON_REAL_CONTEXT'] ?? 200_000)
const maxTokens = Number(process.env['TENON_REAL_MAX_TOKENS'] ?? 32_000)

if (key === '' || modelId === '') {
  console.error(
    [
      '缺凭据。两个环境变量必须有：',
      '  TENON_REAL_KEY    你的 API Key（不会被打出来，只写进这个临时 home 的加密库）',
      '  TENON_REAL_MODEL  模型 id，比如 gpt-4o-mini / deepseek-chat / qwen-plus',
      '可选：',
      '  TENON_REAL_BASE_URL   OpenAI 兼容端点，默认 https://api.openai.com/v1',
      '',
      '例：TENON_REAL_KEY=sk-xxx TENON_REAL_MODEL=deepseek-chat \\',
      '    TENON_REAL_BASE_URL=https://api.deepseek.com/v1 pnpm e2e:real',
    ].join('\n'),
  )
  process.exit(2)
}

/**
 * 模型 id 各家叫法不一样（"4.1 flash"不是任何厂商的正式 id）。既然端点一定支持
 * `GET /models`，就别猜 —— 问一次，按"flash > chat > 第一个"挑，并把清单打出来。
 * 猜错的代价是白跑一次真跑（几分钟 + 真金白银）。
 */
async function pickModelId(endpoint: string, apiKey: string, wanted: string): Promise<string> {
  const base = endpoint.replace(/\/$/, '')
  const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
  if (!response.ok) {
    throw new Error(
      `${base}/models 返回 ${response.status} —— 这个端点不列模型，请显式给 TENON_REAL_MODEL（比如 deepseek-chat）`,
    )
  }
  const body = (await response.json()) as { data?: { id?: string }[] }
  const ids = (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) throw new Error('端点没返回任何模型')
  console.log(`   可选模型：${ids.join('、')}`)

  const lower = wanted.toLowerCase()
  const exact = ids.find((id) => id.toLowerCase() === lower)
  if (exact !== undefined) return exact
  const tokens = lower.split(/[\s._-]+/).filter((token) => token !== '')
  const scored = ids
    .map((id) => {
      const name = id.toLowerCase()
      const hits = tokens.filter((token) => name.includes(token)).length
      return { id, hits }
    })
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits)
  if (scored.length > 0) return scored[0]!.id
  // 一个词都对不上：优先 flash（"快而便宜"通常更适合跑验收），再退第一个
  return ids.find((id) => /flash/i.test(id)) ?? ids[0]!
}

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

interface Normalized {
  role: string
  /** `streaming` 说明这一条还在写；`settled` 才是定稿 */
  status?: string
  parts: { type: string; text?: string; name?: string; status?: string; output?: string }[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function textOf(message: Normalized | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

/**
 * 这一轮模型调了哪些工具。
 *
 * 注意**不能只看最后一条消息**：工具调用挂在"发起调用的那条 assistant 消息"上，
 * 而收尾的那句话是另一条消息 —— 只看最后一条会得出"它一次工具都没调"的错觉
 * （我第一次就是这么把自己骗过去的）。
 */
function toolsOf(messages: readonly Normalized[], since: number): { names: string[]; outputs: string[] } {
  const names: string[] = []
  const outputs: string[] = []
  for (const message of messages.slice(since)) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      names.push(part.name ?? '?')
      if (part.output !== undefined) outputs.push(`[${part.status ?? '?'}] ${part.output.slice(0, 200)}`)
    }
  }
  return { names, outputs }
}

const home = process.env['TENON_REAL_HOME'] ?? (await mkdtemp(join(tmpdir(), 'tenon-real-')))
const env = { TENON_HOME: home }
const ephemeral = process.env['TENON_REAL_HOME'] === undefined

console.log(`模型      ${label} / ${modelId}${useMock ? '（排练模式：剧本是写死的，验的是脚本与接线）' : ''}`)
console.log(`端点      ${baseUrl}`)
console.log(`key       ${key.slice(0, 3)}…${key.slice(-2)}（${key.length} 字符，不会打印全文）`)
console.log(`TENON_HOME ${home}${ephemeral ? '（临时，跑完删掉）' : '（复用）'}\n`)

let server: Awaited<ReturnType<typeof startServer>> | undefined

/**
 * Electron 主进程：在真 Chromium 里验"页面真的能用"，而不是"模型说它做完了"。
 *
 * 判据刻意与具体实现解耦：不找特定 class，只找"能输入的地方 + 能点的按钮"，
 * 因为它要覆盖的是**模型自由发挥出来的界面**，我并不知道它会写什么。
 */
function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = process.env.TENON_E2E_URL
const ball = ${JSON.stringify(BALL)}
const marker = ${JSON.stringify(MARKER)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logs = []

function js(frame, script) {
  return frame.executeJavaScript(script)
}

async function waitFor(frame, script, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const ok = await js(frame, script).catch(() => false)
    if (ok === true) return true
    if (Date.now() > deadline) {
      throw new Error('等不到：' + label + ' | 页面里的组件错误：' +
        (await js(frame, 'JSON.stringify([...new Set(window.__tenonComponentErrors || [])].slice(0,3))').catch(() => '"<读不到>"')))
    }
    await sleep(150)
  }
}

async function run() {
  const out = { steps: [] }
  const win = new BrowserWindow({ show: false, width: 1200, height: 860 })
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first !== null && typeof first === 'object' && 'message' in first) logs.push(String(first.message))
    else logs.push(String(args[2]))
  })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await waitFor(frame, 'document.readyState === "complete"', '页面加载')

  // ① 有输入框吗（模型可能把输入框做成 textarea，也可能只有 input）
  const hasInput = await js(frame, 'document.querySelector("input:not([type]),input[type=text],textarea") !== null')
  out.steps.push({ name: '有输入框', ok: hasInput })
  if (!hasInput) return out

  // ② 输入一条并提交：先试回车，不行再找"添加/新增"按钮（两种写法都很常见）
  /*
   * 受控输入必须走**原型上的原生 setter**：直接赋值再 dispatch input，
   * React 的 value tracker 会认为"值没被外部改过"，onChange 不触发 —— 现象是
   * 输入框看着有字、点了没反应。这是拿 DOM 驱动 React 应用的标准写法。
   */
  await js(frame, \`(() => {
    const el = document.querySelector('input:not([type]),input[type=text],textarea')
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    el.focus()
    setter.call(el, \${JSON.stringify(marker)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()\`)
  await js(frame, \`(() => {
    const el = document.activeElement
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    }
    return true
  })()\`)
  await sleep(600)
  if (!(await js(frame, 'document.body.innerText.includes(' + JSON.stringify(marker) + ')'))) {
    await js(frame, \`(() => {
      const re = /^(添加|新增|加入|提交|创建|确定|add|create|submit|ok)$/i
      const btn = [...document.querySelectorAll('button,[role=button]')]
        .find((node) => re.test((node.textContent || '').trim()))
      if (btn) btn.click()
      return btn !== undefined
    })()\`)
  }
  const added = await js(frame, 'document.body.innerText.includes(' + JSON.stringify(marker) + ')').catch(() => false)
  out.steps.push({ name: '能添加一条', ok: added })
  if (!added) {
    // 输入框里还有内容（说明它根本没被处理）—— 留着给报告看
    out.inputValue = await js(frame, 'document.querySelector("input:not([type]),input[type=text],textarea").value')
    return out
  }

  // ③ 删掉它：从含 marker 的节点往上找一行，点这一行里像"删除"的东西
  await js(frame, \`(() => {
    const re = /^(删除|删掉|移除|清除|×|✕|✖|🗑|delete|remove|trash)$/i
    const nodes = [...document.querySelectorAll('*')].filter((node) =>
      node.children.length === 0 && (node.textContent || '').trim() === \${JSON.stringify(marker)})
    let row = nodes[0]
    for (let i = 0; i < 6 && row; i += 1) {
      const btn = [...row.querySelectorAll('button,[role=button]')]
        .find((node) => re.test((node.textContent || '').trim()) || re.test(node.getAttribute('aria-label') || ''))
      if (btn) { btn.click(); return true }
      row = row.parentElement
    }
    return false
  })()\`)
  await sleep(600)
  const deleted = await js(frame, 'document.body.innerText.includes(' + JSON.stringify(marker) + ')')
    .then((still) => still === false).catch(() => false)
  out.steps.push({ name: '能删掉它', ok: deleted })

  // ④ 悬浮球在（组件真的被装上了，且注入时机对）
  const ballCount = await js(frame, 'document.querySelectorAll(' + JSON.stringify(ball) + ').length').catch(() => 0)
  out.steps.push({ name: '悬浮球出现', ok: ballCount === 1, detail: 'count=' + ballCount })

  if (ballCount === 1) {
    // ⑤ 点开问一句，拿到回答（真模型的回答，不是剧本）
    await js(frame, 'document.querySelector(' + JSON.stringify(ball) + ').click()')
    await waitFor(frame, 'document.querySelectorAll("textarea").length > 0', '面板打开')
    await js(frame, \`(() => {
      const t = document.querySelector('textarea')
      t.value = '用一句话说明你能帮上什么忙'
      t.dispatchEvent(new Event('input', { bubbles: true }))
      const send = [...document.querySelectorAll('button')].find((b) => /发送|send/i.test(b.textContent || ''))
      if (send) send.click()
      return true
    })()\`)
    const replied = await waitFor(frame, 'document.querySelectorAll("[data-tenon-message]").length >= 2', '回答', 90000)
      .then(() => true).catch(() => false)
    const messages = await js(frame, '[...document.querySelectorAll("[data-tenon-message]")].map((n) => ({ role: n.getAttribute("data-tenon-message"), text: n.textContent }))').catch(() => [])
    out.steps.push({ name: '能问一句并拿到回答', ok: replied, detail: JSON.stringify(messages).slice(0, 300) })
    out.messages = messages
  }

  out.logs = logs.slice(-8)
  await win.close()
  return out
}

app.whenReady().then(async () => {
  try {
    process.stdout.write('E2E_RESULT ' + JSON.stringify(await run()) + '\\n')
  } catch (error) {
    process.stdout.write('E2E_ERROR ' + JSON.stringify(String((error && error.message) || error)) + '\\n')
  } finally {
    app.exit(0)
  }
})
`
}

try {
  let resolvedModel = modelId
  if (modelId === '' || modelId.toLowerCase() === 'auto') {
    console.log('0) 问端点要模型清单（TENON_REAL_MODEL=auto）')
    resolvedModel = await pickModelId(baseUrl, key, process.env['TENON_REAL_MODEL_HINT'] ?? 'flash')
    console.log(`   用 ${resolvedModel}\n`)
  }

  console.log('1) 写入 provider（加密存库）+ 选中，然后起 server')
  const core = openCore({ env })
  const profile = core.providers.upsert({
    label,
    kind: 'openai-compatible',
    baseUrl,
    tier: 'auto',
    modelId: resolvedModel,
    paramsJson: JSON.stringify({ contextWindow, maxTokens }),
    apiKey: key,
  })
  core.settings.set({ [SETTING_KEYS.activeProviderId]: profile.id })
  core.close()

  server = await startServer({
    port: 0,
    token: TOKEN,
    env,
    preview: { readyTimeoutMs: 10 * 60 * 1000, log: (line) => console.log(`  [preview] ${line}`) },
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

  const health = await rpc<{ model: { mode: string; modelId: string } | null }>('health', {})
  check('server 用的是真 provider（不是 faux）', health.model?.mode === 'openai-compatible', JSON.stringify(health.model))

  const created = await rpc<{ app: { id: string } }>('app.create', { name: '真模型验收' })
  const appId = created.app.id
  const repoDir = appPaths(resolveHome(env), appId).repoDir
  await rpc('budget.set', { appId, maxCostUsd: null, maxTokens: budgetTokens })
  console.log(`   appId = ${appId}，额度 ${budgetTokens} token\n`)

  /** 跑一轮，返回耗时、token 增量、工具调用、末条助手文本 */
  async function turn(content: string, phase: string): Promise<{
    ms: number
    tokens: number
    tools: string[]
    outputs: string[]
    text: string
    timedOut: boolean
  }> {
    const before = await rpc<{ snapshot: { totals: { input: number; output: number } } }>('usage.get', { appId })
    const beforeHistory = await rpc<{ messages: Normalized[] }>('chat.history', { appId, limit: 400 })
    const started = Date.now()
    await rpc('chat.submit', { appId, content, requestId: `real-${phase}` })

    /*
     * 一轮结束的判据是**两个条件同时成立**：
     *   ① 应用状态回到 `idle`
     *   ② 历史末尾是一条 `settled` 的助手消息，且这一轮真的新增过东西
     *
     * 只判 ① 会在提交前就返回（上一轮留下的 idle）；只看 ② 会在模型"说一句、
     * 接着调工具"时提前返回 —— 真模型恰恰是这么工作的：它先说"我先看看结构"，
     * 然后继续调工具改文件。第一次跑真模型就是被这个骗了：脚本以为一轮结束了，
     * 后面所有断言都在"模型还在干活"的时候执行，全落空。
     */
    const deadline = started + 15 * 60_000
    let messages: Normalized[] = []
    for (;;) {
      const history = await rpc<{ messages: Normalized[] }>('chat.history', { appId, limit: 400 })
      messages = history.messages
      const last = messages.at(-1)
      const settled =
        last?.role === 'assistant' &&
        last.status === 'settled' &&
        messages.length > beforeHistory.messages.length &&
        last.parts.some((part) => part.type === 'text' && (part.text ?? '') !== '')
      if (settled) {
        const page = await rpc<{ apps: { id: string; status: string }[] }>('app.list', {})
        if (page.apps.find((app) => app.id === appId)?.status === 'idle') break
      }
      if (Date.now() > deadline) break
      await sleep(600)
    }
    const after = await rpc<{ snapshot: { totals: { input: number; output: number } } }>('usage.get', { appId })
    const last = messages.at(-1)
    const collected = toolsOf(messages, beforeHistory.messages.length)
    return {
      ms: Date.now() - started,
      tokens:
        after.snapshot.totals.input + after.snapshot.totals.output - (before.snapshot.totals.input + before.snapshot.totals.output),
      tools: collected.names,
      outputs: collected.outputs,
      text: textOf(last),
      timedOut: Date.now() > deadline,
    }
  }

  console.log('2) 阶段一：一句话做一个待办清单（模型自由发挥）')
  /*
   * 先记下起手时的 App.tsx。判"它真的改了吗"只能靠**前后对比**：
   * 早先我用 `!appSource.includes('Tenon')` 当判据 —— 而模板自己的注释里就有 Tenon，
   * 模型也完全可能在标题里写「Tenon · 待办」。猜关键词的断言迟早会误判，
   * 而误判的方向是"把成功报成失败"，同样有害。
   */
  const appFile = join(repoDir, 'src', 'App.tsx')
  const beforeApp = await readFile(appFile, 'utf8').catch(() => '')
  const gen = await turn(
    '做一个待办清单页面：一个输入框加一个添加按钮，下面是清单，每一项都能删除。数据放内存就行，不要改后端。',
    'gen',
  )
  console.log(
    `   耗时 ${(gen.ms / 1000).toFixed(1)}s，token ${gen.tokens}，工具 ${gen.tools.length} 次（${[...new Set(gen.tools)].join(' / ')}）`,
  )
  console.log(`   它说：${gen.text.slice(0, 160).replace(/\n/g, ' ')}…`)
  for (const line of gen.outputs) console.log(`   工具结果 ${line}`)
  console.log('')
  check('阶段一没有超时', !gen.timedOut)
  check('模型真的动了文件（write/edit 至少一次）', gen.tools.some((name) => name === 'write' || name === 'edit' || name === 'bash'), gen.tools.join(','))
  const appSource = await readFile(appFile, 'utf8')
  check(
    'App.tsx 真的被改了（与提交前不是同一份）',
    appSource !== beforeApp && appSource.length > 200,
    `改前 ${beforeApp.length} 字符 → 改后 ${appSource.length} 字符`,
  )

  console.log('3) 阶段二：一句话让它自己装 AI 助手（验工具描述 + AGENTS.md 够不够）')
  const install = await turn(
    '给这个应用装一个 AI 小助手：页面右下角能点开聊天，就当前页面内容回答我的问题。用现成的组件，不要自己写。',
    'component',
  )
  console.log(`   耗时 ${(install.ms / 1000).toFixed(1)}s，token ${install.tokens}，工具：${install.tools.join(' / ') || '（没调工具）'}`)
  for (const line of install.outputs) console.log(`   工具结果 ${line}`)
  const listed = await rpc<{
    components: { id: string; loaded: boolean; enabled: boolean }[]
    available: { id: string; installed: boolean; source: string }[]
    problems: { code: string; message: string }[]
  }>('component.list', { appId })
  const installed = listed.components.find((item) => item.id === COMPONENT)
  console.log(`   component.list：${JSON.stringify(listed.components.map((item) => `${item.id}(loaded=${item.loaded})`))}\n`)
  check(
    '模型自己调了 install_component（没手写一个球）',
    install.tools.includes('install_component') && installed !== undefined,
    `工具=${install.tools.join(',') || '无'}；已装=${String(installed?.id)}`,
  )
  check('装完之后它会加载', installed?.loaded === true, JSON.stringify(installed))

  console.log('4) 阶段三：起预览，在真 Chromium 里验"页面真的能用"')
  await rpc('preview.start', { appId })
  const ready = await server.preview.waitReady(appId, 10 * 60_000)
  if (ready.state !== 'ready' || ready.url === null) throw new Error(`预览没就绪：${ready.error ?? '未知'}`)
  console.log(`   网关 ${ready.url}`)

  // 组件是 preview.start 之后异步激活的，脚本注入要等它 —— 轮询到注入为止
  let injected = false
  for (let i = 0; i < 120; i += 1) {
    const html = await (await fetch(ready.url)).text()
    if (html.includes('/__tenon/component.js')) {
      injected = true
      break
    }
    if (i === 0) console.log('   等组件激活后注入脚本…')
    await sleep(1000)
  }
  check('组件脚本被注入到页面里', injected)

  const mainFile = join(home, 'electron-main.cjs')
  await writeFile(mainFile, electronMain(), 'utf8')
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TENON_E2E_URL: ready.url }
  delete childEnv['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['--no-sandbox', mainFile], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString()
    if (!line.includes('DevTools') && !line.includes('Warning')) process.stderr.write(`  [electron] ${line}`)
  })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 6 * 60_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const resultLine = stdout.split('\n').find((line) => line.startsWith('E2E_RESULT '))
  if (resultLine === undefined) {
    const errorLine = stdout.split('\n').find((line) => line.startsWith('E2E_ERROR '))
    throw new Error(`浏览器验收没跑完：${errorLine ?? stdout.slice(-800)}`)
  }
  const result = JSON.parse(resultLine.slice('E2E_RESULT '.length)) as {
    steps: { name: string; ok: boolean; detail?: string }[]
    messages?: { role: string; text: string }[]
    logs?: string[]
  }
  for (const step of result.steps) check(step.name, step.ok, step.detail ?? '')
  if (result.steps.length < 4) {
    console.log(`   页面日志（最后 8 条）：${JSON.stringify(result.logs ?? [])}`)
  }

  console.log('\n5) 汇总')
  const total = await rpc<{ snapshot: { totals: { input: number; output: number; costUsd: number }; level: string } }>(
    'usage.get',
    { appId },
  )
  const t = total.snapshot.totals
  console.log(`   三段合计：耗时 ${((gen.ms + install.ms) / 1000).toFixed(1)}s（不含浏览器），token ${t.input + t.output}（入 ${t.input} / 出 ${t.output}）`)
  console.log(`   成本：$${t.costUsd} —— **恒为 0**，因为 provider profile 没有价格表（见 STATUS §4.27）`)
  console.log(`   额度水平：${total.snapshot.level}`)
  const commits = await rpc<{ commits: unknown[] }>('git.log', { appId, limit: 50 })
  console.log(`   commit 数：${commits.commits.length}`)
} catch (error) {
  failures += 1
  console.log(`\n✗ 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  await server?.close()
  await mock?.close()
  if (ephemeral) await rm(home, { recursive: true, force: true })
  else console.log(`\n（home 保留在 ${home}，下次可复用）`)
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
