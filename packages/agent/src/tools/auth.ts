/**
 * 账号工具：`add_auth`。
 *
 * 为什么不是一个参数挂在 `add_backend` 上：这两件事的触发时机不一样，而且失败后果
 * 差得远 —— 加后端失败是"接口 502"，加登录失败可能是"接口全公开但没人知道"。
 * 合成一个工具之后，模型只要传错一个布尔值就会把后者变成静默状态。
 *
 * 为什么必须是**工具**而不是让 Agent 手写：这一步有四处**不会报错**的下游
 * （db.ts 登记实体、app.module.ts 挂模块、main.tsx 包闸门、AGENTS.md 加一节），
 * 漏任何一个的表现都是"编译通过、页面正常、鉴权没生效"。工具一次做完并**检查结果**。
 */
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { defineExtension } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { applyAuthFeature } from '@tenon/generator'

export const AUTH_EXTENSION = 'tenon.auth'
export const ADD_AUTH_TOOL = 'add_auth'

export interface AuthToolsOptions {
  readonly appId: string
  readonly repoDir: string
  /**
   * 加完之后让宿主接手：装依赖 + （预览开着就）重启。
   *
   * 与加后端共用同一个钩子：两者做完都需要"把已经跑着的后端按新代码重启一次"，
   * 分成两个回调只会让 server 那边写两遍同样的 try/catch。
   */
  readonly onApplied?: (appId: string) => void | Promise<void>
}

export function createAuthTools(options: AuthToolsOptions): ToolRegistration[] {
  const add: ToolRegistration = {
    name: ADD_AUTH_TOOL,
    description:
      'Add accounts and login to THIS app: users + sessions tables, /api/auth/* endpoints, ' +
      'a global guard that rejects every request by default, a login page, and admin-managed ' +
      'members. Use it when more than one person will use the app, or when data must not be ' +
      'readable by anyone who has the URL. It adds a backend first if the app has none ' +
      '(login cannot be enforced in the browser). Existing files are never overwritten; ' +
      'idempotent: calling it twice does nothing the second time.',
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          description: 'One short sentence for the user: why this app needs login now.',
        }),
      ),
    }),
    replay: 'safe',
    async execute(rawArgs) {
      const reason = (rawArgs as { reason?: string }).reason?.trim() ?? ''
      const result = await applyAuthFeature({ repoDir: options.repoDir })

      if (!result.applied) {
        return {
          output: [
            {
              type: 'text',
              text:
                '这个应用已经有登录了（package.json 的 tenon.auth 是 true），什么都没改。\n' +
                '接着做：新接口默认就要登录；要公开某个接口给它挂 `@Public()`（api/auth/public.decorator.ts）。\n' +
                '取当前用户用 `@CurrentUser() user: SessionUser`，并按 user.id 过滤数据。',
            },
          ],
        }
      }

      try {
        await options.onApplied?.(options.appId)
      } catch {
        // 装依赖/重启预览失败不该让"加登录"这个动作报错：文件已经是对的
      }

      const lines: string[] = []
      lines.push(
        reason === ''
          ? '已给这个应用加上账号体系。'
          : `已给这个应用加上账号体系——${reason}。`,
      )
      if (result.addedBackend) {
        lines.push('这个应用原来没有后端，登录必须有后端才能拦得住，所以一并补上了（NestJS + PostgreSQL）。')
      }
      lines.push('')
      lines.push('现在的行为：')
      lines.push('- 没登录的人**调不动任何接口**（除了 /api/health 与 /api/auth/*）')
      lines.push('- 第一次打开会显示"创建第一个管理员"，建完这个口子自动关闭')
      lines.push('- 管理员在右上角「成员」里加人；退出登录会删掉服务端那条会话')
      lines.push('')
      lines.push('新增：')
      for (const file of result.files) lines.push(`- ${file}`)
      lines.push('')
      lines.push('接下去这样用：')
      lines.push('1. 新接口默认就要登录。要公开必须显式挂 `@Public()` —— 别反过来做')
      lines.push('2. 取当前用户：`@CurrentUser() user: SessionUser`，用 user.id 过滤数据，')
      lines.push('   不要信前端传来的 userId')
      lines.push('3. 前端把数据请求都放在 `<AuthGate>` 里面（main.tsx 里已经包好了）')

      if (!result.wired) {
        lines.push('')
        lines.push(
          '★ 有一处没自动接上：src/main.tsx 的形状和模板不一样，登录页没能包进去。' +
            '现在接口已经会返回 401，但页面上没有登录框 —— 请把 <App/> 包进 <AuthGate>。',
        )
      }
      for (const note of result.notes) lines.push('', `注意：${note}`)
      return { output: [{ type: 'text', text: lines.join('\n') }] }
    },
  }

  return [add]
}

export function authExtension(options: AuthToolsOptions): Extension {
  return defineExtension({ name: AUTH_EXTENSION, tools: createAuthTools(options) })
}
