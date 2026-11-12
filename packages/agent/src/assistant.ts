/**
 * 「组件的大脑」：一段**没有工具**的对话能力，注入给需要模型的组件（M5 第 3 步）。
 *
 * 为什么不让组件自己去调模型：那意味着把 provider 密钥、额度、计费口径复制到每个插件里，
 * 而且 `permissions: ["net:fetch:…"]` 会变成一句空话。宿主给一个 `complete({appId, text})`，
 * 组件只知道"问一句、拿一句话"，换模型、换计费方式都不用改组件。
 *
 * 实现走的是**已经验过的那条路**：`harness.createConversation({ ownership: 'ownerless', agent })`
 * + `submit` + `wait` + 读最后一条 assistant 文本 —— 与 `subagent` 工具完全同一套原语
 * （那边是 M4 第 1 步验过的）。这里只多两件事：
 *
 * 1. **`tools: []`**。小助手不该改代码、跑命令、提交。工具集为空不是靠提示词约束的。
 * 2. **一个应用一个会话**（懒建、常驻）。多轮对话才有上下文；`requestId` 每次唯一，
 *    所以不会像 subagent 那样"重跑拿回同一次提交" —— 问两次同一个问题就该答两次。
 *
 * 与 `ChatService` 的分工：那是**给开发者改应用**的（有工具、有提交、有 SSE 事件）。
 * 这里是**给最终用户聊天**的（无工具、无提交、不出现在主对话里）。
 */
import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation } from '@earendil-works/pi-durable'
import type { TenonHome } from '@tenon/core'
import { appPaths } from '@tenon/core'
import { msg, TenonError } from '@tenon/protocol'
import type { HarnessPool } from './harness-pool.js'
import type { ResolvedModel } from './models.js'
import { normalizeEntries, type RawEntry } from './normalize.js'

const ctx = BACKGROUND_CONTEXT

/**
 * 组件的系统提示词。
 *
 * 刻意短：它拿不到工具、拿不到文件，说多了只是烧 token。**不要**把这段写进组件清单 ——
 * 提示词属于宿主策略，组件换一个宿主（比如企业版换成法务口径）不该改组件代码。
 */
const INSTRUCTIONS = `You are a small in-app assistant embedded in a web application built by Tenon.
The user of the application talks to you; the developer of the application does not.
Answer in the user's language, in a few short sentences. You cannot run commands, read files,
change code, or look anything up — you only have the conversation. If the answer needs data you
do not have, say so plainly and suggest what the user could check in the app.`

export interface AssistantAsk {
  readonly appId: string
  readonly text: string
}

export interface AssistantCapability {
  /** 问一句、拿一段回答。失败时抛（调用方决定是显示成对话里的一条还是当成错误）*/
  complete(input: AssistantAsk): Promise<string>
  /** 只丢引用；真正的存储由 `agent.close()` 收 */
  close(): void
}

export interface AssistantOptions {
  readonly pool: HarnessPool
  readonly model: ResolvedModel
  readonly home: TenonHome
}

/** 一条会话里最多留多少条消息：越聊越贵，而且这家助手的价值不在长上下文 */
const MAX_ENTRIES = 60

function textOf(message: { parts: readonly { type: string; text?: string }[] }): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim()
}

async function lastAssistantText(conversation: Conversation): Promise<string> {
  const view = await conversation.viewState(ctx)
  try {
    const entries = view.value.entries as unknown as RawEntry[]
    const messages = normalizeEntries(entries.slice(-MAX_ENTRIES))
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    return last === undefined ? '' : textOf(last)
  } finally {
    await view.dispose?.()
  }
}

export function createAssistant(options: AssistantOptions): AssistantCapability {
  const conversations = new Map<string, Promise<Conversation>>()

  async function open(appId: string): Promise<Conversation> {
    const session = await options.pool.acquire(appId)
    return session.harness.createConversation(
      {
        /*
         * `ownerless`：不挂在任何任务上。它既不参与"一个任务失败就整棵子树 abort"，
         * 也不会因为主对话一轮结束而被回收 —— 小助手的对话本来就跨轮次活着。
         */
        ownership: { kind: 'ownerless' },
        agent: {
          model: options.pool.modelChoice,
          tools: [],
          instructions: INSTRUCTIONS,
          cwd: appPaths(options.home, appId).repoDir,
        },
      },
      ctx,
    )
  }

  async function conversationFor(appId: string): Promise<Conversation> {
    const existing = conversations.get(appId)
    if (existing !== undefined) return existing
    const opening = open(appId)
    conversations.set(appId, opening)
    try {
      return await opening
    } catch (error) {
      // 建不起来就别把失败缓存住：用户配好模型之后要能立刻再试
      conversations.delete(appId)
      throw error
    }
  }

  return {
    async complete({ appId, text }) {
      const question = text.trim()
      if (question === '') throw new TenonError('VALIDATION_FAILED', msg('error.assistant.questionEmpty'))

      const conversation = await conversationFor(appId)
      /*
       * faux 是剧本式的：每次生成之前必须先塞一条响应，否则 harness 没有东西可流。
       * 真实 provider 下这是个 no-op —— 所以这句在两种模式下都安全，不是测试后门。
       */
      options.model.primeTurn(question)

      const submission = await conversation.submit(
        { type: 'input', content: question, requestId: `assistant:${randomUUID()}` },
        ctx,
      )
      const settled = await submission.wait(ctx)
      const answer = await lastAssistantText(conversation)

      if (settled.status !== 'done') {
        throw new TenonError(
          'AGENT_UNAVAILABLE',
          msg('error.assistant.notSettled', {
            status: settled.status,
            // 连标点一起决定：中文用破折号、英文也用破折号，两种语言都不别扭
            detail: answer === '' ? '' : ` — ${answer}`,
          }),
        )
      }
      if (answer === '') throw new TenonError('AGENT_UNAVAILABLE', msg('error.assistant.noAnswer'))
      return answer
    },

    close() {
      conversations.clear()
    },
  }
}
