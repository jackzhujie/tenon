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
                '这个应用已经有后端了（package.json 的 tenon.api 指向 api/main.ts），什么都没改。\n' +
                '接着做：实体写在 api/，在 api/db.ts 的 entities 与 api/app.module.ts 里登记，' +
                '迁移放 api/migrations/（文件名带时间戳，启动时自动跑）。',
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
          ? '已给这个应用加上后端（NestJS + PostgreSQL），前端代码一行没动。'
          : `已给这个应用加上后端（NestJS + PostgreSQL）——${reason}。前端代码一行没动。`,
      )
      lines.push('')
      lines.push('新增：')
      for (const file of result.files) lines.push(`- ${file}`)
      if (result.addedScripts.length > 0) lines.push('', `补的脚本：${result.addedScripts.join('、')}`)
      lines.push('')
      lines.push('接下去这样用：')
      lines.push('1. `shared/schema.ts` 里定义接口的形状（zod），前后端都用它')
      lines.push('2. `api/` 下加 entity / service / controller，在 `api/db.ts` 的 entities 与')
      lines.push('   `api/app.module.ts` 的 TypeOrmModule.forFeature([...]) 里登记')
      lines.push('3. 迁移放 `api/migrations/<时间戳>-Xxx.ts`（只用标准 PG 语法，PGlite 与真 PG 都要能跑）')
      lines.push('4. 前端从 `src/api.ts` 调，一律相对路径 `/api/...`')
      lines.push('')
      lines.push('三条不能破的约定：只认一个 DATABASE_URL；DATABASE_POOL_MAX 是容量参数不是环境标记；')
      lines.push('迁移是 schema 的唯一来源（永远不开 synchronize）。这些也写进了 docs/AGENTS.md。')
      for (const note of result.notes) lines.push('', `注意：${note}`)
      return { output: [{ type: 'text', text: lines.join('\n') }] }
    },
  }

  return [add]
}

export function backendExtension(options: BackendToolsOptions): Extension {
  return defineExtension({ name: BACKEND_EXTENSION, tools: createBackendTools(options) })
}
