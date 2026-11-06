/**
 * 发布前的质量门禁（M4 第 7 步）。
 *
 * 一句话：**`typecheck` / `test` 不过，不许发。**
 *
 * 三个判断决定了这个文件的形状，每一个都有代价，都值得写下来：
 *
 * 1. **三态而不是布尔**（`pass` / `fail` / `skip`）。
 *    "没配测试"和"测试挂了"是两件相反的事：前者照发不误，后者必须拦。合成一个
 *    `false` 之后，要么所有没写测试的应用永远发不出去，要么测试红了也照发 —— 两种
 *    都会让这个功能在两周内被关掉。所以判据是"没有任何一项 `fail`"，`skip` 放行但要说出来。
 *
 * 2. **"没跑成"算 `fail`，不算 `skip`**。有 tsconfig 却没装 typescript、`tsc` 崩了、
 *    超时被杀 —— 这些不是"这个项目没有类型检查"，是"该检查的东西没检查成功"。
 *    把它们归到 `skip` 就等于"删掉 node_modules 就能绕过门禁"，那是自欺。
 *    （真正没有 tsconfig 的项目才是 `skip`：那是配置性选择。）
 *
 * 3. **`force` 时仍然跑检查**。用户可以坚持发布有错的版本（他可能比检查更懂，
 *    也可能只是急），但**不能不知道自己在放过什么**。所以 `force` 只影响"拦不拦"，
 *    不影响"跑不跑"；跑完的结果照样写进发布记录（`gateStatus: 'forced'`）。
 *
 * 跑 `tsc` 的部分与 Reviewer 的 `typecheck` 工具共用（`runTypecheck`），因为那里面
 * 有一个只在桌面版才炸的坑：`scrubEnv` 会把 `ELECTRON_RUN_AS_NODE` 删掉，而桌面版里
 * `process.execPath` 是 Tenon 自己 —— 不补回来就会**弹出一个窗口**，`tsc` 一行不跑。
 * 两份实现 = 两份记住这个坑的机会，早晚漏一个。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CHECK_LABELS } from '@tenon/protocol'
import type { CheckOutcome, CheckStatus, GateOutcome } from '@tenon/protocol'
import { formatTscReport, parseTscOutput, resolvePnpm, scrubEnv } from '@tenon/core'

const MAX_TSC_BYTES = 128 * 1024
const DEFAULT_TSC_TIMEOUT_MS = 60_000
const MAX_TSC_TIMEOUT_MS = 120_000

const DEFAULT_TEST_TIMEOUT_MS = 120_000
const MAX_TEST_TIMEOUT_MS = 5 * 60_000
const MAX_TEST_BYTES = 64 * 1024
/** 测试失败时真正有用的信息在尾部（堆栈、断言差异），头部全是"正在跑 xxx" */
const TEST_TAIL_LINES = 30

const DEFAULT_LINT_TIMEOUT_MS = 90_000
const MAX_LINT_TIMEOUT_MS = 5 * 60_000
const MAX_LINT_BYTES = 64 * 1024
/** lint 的有用信息在**头部**（第一个文件的第一个错误），与测试相反 */
const LINT_HEAD_LINES = 40
/**
 * 这些输出说明命令根本没装，不是"代码有问题"。
 *
 * 必须分开的原因很实际：`eslint` 没装时用户该去 `pnpm install`，
 * 查到 3 个未用变量时用户该去改代码。混成一句"lint 失败"，
 * 用户会去改一段本来就没问题的代码，然后发现怎么改都不对。
 *
 * **只匹配 shell 的"找不到命令"**，不匹配 pnpm 自己的报错：
 * `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` / `ELIFECYCLE` 在**任何**失败里都会出现，
 * 拿它当判据会把"代码有问题"全报成"没装依赖" —— 那比不报还坏。
 */
const MISSING_COMMAND =
  /: command not found|is not recognized as an internal or external command|Cannot find module '(?:eslint|typescript-eslint|@eslint)/i

/**
 * 交给子进程的环境。
 *
 * `ELECTRON_RUN_AS_NODE` 必须**显式补回来**：`scrubEnv` 会把它删掉（防止泄给生成应用），
 * 但桌面版里 `process.execPath` 是 `Tenon.app` 的可执行文件 —— 不设这个变量，
 * spawn 出来的就是一个**新窗口**，而 `tsc` / `pnpm` 一行也不会跑。
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = scrubEnv(process.env)
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

interface RunResult {
  /** undefined = 起不来（找不到可执行文件）或超时被杀 */
  code: number | undefined
  stdout: string
  stderr: string
  timedOut: boolean
  elapsedMs: number
}

function runProcess(options: {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxBytes: number
}): Promise<RunResult> {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(options.command, options.args, { cwd: options.cwd, env: childEnv() })
    } catch (err) {
      resolvePromise({
        code: undefined,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        elapsedMs: Date.now() - started,
      })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < options.maxBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < options.maxBytes) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({
        code: undefined,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        elapsedMs: Date.now() - started,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? undefined, stdout, stderr, timedOut, elapsedMs: Date.now() - started })
    })
  })
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 找 tsc 的入口：模板把 typescript 装在应用自己的 devDependencies 里 */
async function resolveTscEntry(repoDir: string): Promise<string | undefined> {
  const candidate = join(repoDir, 'node_modules', 'typescript', 'bin', 'tsc')
  return (await stat(candidate).catch(() => undefined)) === undefined ? undefined : candidate
}

/** 要跑哪几个 tsconfig：根 `tsconfig.json` 必跑，`tsconfig.server.json`（Nest 模板）也要跑 */
async function resolveConfigs(repoDir: string): Promise<string[]> {
  const names = ['tsconfig.json', 'tsconfig.server.json', 'tsconfig.app.json']
  const found: string[] = []
  for (const name of names) {
    if ((await stat(join(repoDir, name)).catch(() => undefined)) !== undefined) found.push(name)
  }
  return found
}

export interface TypecheckResult {
  status: CheckStatus
  /** 压根没跑起来的原因。调用方要靠它给不同的话（"没配置"和"没装依赖"处置方式相反） */
  reason?: 'no-config' | 'no-typescript'
  /** 每个 tsconfig 一份人读报告（`✓ 类型检查通过…` / `✗ TypeError…`），Reviewer 直接给模型看 */
  sections: string[]
  /** 一句话结论，写进发布记录与门禁清单 */
  summary: string
  elapsedMs: number
  errorCount: number
}

export interface TypecheckOptions {
  /** 测试用：跑 tsc 的 node 可执行文件（默认真实 `process.execPath`） */
  nodePath?: string
  /** 测试用：tsc 入口（默认 `<repo>/node_modules/typescript/bin/tsc`） */
  tscEntry?: string
  timeoutMs?: number
}

/**
 * 跑应用自己的类型检查。
 *
 * `Reviewer` 与发布门禁共用：一个要报告，一个要判据 —— 但"什么算通过"只能有一个答案。
 */
export async function runTypecheck(repoDir: string, options: TypecheckOptions = {}): Promise<TypecheckResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TSC_TIMEOUT_MS, MAX_TSC_TIMEOUT_MS)
  const configs = await resolveConfigs(repoDir)

  if (configs.length === 0) {
    return {
      status: 'skip',
      reason: 'no-config',
      sections: [],
      summary: '跳过：没有 tsconfig.json',
      elapsedMs: 0,
      errorCount: 0,
    }
  }

  const tscEntry = options.tscEntry ?? (await resolveTscEntry(repoDir))
  if (tscEntry === undefined) {
    return {
      status: 'fail',
      reason: 'no-typescript',
      sections: [],
      summary: '没跑成：没有装 typescript（依赖还没装好）',
      elapsedMs: 0,
      errorCount: 0,
    }
  }
  const nodePath = options.nodePath ?? process.execPath

  const started = Date.now()
  const runs = await Promise.all(
    configs.map((config) =>
      runProcess({
        command: nodePath,
        args: [tscEntry, '--noEmit', '--pretty', 'false', '-p', config],
        cwd: repoDir,
        timeoutMs,
        maxBytes: MAX_TSC_BYTES,
      }),
    ),
  )
  const elapsedMs = Date.now() - started

  const sections: string[] = []
  const failed: string[] = []
  let errorCount = 0
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index] as string
    const run = runs[index] as RunResult
    const parsed = parseTscOutput(run.stdout, run.stderr)
    // 「跑完了 + 没诊断」才算过：只看诊断会把 tsc 崩了/超时当成通过
    const okRun = !run.timedOut && run.code === 0 && parsed.diagnostics.length === 0
    const report = formatTscReport(parsed, okRun, {
      config,
      elapsedMs: run.elapsedMs,
      exitCode: run.code,
    })
    errorCount += parsed.diagnostics.length
    if (!report.ok) {
      failed.push(
        parsed.diagnostics.length > 0
          ? `${config} ${parsed.diagnostics.length} 个错误`
          : `${config} 没跑成（${run.timedOut ? '超时' : `退出码 ${run.code ?? '起不来'}`}）`,
      )
    }
    sections.push(report.text)
  }

  const where = configs.length === 1 ? (configs[0] as string) : `${configs.length} 个 tsconfig`
  if (failed.length === 0) {
    return {
      status: 'pass',
      sections,
      summary: `通过（${where}，${seconds(elapsedMs)}）`,
      elapsedMs,
      errorCount: 0,
    }
  }
  return {
    status: 'fail',
    sections,
    summary: `没过：${failed.join('、')}`,
    elapsedMs,
    errorCount,
  }
}

interface PackageJson {
  scripts?: Record<string, string>
}

async function readPackageJson(repoDir: string): Promise<PackageJson | undefined> {
  const raw = await readFile(join(repoDir, 'package.json'), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : undefined
  } catch {
    // 坏掉的 package.json 不是"没有 test 脚本"，是仓库坏了
    return undefined
  }
}

export interface TestOptions {
  timeoutMs?: number
}

export interface LintOptions {
  timeoutMs?: number
}

interface AppScriptRun {
  /** null = 起不来（找不到可执行文件） */
  code: number | null
  output: string
  timedOut: boolean
  elapsedMs: number
}

/**
 * 杀掉整棵进程树。
 *
 * **只 kill 直接子进程是不够的**：我们 spawn 的是 `pnpm`，`pnpm` 再 spawn `eslint`，
 * 而**孙进程握着 stdout** —— 父进程死了管道依然没关，`close` 事件永远不来。
 * 表现是"点发布之后一直转圈"，比报错难看得多，也更难查。
 *
 * POSIX 上把子进程放进自己的进程组（spawn 时 `detached`），超时用负 pid 一锅端。
 * Windows 没有进程组（负 pid 不支持），退回单独 kill。
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    // 已经死了、或者没有权限杀这个组：都不是错误，尽力而为
    try {
      child.kill('SIGKILL')
    } catch {
      /* 连直接子进程都没了 */
    }
  }
}

/**
 * 跑应用 `package.json` 里的一个脚本（`test` / `lint`）。
 *
 * 抽出来不是为了省代码，是为了 `ELECTRON_RUN_AS_NODE` 那个只在桌面版才炸的坑
 * （见 `childEnv`）—— 两份实现就是两份记住它的机会，早晚漏一个。
 *
 * `CI=1` 是给 `vitest` 的：它默认 watch 模式，不加这个变量会**一直挂着**直到超时，
 * 然后被报成"测试超时"。那不是测试的问题，是我们的问题。对 eslint 无副作用。
 */
async function runAppScript(
  repoDir: string,
  name: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<AppScriptRun> {
  const started = Date.now()
  const env: NodeJS.ProcessEnv = { ...childEnv(), CI: '1' }
  const pm = resolvePnpm(process.env)
  // 随包的 pnpm 是 `.cjs`：必须用 node 跑（和 `deps.ts` 装依赖时同一套判断）
  const command = pm.isScript ? process.execPath : pm.command
  const args = pm.isScript ? [pm.command, 'run', name] : ['run', name]

  const child = spawn(command, args, {
    cwd: repoDir,
    env,
    // 自己的进程组：超时才能用负 pid 把 pnpm 和它 spawn 出来的 eslint 一起杀掉
    detached: process.platform !== 'win32',
  })
  let output = ''
  let timedOut = false
  const code = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      /*
       * **不等 `close`**。孙进程可能仍然握着 stdio（见 `killTree`），那样 `close`
       * 永远不会来，而 `await` 会一直挂着 —— 用户看到的是"发布检查中…"永远不结束。
       * `resolve` 是幂等的：之后 close 再触发一次也无害。
       */
      resolvePromise(null)
    }, timeoutMs)
    const collect = (chunk: Buffer): void => {
      if (output.length < maxBytes) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      clearTimeout(timer)
      output += `\n[tenon] 起不来：${err.message}`
      resolvePromise(null)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolvePromise(exitCode)
    })
  })
  return { code, output, timedOut, elapsedMs: Date.now() - started }
}

/**
 * 跑应用自己的 `test` 脚本。
 *
 * 两个刻意的决定：
 * - **只认 `scripts.test`**：不猜 `vitest` / `jest` / `node --test`，因为猜错的表现是
 *   "跑了个不存在的命令，退出码 1" → 用户会看到一条莫名其妙的失败。没有脚本就是没有，
 *   说清楚就好。
 * - **带 `CI=1`**：`vitest` 默认是 watch 模式，不加这个变量会**一直挂着**直到超时，
 *   然后被报成"测试超时"。那不是测试的问题，是我们的问题。
 */
export async function runTestScript(repoDir: string, options: TestOptions = {}): Promise<CheckOutcome> {
  const started = Date.now()
  const pkg = await readPackageJson(repoDir)
  if (pkg === undefined) {
    return {
      id: 'test',
      status: 'skip',
      summary: '跳过：没有 package.json',
      detail: null,
      elapsedMs: 0,
    }
  }
  const script = pkg.scripts?.['test']
  if (typeof script !== 'string' || script.trim() === '') {
    return {
      id: 'test',
      status: 'skip',
      summary: '跳过：package.json 里没有 scripts.test',
      detail: null,
      elapsedMs: 0,
    }
  }

  // 脚本在、依赖不在：跑起来只会是 "command not found"，那不是"测试失败"而是"还没准备好"
  if (!existsSync(join(repoDir, 'node_modules'))) {
    return {
      id: 'test',
      status: 'fail',
      summary: '没跑成：依赖还没装（没有 node_modules）',
      detail: '让用户先把预览打开一次（会装依赖），然后再发布。',
      elapsedMs: Date.now() - started,
    }
  }

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, MAX_TEST_TIMEOUT_MS)
  const { code, output, timedOut, elapsedMs } = await runAppScript(repoDir, 'test', timeoutMs, MAX_TEST_BYTES)

  const tail = output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-TEST_TAIL_LINES)
    .join('\n')

  if (timedOut) {
    return {
      id: 'test',
      status: 'fail',
      summary: `超时（超过 ${Math.round(timeoutMs / 1000)}s，已终止）`,
      detail: tail === '' ? null : tail,
      elapsedMs,
    }
  }
  if (code === null) {
    return {
      id: 'test',
      status: 'fail',
      summary: '没跑成：test 脚本起不来',
      detail: tail === '' ? null : tail,
      elapsedMs,
    }
  }
  if (code !== 0) {
    return {
      id: 'test',
      status: 'fail',
      summary: `失败（pnpm run test 退出码 ${code}）`,
      detail: tail === '' ? null : tail,
      elapsedMs,
    }
  }
  return {
    id: 'test',
    status: 'pass',
    summary: `通过（pnpm run test，${seconds(elapsedMs)}）`,
    detail: null,
    elapsedMs,
  }
}

/**
 * lint 输出的截断。
 *
 * 与测试**相反**：测试失败的有用信息在尾部（堆栈、断言差异），lint 的在头部
 * （第一个文件的第一个错误）。所以砍尾不砍头。
 *
 * 但如果直接砍尾会丢掉最后那行 `✖ 12 problems (10 errors, 2 warnings)` ——
 * 那是"到底有多少个"的唯一来源，单独补回来。
 */
function lintExcerpt(output: string): string | null {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return null
  if (lines.length <= LINT_HEAD_LINES + 3) return lines.join('\n')
  const head = lines.slice(0, LINT_HEAD_LINES)
  const summary = lines.slice(-2)
  return [...head, `…（省略 ${lines.length - LINT_HEAD_LINES - 2} 行）`, ...summary].join('\n')
}

/**
 * 跑应用自己的 `lint` 脚本（v1.2.20，发布门禁的第三项）。
 *
 * 与 `runTestScript` 同一条思路：**只认 `scripts.lint`**，不猜 `eslint` / `biome` / `oxlint`。
 * 猜错的表现是"跑了个不存在的命令，退出码 1"→ 用户看到一条莫名其妙的失败。
 *
 * 两处刻意不同的处理：
 *
 * 1. **"命令没装"和"代码有问题"分开说**（`MISSING_COMMAND`）。前者让用户去装依赖，
 *    后者让用户去改代码 —— 混成一句话，用户会去改一段没问题的代码。
 * 2. **截断取头部**（`lintExcerpt`），因为错误按文件排在前面，汇总在最后。
 *
 * 还有一条**不做**的事：不把 warning 当失败。`eslint` 只有 warning 时退出码是 0，
 * 所以这条规则是白送的；但如果用户自己写了 `--max-warnings=0`，那是他的选择，
 * 我们照他的退出码判 —— 门禁不替用户改自己的脚本。
 */
export async function runLintScript(repoDir: string, options: LintOptions = {}): Promise<CheckOutcome> {
  const started = Date.now()
  const pkg = await readPackageJson(repoDir)
  if (pkg === undefined) {
    return { id: 'lint', status: 'skip', summary: '跳过：没有 package.json', detail: null, elapsedMs: 0 }
  }
  const script = pkg.scripts?.['lint']
  if (typeof script !== 'string' || script.trim() === '') {
    return {
      id: 'lint',
      status: 'skip',
      summary: '跳过：package.json 里没有 scripts.lint',
      detail: null,
      elapsedMs: 0,
    }
  }

  // 脚本在、依赖不在：跑起来只会是 "command not found"，那不是"代码有问题"而是"还没准备好"
  if (!existsSync(join(repoDir, 'node_modules'))) {
    return {
      id: 'lint',
      status: 'fail',
      summary: '没跑成：依赖还没装（没有 node_modules）',
      detail: '让用户先把预览打开一次（会装依赖），然后再发布。',
      elapsedMs: Date.now() - started,
    }
  }

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_LINT_TIMEOUT_MS, MAX_LINT_TIMEOUT_MS)
  const { code, output, timedOut, elapsedMs } = await runAppScript(repoDir, 'lint', timeoutMs, MAX_LINT_BYTES)
  const excerpt = lintExcerpt(output)

  if (timedOut) {
    return {
      id: 'lint',
      status: 'fail',
      summary: `超时（超过 ${Math.round(timeoutMs / 1000)}s，已终止）`,
      detail: excerpt,
      elapsedMs,
    }
  }
  if (code === null) {
    return { id: 'lint', status: 'fail', summary: '没跑成：lint 脚本起不来', detail: excerpt, elapsedMs }
  }
  if (code !== 0 && (code === 127 || MISSING_COMMAND.test(output))) {
    return {
      id: 'lint',
      status: 'fail',
      summary: '没跑成：lint 脚本里的命令没装（依赖不完整）',
      detail: excerpt,
      elapsedMs,
    }
  }
  if (code !== 0) {
    return {
      id: 'lint',
      status: 'fail',
      summary: `没过（pnpm run lint 退出码 ${code}）`,
      detail: excerpt,
      elapsedMs,
    }
  }
  return {
    id: 'lint',
    status: 'pass',
    summary: `通过（pnpm run lint，${seconds(elapsedMs)}）`,
    detail: null,
    elapsedMs,
  }
}

export interface GateOptions extends TypecheckOptions, TestOptions, LintOptions {}

/**
 * 跑整套门禁。
 *
 * 三项**并行**：它们互不依赖，串行只是把等待时间翻三倍。代价是机器负载高时都慢一点，
 * 但发布是低频动作，而且用户看得见"正在检查"。顺带说明：`test` 脚本自己如果也跑 tsc，
 * 那就是应用自己的选择，我们不去猜、也不去合并。
 */
export async function runQualityGate(repoDir: string, options: GateOptions = {}): Promise<GateOutcome> {
  const [typecheck, test, lint] = await Promise.all([
    runTypecheck(repoDir, options),
    runTestScript(repoDir, options),
    runLintScript(repoDir, options),
  ])
  const checks: CheckOutcome[] = [
    {
      id: 'typecheck',
      status: typecheck.status,
      summary: typecheck.summary,
      // 失败时给用户第一条诊断就够定位了；完整报告在 Reviewer 那边
      detail: typecheck.status === 'fail' ? (typecheck.sections.find((s) => s.startsWith('✗')) ?? null) : null,
      elapsedMs: typecheck.elapsedMs,
    },
    test,
    lint,
  ]
  return { ok: checks.every((check) => check.status !== 'fail'), checks }
}

const GLYPH: Record<CheckStatus, string> = { pass: '✓', fail: '✗', skip: '⏭' }
/* 与界面共用一份（`protocol` 的 `CHECK_LABELS`）：否则发布记录里是中文、界面上是 `lint` */
const LABEL: Record<string, string> = { ...CHECK_LABELS }

/**
 * 检查的名字。
 *
 * `summary` 里**故意不带**名字（"通过（tsconfig.json，4.1s）"）。界面上一行是
 * "类型检查 | 通过（…）"，名字是独立一列；错误消息里没有列，所以由拼消息的那一侧补上。
 * 两边各写一遍就会变成"类型检查类型检查失败"。
 */
export function checkLabel(id: string): string {
  return LABEL[id] ?? id
}

/** 一行摘要，写进发布记录（`releases.gate_summary`）与界面上那一小行 */
export function formatGateSummary(gate: GateOutcome): string {
  return gate.checks.map((check) => `${LABEL[check.id] ?? check.id} ${GLYPH[check.status]}`).join(' · ')
}
