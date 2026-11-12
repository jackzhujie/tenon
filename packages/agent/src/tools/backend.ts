/**
 * 后端工具：`add_backend`。
 *
 * 为什么必须是**工具**而不是让 Agent 敲命令铺文件：这件事有四个下游，
 * 手做一定会漏一处（每一处的失败表现都不一样，而且都不像"你漏了一步"）：
 *
 * 1. `package.json` 的 `tenon.api` —— 漏了：网关认为这是纯前端，`/api` 永远 502
 * 2. `tsconfig.json` 的 `include` 加 `shared` —— 漏了：前端 `tsc` 报"不在项目里"，
 *    报错位置在 `src/api.ts`，看起来像后端的问题
 * 3. `eslint.config.mjs` 忽略 `dist-server` —— 漏了：lint 去扫编译产物，几百条"错误"
 * 4. `docs/AGENTS.md` 加一节 —— 漏了：下一次改页面 Agent 又用 localStorage 存数据，
 *    于是同一份状态有两个事实来源
 *
 * 这些都在 `@tenon/generator` 的 `applyApiFeature` 里一次做完（与 RPC 走同一条路径），
 * 工具只负责"什么时候该做"与"把结果说成人话"。
 */
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { defineExtension } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { applyApiFeature } from '@tenon/generator'

export const BACKEND_EXTENSION = 'tenon.backend'
export const ADD_BACKEND_TOOL = 'add_backend'

export interface BackendToolsOptions {
  readonly appId: string
  readonly repoDir: string
  /**
   * 加完之后让宿主接手：装依赖 + （预览开着就）重启。
   *
   * 不给也能用，但那样模型下一步跑 `tsc` 会看到一堆"找不到 @nestjs/core" ——
   * 它很可能开始 "修" 这个不存在的类型错误。所以 server 一定会给。
   */
  readonly onApplied?: (appId: string) => void | Promise<void>
}

export function createBackendTools(options: BackendToolsOptions): ToolRegistration[] {
  const add: ToolRegistration = {
    name: ADD_BACKEND_TOOL,
    description:
      'Add a real backend (NestJS + PostgreSQL) to THIS app, in place. Use it when the app needs ' +
      'data that survives reloads, server-side logic, files/uploads, or anything shared between ' +
      'users — instead of inventing localStorage. Creates api/ (entry, datasource, health), ' +
      'shared/ (zod contracts), migrations dir, and wires package.json.ports. Existing files and ' +
      'scripts are never overwritten. Idempotent: calling it twice does nothing the second time.',
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          description: 'One short sentence for the user: why this app needs a backend now.',
        }),
      ),
    }),
    replay: 'safe',
    async execute(rawArgs) {
      const reason = (rawArgs as { reason?: string }).reason?.trim() ?? ''
      const result = await applyApiFeature({ repoDir: options.repoDir })

      if (!result.applied) {
        // 已经是全栈了：别报错，说清楚现状 + 下一步该看哪
        return {
          output: [
            {
              type: 'text',
              text:
                'This app already has a backend (package.json `tenon.api` points at api/main.ts). Nothing was changed.\n' +
                'Next: put entities under api/, register them in the `entities` of api/db.ts and in api/app.module.ts, ' +
                'and put migrations in api/migrations/ (timestamped filenames; they run automatically on startup).',
            },
          ],
        }
      }

      try {
        await options.onApplied?.(options.appId)
      } catch {
        // 装依赖/重启预览失败不该让"加后端"这个动作报错：文件已经是对的
      }

      const lines: string[] = []
      lines.push(
        reason === ''
          ? 'Added a backend to this app (NestJS + PostgreSQL). Not a single line of front-end code was touched.'
          : `Added a backend to this app (NestJS + PostgreSQL) — ${reason}. Not a single line of front-end code was touched.`,
      )
      lines.push('')
      lines.push('Added:')
      for (const file of result.files) lines.push(`- ${file}`)
      if (result.addedScripts.length > 0) lines.push('', `Scripts added: ${result.addedScripts.join(', ')}`)
      lines.push('')
      lines.push('How to use it from here:')
      lines.push('1. Declare the shape of each endpoint in `shared/schema.ts` (zod) — both sides use it')
      lines.push('2. Add entity / service / controller under `api/`, then register them in the `entities` of `api/db.ts`')
      lines.push('   and in TypeOrmModule.forFeature([...]) inside `api/app.module.ts`')
      lines.push('3. Put migrations in `api/migrations/<timestamp>-Xxx.ts` (standard PG syntax only — must run on PGlite and real PG)')
      lines.push('4. Call it from the front end through `src/api.ts`, always with a relative path `/api/...`')
      lines.push('')
      lines.push('Three rules that must not break: one DATABASE_URL only; DATABASE_POOL_MAX is a capacity knob, not an environment flag;')
      lines.push('migrations are the only source of the schema (never turn on synchronize). These are also written into docs/AGENTS.md.')
      for (const note of result.notes) lines.push('', `Note: ${note}`)
      return { output: [{ type: 'text', text: lines.join('\n') }] }
    },
  }

  return [add]
}

export function backendExtension(options: BackendToolsOptions): Extension {
  return defineExtension({ name: BACKEND_EXTENSION, tools: createBackendTools(options) })
}
