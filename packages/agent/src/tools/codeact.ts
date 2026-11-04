/**
 * CodeAct 的脚本沙箱（M4 第 6 步）：把 `pi-codemode` 的 QuickJS 沙箱接到 pi-durable 的
 * codemode 扩展上。这是「一次工具调用换十个」的那条路 —— 也是**唯一**能让 Agent 在一次
 * 调用里做循环、过滤、join 的地方（提示词里让模型"多调几次工具"是做不到的）。
 *
 * 四件必须记住的事：
 *
 * 1. **脚本里能调的只有注入的工具，没有 FS / fetch / 定时器 / npm。**
 *    `tools.read/ls/glob/grep` 之外什么都没有 —— 它是"带了四个文件工具的算盘"。
 *    所以"跑脚本 = 能偷偷改文件"这件事从能力上就不成立（写工具压根没注进去）。
 *
 * 2. **嵌套调用只有脚本的收尾输出进模型上下文。**
 *    这才是 codemode 的价值：四十次 `read` 的正文全留在 VM 里，模型只看到 `text()` 打印的
 *    那一行结论。反过来，脚本把整份文件 `text()` 出来就等于自己废掉了这个能力。
 *
 * 3. **`models: false`。** 上游默认会给脚本 `models.classify()` / `generateImages()` ——
 *    那是**脚本自己发起、按次计费**的模型调用，父会话的事件流里看不见，用量账本也只在回调时
 *    才知道。M4 第 3 步刚把预算熔断做出来，这里再开一个绕开它的口子不合适。
 *
 * 4. **打包之后 worker 与 wasm 都不在原位。** `CodemodeSandbox` 默认按 `import.meta.url`
 *    找 `./worker.js`、按 `createRequire` 找 `quickjs-wasi/quickjs.wasm`。esbuild 把整个
 *    server 打成一个 `server.mjs` 之后这两个路径全部失效，而**构建一声不响地成功** ——
 *    症状是"派活给 codeact，它说脚本跑不了（sandbox 错误）"。
 *    解法在 `apps/desktop/build.mjs`：这个包**外部化 + 整包拷进 `dist/server/node_modules/`**，
 *    让 Node 按正常规则从那里解析，两条默认路径就都还对。改打包方式时别忘了一起改。
 *
 * 5. **脚本自己可以调大超时 —— 必须夹住。** 上游语义是
 *    `timeoutMs: options.timeoutMs ?? this.timeoutMs`（`runtime/execution.js`），
 *    也就是 `// @options: {"timeout_ms": 3600000}` 会**覆盖**我们设的 60 秒。
 *    不夹的话"60 秒上限"只是一句注释：一个写歪的循环能让派活的主角色干等半小时，
 *    而"没反应"和"卡死"在界面上分不出来。见下面的 `checkScriptOptions`。
 */
import { CodemodeSandbox, parseCodemodeSource } from '@earendil-works/pi-codemode'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'

export const CODEACT_EXTENSION = 'tenon.codeact'
/** 模型直接调的那一个工具；脚本再从里面调别的 */
export const CODEACT_TOOL = 'codemode'

/**
 * 单次脚本的墙钟上限。
 *
 * 上游默认 300 秒 —— 对一次工具调用来说太长：本地应用里"没反应五分钟"和"卡死"没有区别，
 * 而派活的主角色会一直等在这条调用上。60 秒够跑几万行过滤，跑不完就是脚本写歪了。
 *
 * 脚本自己可以用 `// @options: {"timeout_ms": …}` 改这个值（上游语义），所以它只是**默认值**；
 * 真正的上限是 `MAX_SCRIPT_TIMEOUT_MS`，由 `checkScriptOptions` 夹住。
 */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 脚本**允许**把超时调到多长。
 *
 * 为什么不是"一律不许调"：批量处理上万条记录是 codeact 存在的理由，那种活确实需要几分钟。
 * 为什么不是"上游给到多少就多少"（上限是 `setTimeout` 的 24.8 天）：主角色会一直等这条调用，
 * 而用户看到的是"没反应"。三倍于默认值（180 秒）覆盖了真实的长任务，再长就该拆。
 */
const MAX_SCRIPT_TIMEOUT_MS = 180_000

/**
 * 脚本输出的 token 预算上限。
 *
 * `max_output_tokens` 同样可以被脚本调大，而输出是**唯一**回到父会话上下文的东西 ——
 * 调成 100000 等于用一次工具调用把上下文撑满，之后每一轮都背着它。
 */
const MAX_SCRIPT_OUTPUT_TOKENS = 8_000

/** QuickJS VM 的堆上限。一个跑飞的字符串拼接能把 wasm32 的 4GiB 吃干净，然后整个 server 陪葬 */
const DEFAULT_MEMORY_BYTES = 128 * 1024 * 1024

/**
 * 工具声明在提示词里占的预算（估算 token）。
 *
 * 上游默认 3000：那对"几十个 MCP 工具"是合理的，对四个只读工具是浪费 ——
 * 子角色的系统提示词本来就不长，光列签名就占掉一大块会把"该怎么干活"挤没。
 */
const DEFAULT_INLINE_BUDGET = 1200

export interface CodeactOptions {
  /** 单次脚本的墙钟上限（毫秒） */
  timeoutMs?: number
  /** QuickJS 堆上限（字节） */
  memoryLimitBytes?: number
  /** 提示词里工具声明的 token 预算 */
  inlineBudget?: number
}

export interface ScriptLimits {
  readonly maxTimeoutMs: number
  readonly maxOutputTokens: number
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  maxTimeoutMs: MAX_SCRIPT_TIMEOUT_MS,
  maxOutputTokens: MAX_SCRIPT_OUTPUT_TOKENS,
}

/**
 * 看一眼脚本头的 `// @options`，越界就返回一句拒绝理由（`null` = 放行）。
 *
 * 三个刻意的选择：
 * 1. **不是静默钳制**。把 3600000 悄悄改成 180000，模型会以为它要求的超时生效了，
 *    然后对"为什么还是超时"做出错误推理。拒绝并说清上限，它才知道要拆任务。
 * 2. **解析失败不在这里报**。语法错误交给上游工具去报 —— 它的消息更准（含行号与支持的字段），
 *    而这里只需要管"合法的但过分的"。
 * 3. **纯函数**。夹超时这件事必须能被单测直接验，不需要起一个真的 QuickJS（那要几百毫秒）。
 */
export function checkScriptOptions(code: string, limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS): string | null {
  let options: { timeoutMs?: number | undefined; maxOutputTokens?: number | undefined }
  try {
    options = parseCodemodeSource(code).options
  } catch {
    // 交给上游报（它会有更具体的错误信息）
    return null
  }

  if (options.timeoutMs !== undefined && options.timeoutMs > limits.maxTimeoutMs) {
    return (
      `脚本要求 ${options.timeoutMs}ms，超过上限 ${limits.maxTimeoutMs}ms（默认 ${DEFAULT_TIMEOUT_MS}ms）。` +
      '把任务拆小：一次处理一部分文件/记录，多跑几次脚本。'
    )
  }
  if (options.maxOutputTokens !== undefined && options.maxOutputTokens > limits.maxOutputTokens) {
    return (
      `脚本要求输出 ${options.maxOutputTokens} tokens，超过上限 ${limits.maxOutputTokens}。` +
      '只 text() 结论（计数、前几行、匹配到的名字），不要 text() 整份内容。'
    )
  }
  return null
}

type ScriptRefusal = { output: { type: 'text'; text: string }[]; isError: true }

/**
 * 给 `codemode` 工具套一层脚本头检查。
 *
 * 为什么包**工具**而不是改沙箱：`@options` 是上游在 `execute` 里解析的，沙箱拿到的
 * 已经是算好的 `timeoutMs`。在工具入口看得到原始脚本，也就能在**起 worker 之前**拒绝 ——
 * 不必为一个注定被拒的脚本先花掉 100ms 启动 QuickJS。
 *
 * 副作用为零：没写 `@options`（或没越界）的脚本原样转发给上游的 execute。
 *
 * 导出是为了能测"原样转发"这件事 —— 起一个真沙箱要几百毫秒，而这里要验的只是
 * "拦不拦"与"转发对不对"，与 VM 无关。
 */
export function withScriptLimits<T extends ToolRegistration>(tool: T, limits: ScriptLimits): T {
  const run = tool.execute.bind(tool)
  const guarded = {
    ...tool,
    async execute(args: unknown, api: never, context: never): Promise<unknown> {
      const code = (args as { code?: unknown }).code
      if (typeof code === 'string') {
        const refusal = checkScriptOptions(code, limits)
        if (refusal !== null) {
          const result: ScriptRefusal = { output: [{ type: 'text', text: refusal }], isError: true }
          return result
        }
      }
      return run(args as never, api, context)
    },
  }
  return guarded as unknown as T
}

export interface CodeactExtension {
  readonly extension: Extension
  /** 这个扩展贡献的工具（`codemode`），要一起装进 registry */
  readonly tools: readonly ToolRegistration[]
  /** 关掉沙箱：正在跑的 VM 会被中止。会话关闭时必须调，否则 worker 线程会拽住进程 */
  close(): Promise<void>
}

/**
 * 建一个 codeact 扩展。
 *
 * 每应用一个（与 harness 同寿命）：沙箱本身只持有工具表与默认值，**每次 `execute()` 才起一个
 * worker**，所以"建了但没派过活"不花钱（wasm 也是首次执行时才读）。
 */
export function codeactExtension(options: CodeactOptions = {}): CodeactExtension {
  const sandbox = new CodemodeSandbox({
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryLimitBytes: options.memoryLimitBytes ?? DEFAULT_MEMORY_BYTES,
  })

  const upstream = createCodemodeExtension({
    sandbox,
    // 见文件头第 3 条：脚本不许自己发起计费调用
    models: false,
    inlineBudget: options.inlineBudget ?? DEFAULT_INLINE_BUDGET,
  })

  /*
   * 改名成 `tenon.codeact`：我们的扩展统一用 `tenon.` 前缀（`tenon.coding` / `tenon.subagent` /
   * `tenon.preview` / `tenon.review`），会话按名字选扩展、漂移检测也按名字比。
   * 工具与 section 一律用上游的 —— `codemode` 的 section 会把**当前会话可调用工具**的签名
   * 渲染成 TypeScript 声明，那是模型写对脚本的唯一依据，自己重写只会更差。
   *
   * 唯一的例外是 `codemode` 工具本身要套一层脚本头检查（见 `checkScriptOptions`）。
   * 改的是**同一批工具对象**，所以 `extension.tools`（registry 从这里读）与下面返回的
   * `tools`（`getTools()` 给子会话挑工具用）不会出现"一边有守卫一边没有"。
   */
  /*
   * 上限至少是 180 秒：调用方把默认超时设得更小（比如 30 秒）时，脚本仍应能申请到
   * "多跑一会儿"的余地，否则 `@options` 就变成了一个只能调小的选项。
   */
  const limits: ScriptLimits = {
    maxTimeoutMs: Math.max(MAX_SCRIPT_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxOutputTokens: MAX_SCRIPT_OUTPUT_TOKENS,
  }
  const tools = (upstream.tools ?? []).map((tool) =>
    tool.name === CODEACT_TOOL ? withScriptLimits(tool, limits) : tool,
  )
  const extension: Extension = { ...upstream, name: CODEACT_EXTENSION, tools }

  let closing: Promise<void> | undefined
  return {
    extension,
    tools: extension.tools ?? [],
    close() {
      // `close()` 可以重复调（会话关闭 + 进程退出都会走到），只真关一次
      closing ??= sandbox.close().catch(() => undefined)
      return closing
    },
  }
}
