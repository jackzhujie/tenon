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
 */
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
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
 * 注意脚本自己可以用 `// @options: {"timeout_ms": …}` **放大**它（上游语义：该选项覆盖沙箱
 * 默认值）。我们没有夹这一层 —— 见 DESIGN §5.9 的缺口。
 */
const DEFAULT_TIMEOUT_MS = 60_000

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
   */
  const extension: Extension = { ...upstream, name: CODEACT_EXTENSION }

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
