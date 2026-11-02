/**
 * AI 小助手的契约 —— **一个组件对外唯一的事实**（DESIGN §21.2「这就是卯眼的尺寸公差」）。
 *
 * 两个宿主（服务端 facet / 浏览器 facet）只认这一份：类型名 + 版本 + input + 状态 + 方法。
 * 它不认识 Tenon，也不认识 React —— 换掉 UI 或换掉后端实现都不需要动这里。
 *
 * 为什么状态里放**整份对话**而不是逐条事件：chord 的状态是可观察 JSON，订阅者拿到
 * 快照 + 增量。把 `messages` 放进来，浏览器重连/整页刷新之后界面自己就能复原，
 * 不需要"重放历史"这套东西。反过来如果用一次性返回值，刷新即丢。
 */
import { Type } from 'typebox'
import { hostNamed, method, remote } from '@earendil-works/chord'

/**
 * 组件的 principal。
 *
 * V1 只有"这个应用的用户"一种身份 —— 收费/授权分流（`guest` / `licensed`）是 Phase 3 的事，
 * 但**判断必须写在 factory 里**（返回哪个 variant），不能写在方法里再抛 `forbidden`，
 * 否则前端仍然知道方法存在，插件页也没法按能力渲染。
 */
export type Principal = { readonly appId: string }

export const ASSISTANT_TYPE = 'tenon.official.ai-assistant'

export const Message = Type.Object({
  /** `user` | `assistant` | `system`（系统消息用来放"还没配模型"这类提示） */
  role: Type.String(),
  text: Type.String(),
})

export const Assistant = remote(ASSISTANT_TYPE, {
  version: 1,
  /** 每个应用一个对象：`(type, input, principal)` 决定身份 */
  input: Type.Object({ appId: Type.String() }),
  host: hostNamed('server'),
  variants: {
    user: {
      state: {
        /**
         * `idle` | `thinking`。界面靠它显不显示"思考中"。
         *
         * 名字不能叫 `status`：chord 的 Ref 自带 `status` / `error` / `variant` / `ready`
         * 等成员，状态字段撞名会在**定义契约那一刻**直接抛 `member name is reserved`。
         */
        phase: Type.String(),
        messages: Type.Array(Message),
        /** 问过几轮 —— 用量/配额感的雏形，也给"清空"一个可观察的复位信号 */
        turns: Type.Number(),
      },
      methods: {
        /** 问一句。回答写进 `messages`（状态推送回界面），返回值只给"成功与否"之外的少量信息 */
        ask: method(Type.Object({ text: Type.String() })),
        /** 清空对话（会话记录留在模型侧，只是界面重来） */
        clear: method(),
      },
    },
  },
})
