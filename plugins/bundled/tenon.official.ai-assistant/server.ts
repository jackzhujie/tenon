/**
 * AI 小助手的服务端半边（chord 的 server facet）。
 *
 * 它只做三件事：把问题记进状态、把活交给宿主给的能力（`brain`）、把回答记回状态。
 * **自己不碰模型、不碰网络、不碰数据库** —— 那些是宿主的能力边界：
 * 组件清单里写的 `permissions` 是它**被允许**用什么的声明，而真正能用的东西由宿主注入。
 * 这样组件换一个宿主（不同的模型、不同的计费方式）不用改一行代码。
 *
 * 三条从 Spike 5 换来的硬约束（`docs/SPIKES.md` §7，忘了就静默坏）：
 * 1. `serve(...)` 必须给 `linger`：对象默认 `lifetime:"referenced"`，最后一个引用释放就连
 *    state 一起销毁 —— 表现是"每发一次请求，对话记录归零"，而且不报错。
 * 2. 判断（能不能用）必须写在 factory 里，不能写在方法里再抛 `forbidden`。
 * 3. 方法里抛的错要带 `invalid(reason, message)`，那是唯一能原样回到调用方的形状。
 */
import { Type } from 'typebox'
import { invalid, type Host } from '@earendil-works/chord'
import { Assistant, Message, type Principal } from './contract.js'

/** 宿主注入的能力：问一句、拿一段回答。组件不知道背后是哪个模型 */
export interface AssistantBrain {
  complete(input: { appId: string; text: string }): Promise<string>
}

export interface ActivateInput {
  readonly host: Host<Principal>
  readonly appId: string
  readonly brain: AssistantBrain
  readonly log?: (line: string) => void
}

/**
 * 对象在最后一次调用之后还能活多久。
 *
 * 30 分钟：用户问完一句可能去看代码、过一会儿再回来问。比这更久也没意义 ——
 * 对话记录本身在模型侧的会话里，这里丢的只是"界面上的气泡"。
 */
const LINGER_MS = 30 * 60_000

export function activate(input: ActivateInput): void {
  const { host, appId, brain, log } = input

  host.serve(
    Assistant,
    ({ appId: inputAppId }, principal, self) => {
      if (inputAppId !== appId || principal.appId !== appId) {
        // 一个组件的对象不该被别的应用拿到：input 与 principal 都必须指向这个应用
        throw invalid('principal', `这个组件属于应用 ${appId}，不是 ${inputAppId}`)
      }

      // 名字不能叫 status（chord 的 Ref 自带 status）—— 见 contract.ts 的说明
      const phase = self.state('phase', Type.String(), 'idle')
      const messages = self.state('messages', Type.Array(Message), [])
      const turns = self.state('turns', Type.Number(), 0)

      return {
        variant: 'user',
        phase,
        messages,
        turns,

        ask: async ({ text }, ctx) => {
          const question = text.trim()
          if (question === '') throw invalid('input', '问题不能为空')
          // 不排队：并发提问会让两条回答交错写进同一个 transcript，读起来像模型精神分裂
          if (phase.value === 'thinking') throw invalid('busy', '上一个问题还在回答中')

          messages.change(ctx, (list) => [...list, { role: 'user', text: question }])
          phase.replace(ctx, 'thinking')
          try {
            const answer = await brain.complete({ appId, text: question })
            messages.change(ctx, (list) => [...list, { role: 'assistant', text: answer }])
            turns.change(ctx, (n) => n + 1)
          } catch (error) {
            /*
             * 回答失败**不算调用失败**：这是"这座房子里没有大脑"（没配模型、额度用完），
             * 不是"你调错了方法"。把它写进对话里，用户才知道该去设置页 —— 抛出去
             * 只会变成一个红叉加一句 INTERNAL。
             */
            const reason = error instanceof Error ? error.message : String(error)
            log?.(`[assistant] 回答失败：${reason}`)
            messages.change(ctx, (list) => [...list, { role: 'system', text: `没能回答：${reason}` }])
          } finally {
            phase.replace(ctx, 'idle')
          }
        },

        // 无参方法的实现签名是 `(ctx)` —— 有入参才是 `(args, ctx)`（Spike 5 撞过）
        clear: async (ctx) => {
          messages.replace(ctx, [])
          turns.replace(ctx, 0)
        },
      }
    },
    // ★ 少了这一行，state 会随 root 销毁 —— 见文件头第 1 条
    { linger: LINGER_MS },
  )
}
