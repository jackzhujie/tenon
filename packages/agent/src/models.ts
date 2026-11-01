/**
 * 模型解析（BYOK，DESIGN §4.2）。
 *
 * 三条路，按优先级：
 * 1. `TENON_FAUX=1` → pi-ai 自带的 `providers/faux`。**没有 API Key 也能跑通整条链路**，
 *    CI 与本地冒烟都靠它 —— 别去 mock harness，那会绕开真正要验的东西。
 * 2. 设置里选中的 provider profile（`provider_profiles.api_key_enc` 解密）→ 用
 *    `createProvider` + `api/openai-completions` 现场拼一个 openai 兼容 provider。
 *    **密钥不进 `process.env`**：生成应用的子进程会继承环境变量，那是真实的泄漏面。
 * 3. 都没有 → `AGENT_NO_MODEL`，让 UI 去引导配置，而不是偷偷回退到假模型。
 */
import type { MutableModels, Provider } from '@earendil-works/pi-ai/models'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import * as completions from '@earendil-works/pi-ai/api/openai-completions'
import type { FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { TenonError } from '@tenon/protocol'
import type { CoreServices } from '@tenon/core'
import { SETTING_KEYS } from '@tenon/core'
import { roleOfPrompt, type RoleId } from './roles.js'

export const FAUX_PROVIDER_ID = 'faux'
export const FAUX_MODEL_ID = 'faux-mini'
/** 生产默认值；profile.paramsJson 可覆盖（不同模型的上下文窗口差得很远） */
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192

export interface ModelChoice {
  readonly provider: string
  readonly modelId: string
}

/**
 * faux 的剧本一步。刻意用**自己的**窄类型而不是 pi 的 `AssistantMessage`：
 * 调用方（测试、演示脚本）不该为了写一句台词去 import pi（铁律 3）。
 */
export type ScriptStep = (
  | { readonly text: string }
  | { readonly tool: string; readonly args: Record<string, unknown> }
) & {
  /** 这一步是给哪个角色准备的（缺省 = builder）。子 Agent 有自己的队列 */
  readonly as?: RoleId
}

export interface ResolvedModel {
  readonly mode: 'faux' | 'openai-compatible'
  readonly choice: ModelChoice
  readonly models: MutableModels
  /**
   * faux 是"剧本式"的：每次生成都必须先塞一条响应，否则 harness 没有东西可流。
   * 真实 provider 下是 no-op。
   */
  primeTurn(userText: string): void
  /**
   * 测试/演示专用：给下一轮换一份剧本（`tool` 那一步会真的调用工具）。
   * 真实 provider 下是 no-op —— 生产路径永远不会走到这里。
   */
  script(steps: readonly ScriptStep[]): void
}

interface FauxHandle {
  appendResponses(messages: unknown[]): void
  setResponses(messages: unknown[]): void
}

/** faux 路由器看到的上下文（只用到这两栏） */
interface FauxMessage {
  readonly role?: string
  readonly content?: unknown
}

function readParams(paramsJson: string | null): { contextWindow?: number; maxTokens?: number } {
  if (paramsJson === null || paramsJson === '') return {}
  try {
    const parsed = JSON.parse(paramsJson) as Record<string, unknown>
    return {
      contextWindow:
        typeof parsed['contextWindow'] === 'number' ? parsed['contextWindow'] : undefined,
      maxTokens: typeof parsed['maxTokens'] === 'number' ? parsed['maxTokens'] : undefined,
    }
  } catch {
    return {}
  }
}

function buildFaux(): ResolvedModel {
  const faux = fauxProvider({
    provider: FAUX_PROVIDER_ID,
    models: [{ id: FAUX_MODEL_ID, contextWindow: 32_000 }],
    tokensPerSecond: 60,
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const handle = faux as unknown as FauxHandle

  /**
   * 分道队列：`builder` 与各子角色各一条。
   *
   * 为什么必须分道（踩过）：子 Agent 是**另一次 submit**，跟父会话抢同一条队列。
   * 父轮剧本 `[tool subagent, text]` 里那句 text 会被子会话先吃掉，
   * 父轮收尾就撞上 "No more faux responses queued" —— 表现是"派了活但没干活"。
   *
   * 为什么路由器要**把自己塞回队尾**：`faux` 的 `stream()` 是 `pendingResponses.shift()`，
   * 一个工厂只服务一次请求。不重入的话第二次请求（父轮收尾、或子会话的第二次生成）直接报错。
   */
  const lanes = new Map<string, Array<() => unknown>>()

  const laneOf = (messages: readonly FauxMessage[]): string => {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const text = typeof lastUser?.content === 'string' ? lastUser.content : ''
    return roleOfPrompt(text) ?? 'builder'
  }

  const router = (context: { messages: readonly FauxMessage[] }): unknown => {
    handle.appendResponses([router as never])
    const lane = laneOf(context.messages)
    const queue = lanes.get(lane) ?? []
    const step = queue.shift()
    lanes.set(lane, queue)
    if (step !== undefined) return step()
    if (lane !== 'builder') {
      return fauxAssistantMessage(`【faux · ${lane}】子 Agent 收到了任务，但没有为它写剧本。`)
    }
    const lastUser = [...context.messages].reverse().find((message) => message.role === 'user')
    const excerpt = (typeof lastUser?.content === 'string' ? lastUser.content : '').replace(/\s+/g, ' ').slice(0, 40)
    return fauxAssistantMessage(
      `【开发模式 · faux 模型】收到：「${excerpt}」。\n\n` +
        '这条回复来自 pi-ai 的本地假模型，用来验证「提交 → 流式 → 落库 → SSE」这条链路。' +
        '要接真模型，请在设置里添加提供商（OpenAI 兼容）并填入 API Key，然后把 agent.activeProviderId 指向它。',
    )
  }

  handle.setResponses([router as never])
  lanes.set('builder', [])

  return {
    mode: 'faux',
    choice: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
    models,
    primeTurn(_userText: string) {
      // 默认台词由路由器在"该道空了"时给，这里无事可做。
      // 剧本（script）优先：有台词就先消耗台词，空档才落回默认台词。
    },
    script(steps: readonly ScriptStep[]) {
      // 换剧本 = 清空所有道（包括子角色），避免上一轮的残留台词串到这一轮
      lanes.clear()
      for (const step of steps) {
        const lane = step.as ?? 'builder'
        const queue = lanes.get(lane) ?? []
        queue.push(() => toFauxStep(step))
        lanes.set(lane, queue)
      }
    },
  }
}

function toFauxStep(step: ScriptStep): FauxResponseStep {
  if ('text' in step) return fauxAssistantMessage(step.text)
  return fauxAssistantMessage([fauxToolCall(step.tool, step.args as never)], {
    // 不带这个，agent 循环不会去执行工具，只会当成一段"说完就停"的消息
    stopReason: 'toolUse',
  })
}

function buildOpenAICompatible(
  core: CoreServices,
  profileId: string,
): ResolvedModel {
  const profile = core.providers.find(profileId)
  if (profile === undefined) {
    throw new TenonError('AGENT_NO_MODEL', `选中的提供商已不存在：${profileId}`, { profileId })
  }
  const apiKey = core.providers.revealApiKey(profileId)
  if (apiKey === undefined) {
    throw new TenonError('AGENT_NO_MODEL', `提供商「${profile.label}」没有配置 API Key`, { profileId })
  }
  const baseUrl = profile.baseUrl ?? 'https://api.openai.com/v1'
  const params = readParams(profile.paramsJson)
  const modelId = profile.modelId

  const provider: Provider = createProvider({
    id: profile.id,
    name: profile.label,
    baseUrl,
    // 只保留 openai-completions：M1 的 BYOK 就这一种协议，其他协议等真需求进来再加
    api: {
      stream: completions.stream as never,
      streamSimple: completions.streamSimple as never,
    },
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        provider: profile.id as never,
        baseUrl,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: params.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      } as never,
    ],
    auth: {
      apiKey: {
        name: `${profile.label} API key`,
        resolve: async () => ({
          auth: { apiKey },
          source: 'Tenon 设置',
        }),
      },
    },
  })

  const models = createModels()
  models.setProvider(provider)
  return {
    mode: 'openai-compatible',
    choice: { provider: profile.id, modelId },
    models,
    primeTurn() {
      /* 真实 provider 不需要预置响应 */
    },
    script() {
      /* 只有 faux 有剧本 */
    },
  }
}

export interface ResolveModelOptions {
  env?: NodeJS.ProcessEnv
  /** 显式指定 profile，跳过设置里的默认值（测试用） */
  profileId?: string
}

export interface ModelPlan {
  readonly mode: 'faux' | 'openai-compatible'
  readonly profileId?: string
  readonly choice: ModelChoice
}

/**
 * 只**描述**会用哪个模型，不构造 provider、不抛错。
 * 给 `/health` 用：server 必须能在"还没配模型"的状态下正常启动，否则用户连设置页都进不去。
 */
export function planModel(core: CoreServices, options: ResolveModelOptions = {}): ModelPlan | undefined {
  const env = options.env ?? process.env
  if (env['TENON_FAUX'] === '1' || env['TENON_FAUX'] === 'true') {
    return { mode: 'faux', choice: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID } }
  }
  const requested = options.profileId ?? core.settings.get<string>(SETTING_KEYS.activeProviderId)
  const candidate =
    requested !== undefined && requested !== ''
      ? core.providers.find(requested)
      : core.providers.list().find((profile) => profile.hasApiKey)
  if (candidate === undefined) return undefined
  return {
    mode: 'openai-compatible',
    profileId: candidate.id,
    choice: { provider: candidate.id, modelId: candidate.modelId },
  }
}

export function resolveModel(core: CoreServices, options: ResolveModelOptions = {}): ResolvedModel {
  const plan = planModel(core, options)
  if (plan === undefined) {
    throw new TenonError(
      'AGENT_NO_MODEL',
      '还没有可用的模型。请在设置里添加提供商并填入 API Key；开发调试可设 TENON_FAUX=1 用假模型。',
    )
  }
  if (plan.mode === 'faux') return buildFaux()
  return buildOpenAICompatible(core, plan.profileId as string)
}
