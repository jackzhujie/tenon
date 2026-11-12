/**
 * `subagent` 工具（DESIGN §5.1）：把一件只读的活派给子角色，拿回一段结论。
 *
 * 三个跟"看起来能跑"不一样的地方：
 *
 * 1. **子会话的模型/工具/指令必须在创建那一刻定好。**
 *    `api.conversation(id)` 拿到的是 `ConversationHandle`，只有 `submit/abort/waitForIdle` ——
 *    **没有 `configure`**。所以先建后配这条路是走不通的（会静默拿到一个"什么都没有"的会话，
 *    模型用默认工具集乱猜）。正确路径是 `harness.createConversation({ ownership, agent })`。
 *    工具因此需要拿到 Harness —— 由 `HarnessPool` 用闭包注入（它是唯一知道 harness 的地方）。
 *
 * 2. **幂等靠 `ownerTaskId` + 固定 `requestId`，不靠自己记。**
 *    一次工具调用就是一个 task；崩在这个工具里重跑时 `api.taskId` 不变，
 *    `scanConversations({ ownerTaskId })` 能找到上次建的子会话，
 *    `requestId: subagent:<role>` 能拿回同一次提交 —— 不会重复派活、也不会把答案丢给一个新会话。
 *    反过来说：**同一个 Builder 轮次里调两次 explore，是两个 task，两个子会话**（这是对的）。
 *
 * 3. **子会话里没有 `subagent`。** 白名单在 `roles.ts`，这里再兜一层：
 *    递归派活是失控的第一入口，不靠提示词自觉。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type {
  AgentChange,
  Conversation,
  Extension,
  Harness,
  ToolExecutionApi,
  ToolRegistration,
} from '@earendil-works/pi-durable'
import { UsageDoc, defineExtension, section } from '@earendil-works/pi-durable'
import { sumUsage } from '@tenon/core'
import { Type } from 'typebox'
import type { RawEntry } from '../normalize.js'
import { normalizeEntries } from '../normalize.js'
import {
  DELEGABLE_ROLES,
  ROLES,
  extensionNamesFor,
  modelToolsFor,
  plannedRejection,
  roleOf,
  subagentPrompt,
  toolsForRole,
  type RoleSpec,
} from '../roles.js'

export const SUBAGENT_EXTENSION = 'tenon.subagent'
export const SUBAGENT_TOOL = 'subagent'

/** 派活说明写进提示词。故意短：长了会挤掉真正有用的工作区约定 */
const DELEGATION_RULES = `You can delegate read-only investigation with the \`subagent\` tool:
- role=explore: find where something is implemented. Use it instead of reading ten files yourself.
- role=librarian: answer "how does this library / this project do X" from what is on disk.
- role=e2e: check the running app in the preview — it reads and clicks the real page, not the source. Use it after you change behaviour.
- role=reviewer: review what you just changed before it gets committed (diff + typecheck) and get a risk list. Use it when the change touches contracts, migrations or error paths.
- role=codeact: hand it batch work a script does better — filter a big search result, read twenty files and summarise, reshape JSON. One script, one conclusion, not a pile of raw output.
Delegate one concrete question per call, then use the answer. Do not delegate the thinking you are supposed to do.`

export interface SubagentToolOptions {
  /**
   * 懒取 Harness：扩展要在 `Harness.open` 之前建好（registry 得先有工具），
   * 所以这里拿不到实例，只能给一个读取器。调用发生在之后，那时一定有值。
   */
  getHarness: () => Harness | undefined
  /** 全部可用工具（registry 里那一份）；按角色白名单过滤 */
  getTools: () => readonly ToolRegistration[]
  /**
   * 全部装好的扩展：角色可能要额外装一个（CodeAct 的沙箱就是）。
   * 不给就只继承父会话的扩展 —— 与 M4 第 1 步的行为一致。
   */
  getExtensions?: () => readonly Extension[]
}

function errorResult(text: string): { isError: true; output: { type: 'text'; text: string }[] } {
  return { isError: true, output: [{ type: 'text', text }] }
}

function textOfMessage(message: { parts: readonly { type: string; text?: string }[] }): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim()
}

/**
 * 角色额外要的扩展 —— 只挑**子会话还没有的**。
 *
 * 子会话默认继承父会话的扩展（M4 第 1 步起就是），所以这里返回的通常是空。
 * 重复 `add` 同一个扩展会让创建会话那一步直接失败，别把父会话已有的再塞一遍。
 */
function extraExtensions(
  spec: RoleSpec,
  current: readonly Extension[],
  all: readonly Extension[],
): Extension[] {
  const names = extensionNamesFor(spec)
  if (names.length === 0) return []
  const have = new Set(current.map((item) => item.name))
  return all.filter((extension) => names.includes(extension.name) && !have.has(extension.name))
}

/** 子会话里最后一条 assistant 文本就是"结论" */
async function readAnswer(conversation: Conversation, context: typeof BACKGROUND_CONTEXT): Promise<string> {
  const view = await conversation.viewState(context)
  try {
    const messages = normalizeEntries(view.value.entries as unknown as RawEntry[])
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    return last === undefined ? '' : textOfMessage(last)
  } finally {
    await view.dispose?.()
  }
}

export function createSubagentTool(options: SubagentToolOptions): ToolRegistration {
  return {
    name: SUBAGENT_TOOL,
    description:
      'Delegate a read-only investigation to a sub agent and get its conclusion back. ' +
      'Roles: explore (locate code), librarian (answer from docs and on-disk type definitions), ' +
      'codeact (run one script over many files: filter, join, summarise), ' +
      'e2e (verify the running page in the preview), reviewer (risk list on the current change). ' +
      'One concrete question per call. The sub agent cannot edit files.',
    parameters: Type.Object({
      role: Type.Union(
        DELEGABLE_ROLES.map((id) => Type.Literal(id)),
        { description: 'Which sub agent to run' },
      ),
      task: Type.String({ description: 'One concrete question or instruction for the sub agent' }),
    }),
    // 崩溃重跑要命中同一个子会话与同一次提交：靠 ownerTaskId + 固定 requestId 保证
    replay: 'safe',
    async execute(args, api: ToolExecutionApi, context) {
      const input = args as { role?: string; task?: string }
      const task = typeof input.task === 'string' ? input.task.trim() : ''
      if (task === '') return errorResult('`task` must not be empty: give the sub agent one concrete question')

      const spec = input.role === undefined ? undefined : roleOf(input.role)
      if (spec === undefined || !DELEGABLE_ROLES.includes(spec.id)) {
        const available = DELEGABLE_ROLES.map((id) => ROLES[id].label).join(' / ')
        return errorResult(`No such role: ${String(input.role)}. Available: ${available}`)
      }
      const planned = plannedRejection(spec)
      if (planned !== undefined) {
        // 明确报"还没接"，不让模型以为是自己参数写错了
        return errorResult(planned)
      }

      const tools = toolsForRole(spec, options.getTools())
      if (tools.length === 0) {
        return errorResult(`${spec.label} has none of its tools registered (expected: ${spec.tools.join(' / ')})`)
      }
      const harness = options.getHarness()
      if (harness === undefined) return errorResult('The harness is not ready yet — retry in a moment')

      // 1. 上次重跑到这里时建过的子会话（同一个工具 task 只该有一个）
      const existing = await api.commit(
        async (tx) => (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0] ?? null,
        context,
      )
      let child = existing === null ? undefined : await harness.conversation(existing.id, context)
      const reused = child !== undefined

      // 2. 没有就建：模型/工具/指令必须在创建这一步给全（见文件头第 1 条）
      if (child === undefined) {
        const parentAgent = await api.agent(context)
        const modelTools = modelToolsFor(spec, tools)
        const extra = extraExtensions(spec, parentAgent.extensions, options.getExtensions?.() ?? [])
        const agent: AgentChange = {
          tools,
          /*
           * 只递给模型它该看的那些。CodeAct 的 `read/ls/glob/grep` 是**给脚本调的** ——
           * 全递给模型，它就会绕过脚本一次次直读，"四十次 read 只回一行结论"就没了。
           * 一样多时不必写：`modelTools` 不写等于"全给"。
           */
          ...(modelTools.length === tools.length
            ? {}
            : { modelTools: modelTools as readonly ToolRegistration[] }),
          ...(extra.length === 0 ? {} : { extensions: { add: extra } }),
          instructions: spec.instructions,
          cwd: parentAgent.cwd,
          ...(parentAgent.model === undefined ? {} : { model: parentAgent.model }),
        }
        child = await harness.createConversation(
          { ownership: { kind: 'task', taskId: api.taskId }, agent },
          context,
        )
      }

      /*
       * 先把"派给谁"写下来再干活：工具中途崩了，这条记录仍然有用（谁派的、派到哪个会话）。
       * 花多少要等跑完才知道，所以在下面再写一次（`details()` 是"最后一次覆盖"）。
       */
      const detailOf = (
        spend: Spend | null,
      ): { role: string; conversationId: string; reused: boolean; tools: string[]; spend?: Spend } => ({
        role: spec.id,
        conversationId: String(child.id),
        reused,
        tools: tools.map((tool) => tool.name),
        ...(spend === null ? {} : { spend }),
      })
      await api.details(detailOf(null), context)

      // 3. 派活。requestId 固定 → 重跑时拿回同一次提交，不会把同一件事做两遍
      const submission = await child.submit(
        { type: 'input', content: subagentPrompt(spec.id, task), requestId: `subagent:${spec.id}` },
        context,
      )
      const settled = await submission.wait(context)
      const answer = await readAnswer(child, context)
      /*
       * **这次派活花了多少**（v1.2.19）。
       *
       * 为什么是"单次"而不是"按角色累计"：累计会被历史稀释，指导不了"下次还该不该派"；
       * 而这一次的数字直接可用。代价只有一次文档读（`pi.usage` 本来就在子会话里）。
       *
       * 失败也要记 —— 派出去但没给出结论的那次同样烧了钱，用户更需要看见。
       */
      const spend = await readSpend(harness, child, context)
      await api.details(detailOf(spend), context)

      if (settled.status !== 'done') {
        return errorResult(`${spec.label} did not reach a conclusion (${settled.status})${answer === '' ? '' : `: ${answer}`}`)
      }
      if (answer === '') {
        return errorResult(`${spec.label} finished but produced no answer`)
      }
      return {
        output: [
          {
            type: 'text',
            text: `${spec.label} concluded (sub conversation #${String(child.id)}):\n${answer}`,
          },
        ],
      }
    },
  }
}

type Spend = {
  totalTokens: number
  costUsd: number
}

/**
 * 读一个子会话自己的账本。
 *
 * 为什么不从父会话的 `usage()` 里减：父会话的账本只统计自己那条会话，子会话的花费
 * 根本不经过它的 `pi.usage`（这是"嵌套调用不进父会话事件流"的另一面）。
 * 而每个会话的用量是一个独立的文档（`UsageDoc`），按会话 id 直接读得到 —— 公开 API，
 * 不需要改宿主。
 *
 * 读不到就返回 `null`（不抛、也不写一个 0）：工具结果不该因为一段统计而失败，
 * 而 `0 tokens` 会被读成"这次派活不要钱"，那是错的。
 */
async function readSpend(
  harness: Harness,
  child: Conversation,
  context: typeof BACKGROUND_CONTEXT,
): Promise<Spend | null> {
  try {
    const state = await harness.snapshot(UsageDoc, child.id, context)
    if (state === undefined) return null
    const { totals } = sumUsage(state)
    return { totalTokens: totals.totalTokens, costUsd: totals.costUsd }
  } catch {
    return null
  }
}

export function subagentExtension(options: SubagentToolOptions): Extension {
  return defineExtension({
    name: SUBAGENT_EXTENSION,
    tools: [createSubagentTool(options)],
    sections: [section('tenon_delegation', () => DELEGATION_RULES)],
  })
}
