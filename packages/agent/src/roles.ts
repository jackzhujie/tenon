/**
 * 角色表（DESIGN §5.1）：1 个主角色 + 5 个子角色。
 *
 * 这里是**唯一事实来源** —— 工具集、档位、提示词、能不能派活都只写一遍。
 * 以前这些东西散在 prompt 字符串和注册代码里，加一个角色要改三处、还容易漏掉"子 Agent 不该有的工具"。
 *
 * **提示词一律英文**，跟着界面语言翻是错的：它唯一的读者是模型，而英文指令在
 * 各家模型上最稳（中文指令会让一部分模型开始用中文思考、把工具名也写成中文）。
 * 界面上的双语只覆盖"给用户看的字"，不覆盖"给模型看的字"（见 STATUS §2）。
 * 唯一的例外是**引用工具输出的原文**时要点名中英两种写法 —— `checks` 的摘要按界面
 * 语言输出，模型必须两版都认得，否则中文界面上它会以为检查"没跑"其实是"通过了"。
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
  /** 白名单：这个角色能用哪些工具（按名字选） */
  readonly tools: readonly string[]
  /**
   * 白名单的一个**子集**：这些工具真的递给模型。
   *
   * 不给（`undefined`）时 `tools` 全部递给模型，这是绝大多数角色的情况。
   * 给了的只有 CodeAct：它的 `read/ls/glob/grep` 是给**脚本**调的，模型手里只该有 `codemode` ——
   * 否则它会绕过脚本一次次直接读文件，"四十次 read 只回一行结论"这件事就没了。
   */
  readonly modelTools?: readonly string[]
  readonly instructions: string
  /** 能不能再派活给别的角色 */
  readonly canDelegate: boolean
  /**
   * 除父会话已有的扩展之外，这个角色还要哪些（按扩展名）。
   *
   * 只有 CodeAct 用得上：`codemode` 那个工具与它的 section 都在 `tenon.codeact` 扩展里，
   * 而**扩展不在会话的 `extensions` 里，工具就解析不到**（M4 第 4 步踩过：表现是
   * "工具不存在"，模型若无其事继续讲）。父会话特意不装它 —— 主角色不该看见 codemode。
   */
  readonly extensions?: readonly string[]
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
    tools: ['read', 'ls', 'glob', 'grep'],
    instructions: `${ROLE_COMMON}

Your job: answer framework and project-convention questions from what is actually on disk —
AGENTS.md, README, docs/, and the type definitions inside node_modules (grep them, do not guess the API).
Quote the file and line you took the answer from. If the repo does not answer it, say "not in this repo" instead of
recalling the library from memory: a wrong API costs more than an honest gap.
Note: external documentation search is not wired up yet, so only on-disk material counts.`,
    canDelegate: false,
    readiness: 'ready',
  },
  codeact: {
    id: 'codeact',
    label: 'CodeAct',
    tier: 'comprehensive',
    /*
     * 五个工具进会话，只有 `codemode` 递给模型 —— 另外四个是**给脚本调的**（`modelTools`）。
     * 没有 `bash`、没有 `write`/`edit`：脚本沙箱的意义是"算"，不是"绕过一步一条命令的审阅"。
     * 主角色跑命令时每条都在转录里、随时能被打断；脚本里四十条命令的输出只有脚本自己看得到。
     * 要写文件就回主角色改，这条不变式让"子 Agent 只读"对五个角色都成立。
     */
    tools: ['codemode', 'read', 'ls', 'glob', 'grep'],
    modelTools: ['codemode'],
    extensions: ['tenon.codeact'],
    instructions: `${ROLE_COMMON}

Your job: write one short script instead of a dozen tool calls — filter a huge grep result, read twenty
files and summarise them, reshape JSON, check one pattern across the whole repo.

How the script sees the world (it is a sandbox: no fetch, no timers, no filesystem, no npm —
only the tools below):
- \`await tools.read({ path })\`, \`tools.ls\`, \`tools.glob\`, \`tools.grep\` — the read-only tools, one promise each.
  Fan out with \`Promise.all\` when the calls do not depend on each other; that is the whole point of being here.
- \`text(value)\` appends a line to what I see. \`return value\` comes back too. Everything else you compute is invisible.
- Nothing else exists. Do not import, do not try \`require\`, do not write files.

Rules:
1. Print the conclusion, not the data. The first two hundred lines of a search result are worth nothing to me;
   "12 files mention submitOrder, 3 of them also call commit" is worth a lot.
2. Keep the script under ~30 lines and the output to a screen. A long script means you are doing the main
   agent's job with worse tools.
3. A failing nested call rejects — wrap the ones that may miss (a missing file, a no-match grep) in try/catch
   and print what you caught.
4. You cannot change the app. Report the values and the paths; the main agent edits.`,
    canDelegate: false,
    readiness: 'ready',
  },
  e2e: {
    id: 'e2e',
    label: 'E2E',
    tier: 'comprehensive',
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
    /*
     * 只读 + 三个判据工具。顺序在提示词里写死：`git_diff` → `typecheck` → `lint`。
     * 只看 diff 会变成猜（"这里是不是少了 try/catch"）；只看 typecheck 会漏掉契约漂移
     * （类型全绿但前端还在读已经不存在的字段）；`lint` 补的是第三种漏 ——
     * "旧的实现没删干净"（未用变量，常是改到一半的证据）和"hook 用法错"（运行时才炸）。
     */
    tools: ['read', 'ls', 'glob', 'grep', 'git_diff', 'typecheck', 'lint'],
    instructions: `${ROLE_COMMON}

Your job: review a change before it is committed and produce a risk list, not a rewrite.

Order of work (do not skip 1-3, and do not reorder them):
1. git_diff — see the actual changed lines. Review **what changed**, not the whole repository.
   If it says the working tree is clean, pass commit:"HEAD" to review the last commit instead.
2. typecheck — run the app's own tsc. A type error is a finding, not a tool failure.
   A check that could not run (deps missing, no tsconfig) says so in its first line —
   "Did not run" / "没跑成". If you see that, the check did NOT happen: say so in the report.
3. lint — run the app's own lint. An unused variable usually means a half-finished edit
   (the old implementation is still there); a hook called conditionally is a crash waiting.
   Warnings are not findings. A check that could not run did NOT happen: say so.
4. read / grep only where the diff points — a changed signature, a new endpoint, a migration.

Look for: contract drift between front and back end, missing error handling on a new path,
a migration that will not run twice, secrets or absolute machine paths in code,
files that should not be committed (build output, .env, dumps), and dead code left behind
after a rewrite (that is what lint's unused-variable rule is pointing at).

Output at most five items, most severe first, exactly one line each:
  [blocker|risk|nit] path:line — what is wrong — one-line fix
Then one closing line: what you checked and what you could not check.
Report "no problems found" only after all three checks actually ran. Never imply a check passed when it did not run.
You cannot write files and you cannot commit: report, do not fix.`,
    canDelegate: false,
    readiness: 'ready',
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

/**
 * 递给**模型**的那一份：`modelTools` 是 `tools` 的子集，只做筛选、不重排。
 * 没有 `modelTools` 的角色原样返回（绝大多数）。
 */
export function modelToolsFor(
  spec: RoleSpec,
  tools: readonly ToolRegistration[],
): readonly ToolRegistration[] {
  if (spec.modelTools === undefined) return tools
  const allowed = new Set(spec.modelTools)
  return tools.filter((tool) => allowed.has(tool.name))
}

/**
 * 角色还没接好时回给模型的那句话；`undefined` = 接好了。
 *
 * 单独抽成纯函数，是因为角色表里现在**一个 `planned` 都没有**了 —— 集成测试不再有入口去走
 * 这条分支。而这句话是模型"下一步该怎么办"的唯一线索（说清缺什么，它才会换角色或自己做），
 * 值得用单测钉住，而不是等下一个角色接一半时才发现文案坏了。
 */
export function plannedRejection(spec: RoleSpec): string | undefined {
  if (spec.readiness !== 'planned') return undefined
  return `${spec.label} is not wired up yet (${spec.pending ?? 'missing tools'}). Use another role or do it yourself.`
}

/** 这个角色要用到哪些扩展（按名字）：多数角色继承父会话的，CodeAct 要额外要一个沙箱 */
export function extensionNamesFor(spec: RoleSpec): readonly string[] {
  return spec.extensions ?? []
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
