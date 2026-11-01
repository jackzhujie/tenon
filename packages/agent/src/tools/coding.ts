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
 * - bash：`cwd` 强制钉在 `repo/`；环境变量按名字洗掉密钥与 `TENON_*`（生成的应用子进程会继承）。
 *   不做系统调用级别的沙箱 —— 那是 M7 的 `gondolin` / 权限清单（DESIGN §15.3）。
 */
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

/** 归一化后的路径必须落在 root 之内；`../` 与绝对路径都要挡住 */
export function isInside(root: string, candidate: string): boolean {
  const absolute = resolve(root, candidate)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return absolute === root || absolute.startsWith(prefix)
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
