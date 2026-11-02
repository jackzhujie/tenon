/**
 * 评审工具：`git_diff` + `typecheck`（M4 第 5 步，给 Reviewer 子角色用）。
 *
 * 这两个工具回答的是同一个问题的两半，**顺序不能反**：
 * - `git_diff` 说"这一轮到底改了哪些行"（事实）
 * - `typecheck` 说"这些改动有没有把类型搞坏"（判据）
 *
 * 只看 diff 的评审会变成猜："这里少了 try/catch 吧？"；只看 typecheck 的评审更糟 ——
 * 类型全绿但契约漂移（前端还在读 `res.userId`，后端已经改成 `res.user.id`）它一个字都不会说。
 * 所以提示词里写死「先 diff 再 typecheck」，工具描述里也互相指路。
 *
 * 三条与"评审"这个场景强相关的取舍：
 * 1. **默认看工作区，不看提交**。Reviewer 被派活时这一轮还没结束、代码还没 commit
 *    （`commitAll` 在一轮收尾时才跑）。给一个"只能看已提交版本"的工具等于让评审永远看上一版。
 * 2. **类型错误不是工具错误**（`isError: false`）。那是"代码有问题"，评审该把它写进风险清单；
 *    标成错误会让模型换个姿势重试工具。
 * 3. **"没跑成"绝不报成"通过"**。缺 `node_modules`、没有 `tsconfig`、`tsc` 超时 —— 三种情况
 *    各自有一句明确的话，且都不出现 `✓`。评审里最坏的假绿就是这一条。
 *
 * 跑 `tsc` 的实现搬去了 `../checks.ts`：发布门禁（M4 第 7 步）要的是同一件事，只能有一个
 * "什么算通过"的答案。这里只剩"把它讲给模型听"。
 */
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { defineExtension } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { gitops } from '@tenon/core'
import { runTypecheck } from '../checks.js'

export const REVIEW_EXTENSION = 'tenon.review'
export const REVIEW_TOOL_NAMES = ['git_diff', 'typecheck'] as const

/** 一次回给模型的 diff 上限。超了就截断并说明 —— 评审不需要读完一份两百行的补丁 */
const MAX_PATCH_BYTES = 48 * 1024

export interface ReviewToolsOptions {
  /** 应用仓库目录（`apps/<id>/repo`） */
  repoDir: string
  /** 测试用：跑 tsc 的 node 可执行文件（默认真实 `process.execPath`） */
  nodePath?: string
  /** 测试用：tsc 入口（默认 `<repo>/node_modules/typescript/bin/tsc`） */
  tscEntry?: string
  /** 单次类型检查超时（默认 60s） */
  timeoutMs?: number
}

type Text = { output: { type: 'text'; text: string }[]; isError?: boolean }

function ok(text: string): Text {
  return { output: [{ type: 'text', text }] }
}

function fail(text: string): Text {
  return { isError: true, output: [{ type: 'text', text }] }
}

function clip(text: string, maxBytes: number): { text: string; clipped: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text, clipped: false }
  // 按字节截断可能切在多字节字符中间，退回一个安全长度再 trim
  const safe = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return { text: `${safe.replace(/\uFFFD+$/, '')}\n…（已截断，原文 ${(bytes / 1024).toFixed(0)}KB）`, clipped: true }
}

export function createReviewTools(options: ReviewToolsOptions): ToolRegistration[] {
  const { repoDir } = options

  const gitDiff: ToolRegistration = {
    name: 'git_diff',
    description:
      'See exactly which lines this turn changed inside the app repository. ' +
      'By default it diffs the working tree against HEAD (uncommitted changes — that is what a review ' +
      'before commit looks like). Pass commit:"HEAD" to review the last commit instead. ' +
      'Returns a unified patch per file plus +/− counts. Use it first, then typecheck.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Only this file or directory (repo-relative)' })),
      commit: Type.Optional(
        Type.String({ description: 'Review this commit instead of the working tree (e.g. "HEAD")' }),
      ),
    }),
    replay: 'safe',
    async execute(args) {
      const input = args as { path?: string; commit?: string }
      let result: Awaited<ReturnType<typeof gitops.worktreeDiff>> | Awaited<ReturnType<typeof gitops.showCommit>>
      try {
        result =
          input.commit === undefined
            ? await gitops.worktreeDiff(repoDir)
            : await gitops.showCommit(repoDir, input.commit)
      } catch (err) {
        return fail(
          `读不了这个仓库的改动：${err instanceof Error ? err.message : String(err)}。` +
            '（这个应用应该自动初始化过 git 仓库；如果反复失败，告诉用户而不是继续猜。）',
        )
      }

      const filter = typeof input.path === 'string' && input.path !== '' ? input.path.replace(/^\.\//, '') : undefined
      const files = filter === undefined ? result.files : result.files.filter((file) => file.path.startsWith(filter))

      if (files.length === 0) {
        if (filter !== undefined) {
          return ok(`这个改动里没有涉及 ${filter} 的文件。`)
        }
        return ok(
          input.commit === undefined
            ? '工作区是干净的：没有任何未提交的改动（这一轮可能什么都没改，或者改动已经提交）。' +
                '想评审上一版提交就传 commit:"HEAD"。'
            : '这条提交没有改动任何文件。',
        )
      }

      const insertions = files.reduce((sum, file) => sum + file.insertions, 0)
      const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
      const base =
        'base' in result && result.base !== undefined ? `相对 ${result.base.slice(0, 7)}` : '相对空仓库'
      const rows = files.map((file) => `### ${file.path}  (${file.status}, +${file.insertions} −${file.deletions})`)
      const body = files.map((file) => file.patch.trimEnd()).join('\n')
      const omitted = 'omitted' in result ? result.omitted : 0
      const tail =
        omitted > 0
          ? `\n\n… 还有 ${omitted} 个文件没展开。用 read / grep 直接看它们，别假设它们没问题。`
          : ''
      const clipped = clip(
        `${base}的改动：${files.length} 个文件（+${insertions} −${deletions}）\n\n${rows.join('\n')}\n\n${body}${tail}`,
        MAX_PATCH_BYTES,
      )
      return ok(clipped.text)
    },
  }

  const typecheck: ToolRegistration = {
    name: 'typecheck',
    description:
      'Run the app\'s own TypeScript compiler (tsc --noEmit) over its tsconfig(s) and return the errors. ' +
      'Needs the app dependencies installed (node_modules). A failing typecheck is information, not a tool ' +
      'error: put it in your risk list. If it says "没跑成", the check did NOT happen — do not treat it as passing.',
    parameters: Type.Object({
      timeoutMs: Type.Optional(Type.Number({ description: 'Per-config timeout in ms (default 60000, max 120000)' })),
    }),
    replay: 'safe',
    async execute(args) {
      const input = args as { timeoutMs?: number }
      const result = await runTypecheck(repoDir, {
        ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
        ...(options.tscEntry === undefined ? {} : { tscEntry: options.tscEntry }),
        // 顺序要紧：构造参数是默认值，模型传的那个才是覆盖
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? { timeoutMs: input.timeoutMs } : {}),
      })

      if (result.reason === 'no-config') {
        return ok(
          '⏭ 这个应用没有 tsconfig.json —— 类型检查无从跑起。\n' +
            '注意：**这不等于通过**。如果改动里有 .ts/.tsx，请在风险清单里写一句"没有配置类型检查"。',
        )
      }
      if (result.reason === 'no-typescript') {
        return ok(
          '✗ 没跑成：仓库的 node_modules 里没有 typescript（依赖还没装好）。\n' +
            '**这不等于通过。** 让用户先把预览打开（会装依赖），或者用 read 人工看改动。',
        )
      }
      return ok(result.sections.join('\n'))
    },
  }

  return [gitDiff, typecheck]
}

/** 评审扩展：两个工具，不带 section（工作顺序写在角色的 instructions 里） */
export function reviewExtension(options: ReviewToolsOptions): Extension {
  return defineExtension({
    name: REVIEW_EXTENSION,
    tools: createReviewTools(options),
  })
}
