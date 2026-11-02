/**
 * 角色表（DESIGN §5.1）：1 个主角色 + 5 个子角色。
 *
 * 这里是**唯一事实来源** —— 工具集、档位、提示词、能不能派活都只写一遍。
 * 以前这些东西散在 prompt 字符串和注册代码里，加一个角色要改三处、还容易漏掉"子 Agent 不该有的工具"。
 *
 * 两条纪律：
 * 1. **子角色的工具集是白名单，不是黑名单**。`explore` 只读是因为它的名字里没有 `write`，
 *    而不是因为我们在别处记得把它删掉。要写文件的角色必须自己列出来。
 * 2. **`builder` 不可被派活**。`subagent` 的参数里根本不出现它 —— 递归派活是失控的第一入口
 *    （子会话里也不会有 `subagent` 工具，见 `toolsForRole`）。
 *
 * 档位（`tier`）现在是**声明**而不是路由：设置里只能配一个 provider，所以所有档位落到同一个模型。
 * 真正按档位换模型要等设置能存多个 profile（M4 后续步骤），现在写死会假装有这个能力。
 */
import type { ToolRegistration } from '@earendil-works/pi-durable'

export type RoleId = 'builder' | 'explore' | 'codeact' | 'librarian' | 'e2e' | 'reviewer'

/** 档位：简单任务用 fast、写代码用 comprehensive、审查用 thinking（DESIGN §5.1） */
export type ModelTier = 'fast' | 'comprehensive' | 'thinking'

export interface RoleSpec {
  readonly id: RoleId
  readonly label: string
  readonly tier: ModelTier
  /** 一句话职责，工具描述与界面都用它 */
  readonly purpose: string
  /** 白名单：这个角色能用哪些工具（按名字选） */
  readonly tools: readonly string[]
  readonly instructions: string
  /** 能不能再派活给别的角色 */
  readonly canDelegate: boolean
  /**
   * `ready`：工具齐了，现在就能用。
   * `planned`：角色已定义，缺的工具在 M4 后面的步骤里接 —— 派活会明确报"还没接"，
   * 而不是让模型自己去发现工具不存在（那样它会开始瞎猜文件内容）。
   */
  readonly readiness: 'ready' | 'planned'
  /** planned 时缺什么，直接回给模型看 */
  readonly pending?: string
}

const ROLE_COMMON = `You are a sub agent of Tenon, a tool that builds one web application inside a git repository.
You do not talk to the user directly: your final answer goes back to the main agent (Builder), which decides what to do with it.
Be brief and concrete. Quote paths as repo-relative paths with line numbers when you can.
You cannot change the app: your tool set is read-only unless stated otherwise. Never claim you changed something you could not.`

export const ROLES: Record<RoleId, RoleSpec> = {
  builder: {
    id: 'builder',
    label: 'Builder',
    tier: 'comprehensive',
    purpose: '主角色：跟用户对话，决定改什么代码',
    tools: [
      'read',
      'write',
      'edit',
      'bash',
      'ls',
      'glob',
      'grep',
      'subagent',
    ],
    instructions: '',
    canDelegate: true,
    readiness: 'ready',
  },
  explore: {
    id: 'explore',
    label: 'Explore',
    tier: 'fast',
    purpose: '定位代码：这个功能在哪、这行从哪来的',
    tools: ['read', 'ls', 'glob', 'grep'],
    instructions: `${ROLE_COMMON}

Your job: locate code. Answer "where is X", "which files touch Y", "what does this page render".
Work by narrowing: ls → glob to find candidates → grep for the symbol → read only the files that matter.
Report: the shortest list of repo-relative paths with line numbers and one sentence per file on why it matters.
Do not paste whole files back. If you cannot find it after a handful of searches, say so and list what you tried.`,
    canDelegate: false,
    readiness: 'ready',
  },
  librarian: {
    id: 'librarian',
    label: 'Librarian',
    tier: 'fast',
    purpose: '查文档与约定：这个库怎么用、这个项目有什么规矩',
    tools: ['read', 'ls', 'glob', 'grep'],
    instructions: `${ROLE_COMMON}

Your job: answer framework and project-convention questions from what is actually on disk —
AGENTS.md, README, docs/, and the type definitions inside node_modules (grep them, do not guess the API).
Quote the file and line you took the answer from. If the repo does not answer it, say "仓库里没有依据" instead of
recalling the library from memory: a wrong API costs more than an honest gap.
Note: external documentation search is not wired up yet, so only on-disk material counts.`,
    canDelegate: false,
    readiness: 'ready',
  },
  codeact: {
    id: 'codeact',
    label: 'CodeAct',
    tier: 'comprehensive',
    purpose: '写一次性脚本：批量改、导数据、跑探查',
    tools: [],
    instructions: `${ROLE_COMMON}

Your job: do what a script does better than a dozen tool calls — batch rewrites, data imports, one-off inspection.`,
    canDelegate: false,
    readiness: 'planned',
    pending: '缺 `codemode` 沙箱（pi-codemode 未接入；M4 后续步骤）',
  },
  e2e: {
    id: 'e2e',
    label: 'E2E',
    tier: 'comprehensive',
    purpose: '自验收：打开预览、点一遍、看断言过不过',
    /*
     * 只有预览工具，一个文件工具都没有 —— 这是刻意的：验收的人不该顺手改代码。
     * 发现了什么就报回去，改由主角色改（改完再让它验一遍，形成"改 → 验"的闭环）。
     */
    tools: ['preview_read', 'preview_assert', 'preview_click', 'preview_type', 'preview_open'],
    instructions: `${ROLE_COMMON}

Your job: verify the running application, not its source code.

Order of work:
1. preview_read — see what the page actually shows. Never assert a string you have not seen
   (from source or from an earlier read): a passing assertion on a guessed string proves nothing.
2. preview_click / preview_type — exercise the flow the way a user would.
3. preview_assert — check the result. It retries until its timeout, so a re-render will not flake it.
4. preview_open — reach another route, then start again at step 1.

A failed assertion is information, not an error: report expected vs observed verbatim.
Every result carries the page's own errors when there are any — quote them, that is usually the real bug.
Report one line per step: what you did, what you saw, pass or fail.
You cannot write files: report the defect, do not try to fix it.`,
    canDelegate: false,
    readiness: 'ready',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    tier: 'thinking',
    purpose: '提交前审查：风险清单，不改代码',
    tools: ['read', 'ls', 'glob', 'grep'],
    instructions: `${ROLE_COMMON}

Your job: review a change before it is committed and produce a risk list, not a rewrite.
Look for: contract drift between front and back end, missing error handling on a new path,
migration that will not run twice, secrets in code, and files that should not be committed.
Output at most five items, most severe first, each with file:line and a one-line fix. Say "没有发现问题" when there is none.`,
    canDelegate: false,
    readiness: 'planned',
    pending: '缺 `git_diff` 与 `typecheck` 工具（M4 后续步骤）；只读检索已可用',
  },
}

/** 可被派活的角色（顺序即工具描述里的顺序） */
export const DELEGABLE_ROLES: readonly RoleId[] = ['explore', 'librarian', 'codeact', 'e2e', 'reviewer']

export function roleOf(id: string): RoleSpec | undefined {
  return (ROLES as Record<string, RoleSpec | undefined>)[id]
}

/**
 * 按白名单挑出工具。**不在白名单里的一律不给** —— 包括 `subagent` 自己：
 * 子会话拿不到它，就不会出现"子 Agent 又派活给子 Agent"的链。
 */
export function toolsForRole(spec: RoleSpec, available: readonly ToolRegistration[]): ToolRegistration[] {
  const allowed = new Set(spec.tools)
  return available.filter((tool) => allowed.has(tool.name) && tool.name !== 'subagent')
}

/** 子会话首行标记：faux 靠它分道，日志里也能一眼看出这句是谁说的 */
export const SUBAGENT_MARKER_PREFIX = '[TENON-SUBAGENT'

export function subagentPrompt(role: RoleId, task: string): string {
  return `${SUBAGENT_MARKER_PREFIX} role=${role}]\n${task}`
}

/** 从一段文本里认出子 Agent 的角色（faux 分道 + 历史展示用） */
export function roleOfPrompt(text: string): RoleId | undefined {
  // 前缀里有 `[`，不能直接拼进 `new RegExp` —— 写成字面量正则，别在这里玩转义。
  // `[a-z0-9]+` 而不是 `[a-z]+`：`e2e` 这个角色名里有数字，只写 a-z 会让它永远认不出来
  const match = /\[TENON-SUBAGENT role=([a-z0-9]+)\]/.exec(text)
  const id = match?.[1]
  return id === undefined ? undefined : roleOf(id)?.id
}
