/**
 * 文件与命令工具（M1 第 7 步的前置）：把 `pi-coding-agent` 的内置工具接到 `pi-durable` 的注册表上。
 *
 * 为什么需要这一层（铁律 3 的落地点）：
 * - 两个包对「工具」的定义**不一样**。`pi-coding-agent` 是
 *   `execute(toolCallId, params, signal, onUpdate, ctx) → AgentToolResult`（AgentTool 形状）；
 *   `pi-durable` 是 `execute(args, api, context) → ToolExecutionResult`（可从 `api` 拿 callId、
 *   推流式输出、写 details）。上游任意一边改签名，只改本文件，业务代码不动。
 * - `pi-coding-agent` 的 `ctx: ExtensionToolContext` 带一大堆 UI/会话能力，我们一个都不用：
 *   bash 关掉 `exposeSessionEnvironment`，其余工具只看 `ctx.cwd`。所以只合成 `{ cwd }`。
 *
 * 安全边界（M1 = 本地单用户，边界靠"够用"而非"完备"）：
 * - 文件工具：`path` 必须在 `repo/` 之内，越界直接返回错误结果（不抛异常，让模型自己改）。
 * - bash：`cwd` 强制钉在 `repo/`；环境变量按名字洗掉密钥与 `TENON_*`（生成的应用子进程会继承）；
 *   外加 `bashGuard` 拦两类**能静态看出来**的越界（cd 出界 / 碰宿主凭据目录）。
 * - **不做系统调用级别的沙箱** —— 那是 M7 的 `gondolin` / 权限清单（DESIGN §15.3）。
 *
 * ⚠️ `bashGuard` 是**护栏不是沙箱**：它只看命令字符串，绕过它很容易
 * （`node -e`、`bash -c "$(…)"`、任何 `postinstall` 脚本都能出去）。
 * 它的价值是减少模型手滑（走错目录、改错文件），**不能**当作安全边界宣传 ——
 * 那会让人以为风险已经没了，比没有护栏更危险。边界写清在 `SECURITY.md`。
 */
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { Extension, ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ToolDefinition as SourceToolDefinition } from '@earendil-works/pi-coding-agent'
import { scrubEnv } from '@tenon/core'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { createSearchTools } from './search.js'

export const CODING_EXTENSION = 'tenon.coding'

/**
 * 洗环境变量（实现在 `@tenon/core` —— 预览拉起 dev server 用的是同一套规则）。
 * 这里保留 re-export，别处仍在从本模块导入。
 */
export { scrubEnv }

/** 一次工具结果最多回给模型多少 —— 超了 harness 会自己截断，这里给的是上限 */
const FILE_OUTPUT_LIMITS = { maxBytes: 96 * 1024, maxLines: 4000, retain: 'head' } as const
const BASH_OUTPUT_LIMITS = { maxBytes: 48 * 1024, maxLines: 1200, retain: 'tail' } as const

/** 有些工具的 execute 参数类型带泛型，适配时统一按这个宽形态处理 */
type AnySourceTool = SourceToolDefinition<never, unknown, unknown>
type SourceUpdate = { content?: ReadonlyArray<{ type: string; text?: string }> }

export interface CodingToolsOptions {
  /** 应用仓库目录（`apps/<id>/repo`）。所有工具都被钉在这里面 */
  repoDir: string
}

/**
 * 归一化后的路径必须落在 root 之内；`../` 与绝对路径都要挡住。
 *
 * ⚠️ `root` 自己也要先 `resolve` 一遍。只 `resolve(candidate)` 是不够的：
 * `resolve` 会把结果统一成平台分隔符，而 `root` 若带着另一种分隔符（`C:\Users\x/.tenon/...`
 * 这种混合写法在拼接路径时很常见），`startsWith` 就永远不成立 —— 于是**明明在里面的路径
 * 被判成外面**。Windows 上必现，POSIX 上看不出来。
 *
 * 大小写：Windows 不区分大小写，同一个目录可能以 `C:` 或 `c:` 出现，所以比较前折叠。
 */
export function isInside(root: string, candidate: string): boolean {
  const fold = (text: string): string => (process.platform === 'win32' ? text.toLowerCase() : text)
  const base = fold(resolve(root))
  const absolute = fold(resolve(base, candidate))
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return absolute === base || absolute.startsWith(prefix)
}

/**
 * 一出现就拒的目录名：里面放的是凭据，不是代码。
 *
 * 为什么不把整个 HOME 都算禁区：应用仓库自己就在 `~/.tenon/apps/<id>/repo` 里，
 * 而 `~/.npm`（依赖缓存）、`~/.gitconfig` 又必须让子进程能读到 —— 所以只钉这几个。
 */
const PRIVATE_NAMES = ['.ssh', '.aws', '.gnupg', '.netrc', '.config/gh'] as const

/** `cd` / `pushd`：目标可能不存在（`cd && ls` 会被 shell 当成"回家"）。`-` 也不可预测 */
const CD_PATTERN = /(?:^|[;&|(\n])\s*(?:cd|pushd)(?:\s+([^\s;&|)\n]+))?/g

/** `~` / `$HOME` / `${HOME}` 一律展开成真实的 home —— 后面要靠它算绝对路径 */
function expandHome(text: string): string {
  const home = homedir()
  return text.replace(/\$\{HOME\}/g, home).replace(/\$HOME\b/g, home).replace(/(^|[\s"'=:(])~(?=\/|$)/gm, `$1${home}`)
}

/**
 * 命令里出现的、指向 `~/.tenon` 的路径片段。
 *
 * 为什么要单独拦它：`~/.tenon/tenon.db` 里有**所有应用**的数据与加密后的密钥，
 * `~/.tenon/apps/<别的 id>` 是别人的工作区 —— 这两件事跟"文件工具只能读 repo"是同一条规则，
 * 只是 bash 绕过了文件工具。而当前应用自己的 repo 也在 `.tenon` 下面，所以判的是**在不在 repo 内**。
 */
const TENON_PATH = /[^\s"'`;|&()<>]*\.tenon[^\s"'`;|&()<>]*/g

/**
 * bash 的护栏，**不是沙箱**（见文件头的 ⚠️）。
 *
 * 三条规则，只拦能静态确定的：
 * 1. `cd` / `pushd` 的目标出 `repo/` —— 这一条最要紧，因为它**一次改变后续所有相对路径的含义**，
 *    而 cwd 钉在 repo 是我们对模型的承诺。
 * 2. 命令里出现 `.tenon` 下**repo 之外**的路径 —— 那是别的应用的数据，或存密钥的库文件。
 * 3. 命令里出现宿主凭据目录（`~/.ssh` 等）。
 *
 * 刻意**不拦**：到 `/tmp`、`/etc` 的绝对路径，`curl`，`node -e`，`npm install`（要跑任意 postinstall）。
 * 拦了会挡掉正常流程，而挡不住的部分不会因为这几条变少 —— 那是沙箱的事。
 * 含 `$` / 反引号的片段**算不出就放行**：静态解析猜错的方向是把正常命令打死。
 */
export function bashGuard(repoDir: string): (args: Record<string, unknown>) => string | undefined {
  return (args) => {
    const command = args['command']
    if (typeof command !== 'string' || command.trim() === '') return undefined
    return checkCommand(repoDir, command)
  }
}

/** 纯函数，单独 export 是为了能直接测：不用起 harness */
export function checkCommand(repoDir: string, command: string): string | undefined {
  const home = homedir()

  for (const match of command.matchAll(CD_PATTERN)) {
    const target = match[1]
    // 没有参数（`cd && make`）等价于 `cd ~`；`cd -` 回到上一个目录，两个都不可预测
    if (target === undefined || target === '-') {
      return '拒绝：`cd` 没有指定目录（等价于回 home），而命令只能在应用工作区里跑。要换目录请用工作区内的相对路径。'
    }
    // `$(...)` / `$VAR` 这类静态算不出来，交给运行时；猜错方向是把正常命令打死
    if (/[$`]/.test(target)) continue
    if (!isInside(repoDir, expandHome(target))) {
      return `拒绝：这条命令把工作目录切到了应用工作区之外（${target}）。所有文件都在工作区（repo/）里，请改用相对路径。`
    }
  }

  const expanded = expandHome(command)

  for (const match of expanded.matchAll(TENON_PATH)) {
    const path = match[0]
    // 只是提到这个名字（`grep .tenon README.md`）不算访问；必须是路径形状
    if (!path.includes('/')) continue
    if (isInside(repoDir, path)) continue
    return `拒绝：${path} 不在这个应用的工作区里 —— 那里是别的应用的数据或本机的密钥库。这个应用只能碰 repo/ 里的文件。`
  }

  // 路径要当字面量比：home 里可能带 `.` / `+`，不转义会变成通配符（用户名带点的机器上必踩）
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 分隔符也要归一：Windows 上 home 是 `C:\Users\x`，而模型两种写法都会出现
  const slash = (text: string): string => text.replace(/\\/g, '/')

  for (const name of PRIVATE_NAMES) {
    // 前后都要是路径边界：`~/.ssh`、`/Users/x/.ssh/id_rsa` 都算；`foo.ssh2` 不算
    const target = literal(slash(`${home}/${name}`))
    const pattern = new RegExp(`(^|[\\s"'=:(])${target}(?=[/\\s"'\`;|&)]|$)`)
    if (pattern.test(slash(expanded))) {
      return `拒绝：命令访问了 ~/${name} —— 那是宿主凭据所在，不属于这个应用。要在项目里配置凭据，请用环境变量或工作区内的文件。`
    }
  }

  return undefined
}

function textOf(content: SourceUpdate['content']): string {
  if (content === undefined) return ''
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')
}

export interface AdaptOptions {
  /** 崩溃重跑是否允许重新执行一次（见下方 replay 说明） */
  replay: 'safe' | 'unsafe'
  outputLimits: { maxBytes: number; maxLines: number; retain: 'head' | 'tail' }
  /** 参数校验：返回非空字符串表示拒绝，并把这句话当错误结果交回模型 */
  guard?: (args: Record<string, unknown>) => string | undefined
}

/**
 * 把一个 `pi-coding-agent` 工具适配成 pi-durable 的 `ToolRegistration`。
 *
 * 关于 `replay`：崩溃后重跑只对**幂等**操作有意义。
 * - `read` / `write`：safe —— 重跑一次结果一样（write 是整体覆盖）
 * - `edit` / `bash`：unsafe —— `edit` 的 old_string 可能已经不匹配了，
 *   `bash` 更可能是 `npm install` 这种重复执行有副作用甚至危险的命令。
 *   unsafe 的语义是「崩溃后不再重跑，直接给它一个 error 结果，让模型重新决策」。
 */
function adapt(source: AnySourceTool, options: AdaptOptions): ToolRegistration {
  const registration: ToolRegistration = {
    name: source.name,
    description: source.description,
    parameters: source.parameters,
    replay: options.replay,
    outputLimits: options.outputLimits,
    async execute(args, api: ToolExecutionApi, context) {
      const input = (args ?? {}) as Record<string, unknown>
      if (options.guard !== undefined) {
        const rejection = options.guard(input)
        if (rejection !== undefined) {
          return { isError: true, output: [{ type: 'text', text: rejection }] }
        }
      }

      // onUpdate 给的是"累计快照"，api.output 要的是"增量"。快照一旦被截断就不再是前缀，
      // 那时停止实时推流（最终结果仍然完整）—— 比拼接出错强。
      let emitted = ''
      const onUpdate = (update: SourceUpdate): void => {
        const snapshot = textOf(update.content)
        if (snapshot === '' || !snapshot.startsWith(emitted)) return
        const delta = snapshot.slice(emitted.length)
        emitted = snapshot
        if (delta !== '') api.output(delta)
      }

      // 第五个参数（pi-coding-agent 的 ExtensionToolContext）刻意传 undefined：
      // 我们在建工具时就把 cwd 钉死在仓库里，bash 也用 `exposeSessionEnvironment: false`
      // 关掉了会话信息注入，四个工具都不会去碰上下文里的字段。
      const result = await source.execute(
        api.callId,
        input as never,
        context.abortSignal,
        onUpdate as never,
        undefined as never,
      )

      const details: unknown = result.details
      return {
        output: result.content as never,
        isError: result.isError === true,
        ...(details === undefined ? {} : { details: details as never }),
      }
    },
  }
  return registration
}

/** 文件类工具的路径守卫：只允许写/读 `repo/` 里面 */
function pathGuard(repoDir: string) {
  return (args: Record<string, unknown>): string | undefined => {
    const path = args['path']
    if (typeof path !== 'string' || path === '') {
      return '参数 `path` 缺失。所有文件路径都相对于应用工作区根目录。'
    }
    if (!isInside(repoDir, path)) {
      return `拒绝访问工作区之外的路径：${path}。只能读写应用工作区（repo/）里的文件。`
    }
    return undefined
  }
}

/** read / write / edit / bash 四个工具，`cwd` 钉在应用仓库 */
export function createCodingTools(options: CodingToolsOptions): ToolRegistration[] {
  const { repoDir } = options
  const guard = pathGuard(repoDir)

  const bash = createBashToolDefinition(repoDir, {
    // 不把 PI_* 会话信息注进子进程环境：那是 pi 的 CLI 概念，生成的应用不该看见
    exposeSessionEnvironment: false,
    // 子进程的 cwd 永远钉在仓库里，且环境变量先洗一遍
    spawnHook: ({ command, env }) => ({ command, cwd: repoDir, env: scrubEnv(env) }),
  })

  return [
    adapt(createReadToolDefinition(repoDir) as unknown as AnySourceTool, {
      replay: 'safe',
      outputLimits: FILE_OUTPUT_LIMITS,
      guard,
    }),
    adapt(createWriteToolDefinition(repoDir) as unknown as AnySourceTool, {
      replay: 'safe',
      outputLimits: FILE_OUTPUT_LIMITS,
      guard,
    }),
    adapt(createEditToolDefinition(repoDir) as unknown as AnySourceTool, {
      replay: 'unsafe',
      outputLimits: FILE_OUTPUT_LIMITS,
      guard,
    }),
    adapt(bash as unknown as AnySourceTool, {
      // bash 是唯一能绕开 pathGuard 的工具：文件工具只认 args.path，而命令里可以写任何路径。
      // 所以护栏放在**进执行器之前**，拒绝时把话说清让模型自己改（与文件工具同一套语义）
      guard: bashGuard(repoDir),
      replay: 'unsafe',
      outputLimits: BASH_OUTPUT_LIMITS,
    }),
  ]
}

/**
 * 工作区约定。写进系统提示词的短版本 —— 长了会挤掉真正有用的上下文。
 * 每条都是"模型不做就会真的坏"的事，不是风格偏好。
 */
const WORKSPACE_RULES = `You build one web application inside this git repository (the current working directory).

- Every file you create belongs to this app. Never read or write outside it.
- Read a file before editing it. Prefer small targeted edits over rewriting whole files.
- Tenon owns version control: never run git commit, checkout, reset, or rebase yourself.
- Never start a long-running dev server (npm run dev, vite, nest start): Tenon's preview gateway does that.
- Each turn is committed automatically, so leave the workspace in a runnable state before you stop.`

/** 装到 registry 上的扩展：四个写工具 + 三个只读检索 + 一段工作区约定 */
export function codingExtension(repoDir: string): Extension {
  return defineExtension({
    name: CODING_EXTENSION,
    tools: [...createCodingTools({ repoDir }), ...createSearchTools({ repoDir })],
    // section 的 key 被限制为 /^[a-z][a-z0-9_-]*$/，点号会让整轮 submit 直接 INTERNAL
    sections: [section('tenon_workspace', () => WORKSPACE_RULES)],
  })
}
