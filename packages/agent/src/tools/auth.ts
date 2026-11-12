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
                'This app already has sign-in (package.json `tenon.auth` is true). Nothing was changed.\n' +
                'Next: new endpoints require a session by default; to make one public, decorate it with `@Public()` (api/auth/public.decorator.ts).\n' +
                'Read the current user with `@CurrentUser() user: SessionUser` and filter data by user.id.',
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
          ? 'Added accounts and sign-in to this app.'
          : `Added accounts and sign-in to this app — ${reason}.`,
      )
      if (result.addedBackend) {
        lines.push('This app had no backend, and sign-in cannot be enforced without one, so it was added too (NestJS + PostgreSQL).')
      }
      lines.push('')
      lines.push('How it behaves now:')
      lines.push('- Someone who is not signed in **cannot call any endpoint** (except /api/health and /api/auth/*)')
      lines.push('- The first visit shows a "create the first admin" screen; once that admin exists the door closes')
      lines.push('- Admins add people from the "members" panel in the top-right; signing out deletes the server-side session')
      lines.push('')
      lines.push('Added:')
      for (const file of result.files) lines.push(`- ${file}`)
      lines.push('')
      lines.push('How to use it from here:')
      lines.push('1. New endpoints require a session by default. To make one public you must add `@Public()` explicitly — never the other way around')
      lines.push('2. Read the current user with `@CurrentUser() user: SessionUser` and filter data by user.id.')
      lines.push('   Do not trust a userId sent by the front end')
      lines.push('3. Keep data requests inside `<AuthGate>` on the front end (main.tsx is already wrapped)')

      if (!result.wired) {
        lines.push('')
        lines.push(
          '★ One spot could not be wired automatically: src/main.tsx does not have the template\'s shape, so the sign-in page was not wrapped in. ' +
            'The endpoints already return 401, but the page has no sign-in form — please wrap <App/> in <AuthGate>.',
        )
      }
      for (const note of result.notes) lines.push('', `Note: ${note}`)
      return { output: [{ type: 'text', text: lines.join('\n') }] }
    },
  }

  return [add]
}

export function authExtension(options: AuthToolsOptions): Extension {
  return defineExtension({ name: AUTH_EXTENSION, tools: createAuthTools(options) })
}
