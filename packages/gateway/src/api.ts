/**
 * 拉起生成应用的后端（NestJS）。
 *
 * ## 为什么是「tsc 编译 + node 跑产物」而不是 ts-node / tsx
 *
 * 这是 M2 花时间最多的一处，值得写清楚，否则下一个人一定会"优化"回去：
 *
 * - **tsx / esbuild 不产 `emitDecoratorMetadata`** → Nest 的构造函数注入读不到类型，
 *   启动时报 `Cannot resolve dependency at index [0]`。看起来像"依赖没装好"，其实是转译器选错。
 * - **`ts-node/register` 在 Node ≥ 22.18 已经失效**：那个版本起 Node 自带 TypeScript
 *   类型擦除，`.ts` 入口会走 **ESM 加载器**，`require.extensions['.ts']` 的钩子压根不参与。
 *   症状是 `ERR_MODULE_NOT_FOUND: .../api/app.module`（因为 ESM 要求写扩展名），
 *   而包里明明有那个文件。
 * - `@nestjs/cli` 的 `nest start --watch` 内部做的正是同一件事（tsc watch + 重启），
 *   但为了这个功能拖进整个 CLI（几十 MB）不值得。
 *
 * 所以：`tsc -w` 负责编译到 `dist-server/`，`node --watch dist-server/.../main.js`
 * 负责跑和重启。两个子进程合成一个「逻辑进程」（`groupLaunched`），上层只看到"起没起来"。
 *
 * ## 入口从哪来
 *
 * `package.json` 的 `tenon` 字段，不是写死的路径：
 * - `tenon.api` 源码入口（`api/main.ts`）
 * - `tenon.apiOut` 编译产物（`dist-server/api/main.js`）—— 没有就说明后端是纯 JS，直接跑源码
 * - `tenon.apiTsconfig` 可选，默认 `tsconfig.server.json`
 *
 * 猜错的表现是「预览就绪、页面能开、所有 /api 请求 502」，比直接失败难查十倍，
 * 所以这里声明优先、目录约定兜底、两者都没有就当纯前端应用。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scrubEnv } from '@tenon/core'
import { TenonError } from '@tenon/protocol'
import { groupLaunched, nodeRunEnv, spawnLogged, type Launched } from './child.js'

export interface ApiEntry {
  /** 源码入口（相对 repoDir） */
  source: string
  /** 编译产物入口（相对 repoDir）；null = 纯 JS 后端，直接跑源码 */
  output: string | null
}

export interface ApiLaunchSpec {
  repoDir: string
  apiPort: number
  gatewayPort: number
  entry: ApiEntry
  /** 平台注入的连接串（pglite 档指向本地 WASM PG） */
  databaseUrl: string
  /** 连接池上限：pglite 档恒为 1 */
  poolMax: number
  env?: NodeJS.ProcessEnv
}

export type ApiLauncher = (spec: ApiLaunchSpec) => Promise<Launched>

/** 首次编译要给足时间：冷启动 + 首次类型检查，慢机器上十几秒都正常 */
const FIRST_BUILD_TIMEOUT_MS = 90_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lastLines(launched: Launched, count = 6): string {
  const rows = launched
    .output()
    .split('\n')
    .filter((line) => line.trim() !== '')
  return rows.slice(-count).join(' / ') || '（没有输出）'
}

/** 轮询到文件出现为止；编译器自己先退出就当失败（配置错 / 找不到 tsconfig） */
async function waitForFile(path: string, compiler: Launched, timeoutMs: number): Promise<boolean> {
  let exited = false
  compiler.onExit(() => {
    exited = true
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    if (exited) return false
    await sleep(120)
  }
  return existsSync(path)
}

interface TenonFields {
  api?: unknown
  apiOut?: unknown
  apiTsconfig?: unknown
}

function readTenonField(repoDir: string): TenonFields {
  const packageJson = join(repoDir, 'package.json')
  if (!existsSync(packageJson)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJson, 'utf8'))
    return (parsed as { tenon?: TenonFields }).tenon ?? {}
  } catch {
    // package.json 坏了不该让预览整个失败：继续走目录约定
    return {}
  }
}

/**
 * 这个应用要不要起后端？返回入口或 null。
 *
 * 目录约定（`api/main.ts`）作兜底：生成的应用可能被 Agent 重写了 package.json 而漏掉声明，
 * 这时起后端比"静默当纯前端"更接近用户预期。
 */
export function resolveApiEntry(repoDir: string): ApiEntry | null {
  const tenon = readTenonField(repoDir)
  const declared = typeof tenon.api === 'string' && tenon.api !== '' ? tenon.api : null
  const source =
    declared !== null && existsSync(join(repoDir, declared))
      ? declared
      : existsSync(join(repoDir, 'api', 'main.ts'))
        ? join('api', 'main.ts')
        : null
  if (source === null) return null
  return {
    source,
    // ★ 不检查产物是否存在：首次启动时 dist-server 必然还没编译出来。
    //   声明过就按"先编译再跑"走，把"文件不在"当成"还没编译"。
    output: typeof tenon.apiOut === 'string' && tenon.apiOut !== '' ? tenon.apiOut : null,
  }
}

function tsconfigOf(repoDir: string, declared: unknown): string | null {
  if (typeof declared === 'string' && declared !== '' && existsSync(join(repoDir, declared))) {
    return declared
  }
  return existsSync(join(repoDir, 'tsconfig.server.json')) ? 'tsconfig.server.json' : null
}

export const launchApi: ApiLauncher = async (spec) => {
  const env: NodeJS.ProcessEnv = nodeRunEnv({
    ...scrubEnv(spec.env ?? process.env),
    // ★ 生成应用唯一认的连接信息（铁律 2）
    DATABASE_URL: spec.databaseUrl,
    // 容量参数，不是环境标记：pglite 档恒为 1（DESIGN §6.4）
    DATABASE_POOL_MAX: String(spec.poolMax),
    PORT: String(spec.apiPort),
    TENON_GATEWAY_PORT: String(spec.gatewayPort),
    NODE_ENV: 'development',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  })

  if (spec.entry.output === null) {
    return spawnLogged({
      command: process.execPath,
      args: ['--watch', spec.entry.source],
      cwd: spec.repoDir,
      env,
      label: 'api',
    })
  }

  const tenon = readTenonField(spec.repoDir)
  const tsconfig = tsconfigOf(spec.repoDir, tenon.apiTsconfig)
  const tsc = join(spec.repoDir, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    throw new TenonError('PREVIEW_DEPS_FAILED', '找不到 typescript：依赖没装完或装失败了', { tsc })
  }
  if (tsconfig === null) {
    throw new TenonError('PREVIEW_DEPS_FAILED', '后端要编译，但找不到 tsconfig.server.json', {
      repoDir: spec.repoDir,
    })
  }

  // 1) 编译器：--watch 常驻，--preserveWatchOutput 让增量输出不被清屏
  const compiler = spawnLogged({
    command: process.execPath,
    args: [tsc, '-p', tsconfig, '--watch', '--preserveWatchOutput'],
    cwd: spec.repoDir,
    env,
    label: 'tsc',
  })

  // ★ 必须**等第一次编译产出**再起运行器。
  //
  // `node --watch` 只监听"它加载过的文件"；入口文件还不存在时它打印
  // "Failed running ... Waiting for file changes" 然后**什么都不监听** ——
  // 于是 tsc 编译完了也不会重启，我们白等到健康检查超时，错误信息里还只有
  // 那一行 "Failed running"，完全看不出是时序问题（这次就踩了）。
  const outputPath = join(spec.repoDir, spec.entry.output)
  const compiled = await waitForFile(outputPath, compiler, FIRST_BUILD_TIMEOUT_MS)
  if (!compiled) {
    await compiler.stop()
    throw new TenonError(
      'PREVIEW_START_FAILED',
      `后端在 ${FIRST_BUILD_TIMEOUT_MS / 1000} 秒内没有编译出 ${spec.entry.output}（tsc 最后输出：${lastLines(compiler)}）`,
      { stage: 'server', output: compiler.output() },
    )
  }

  // 2) 运行器：node 自己的 watcher 盯的是**已加载的编译产物**，
  //    所以 tsc 一改写文件它就重启 —— 不需要我们自己写文件监听
  const runner = spawnLogged({
    command: process.execPath,
    args: ['--watch', spec.entry.output],
    cwd: spec.repoDir,
    env,
    label: 'api',
  })
  return groupLaunched([compiler, runner])
}
