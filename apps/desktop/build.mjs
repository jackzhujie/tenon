/**
 * 桌面版构建：把"三个能独立跑的东西"铺成一份同构的 `dist/`。
 *
 * ```
 * apps/desktop/dist/
 *   main.mjs              ← Electron 主进程（只有 electron 是外部依赖）
 *   server/server.mjs     ← 整个 server 打成一个文件（12MB，含 fastify/pi/isomorphic-git）
 *   templates/            ← 建应用用的模板（真实文件，必须随包走）
 *   plugins/              ← 官方组件（真实文件，加载器按目录扫描 manifest.json）
 *   web/                  ← 渲染器产物（`pnpm build:web` 的 dist）
 * ```
 *
 * 为什么 server 能打成一个文件：M1 的服务端依赖恰好全是纯 JS（产品库是 `node:sqlite`，
 * 生成应用才可能碰 PGlite），所以 esbuild 能把它们全塞进一个 12MB 的文件。
 *
 * **这不等于"安装包里不许有原生模块"。** v1.2.13 起这条从铁律降为偏好：
 * 安装包是**预编译分发**的产物，原生模块在打包机上就编译好了，用户机器上不需要
 * node-gyp / 编译工具链 —— 原先那条限制要解决的正是这个，而它在分发模型下已经不存在。
 * 所以现在扫到 `.node` 不失败，而是**列清单 + 体积 + 平台标签**：
 * 放宽限制不该同时放弃"知道包里装了什么"。要卡住就设 `TENON_STRICT_NATIVE=1`。
 *
 * 仍然守住的边界是**生成应用**那边的依赖（模板 `package.json`）：那是用户在自己机器上
 * `pnpm install`，我们没有替他预编译，所以那里仍然不引入需要按平台编译的包。
 *
 * 两个必须写进配置的细节：
 * 1. `banner` 注入 `createRequire`：isomorphic-git 里有 CJS 依赖，ESM 产物里没有 `require`
 * 2. `templates` 必须落在 `dist/templates`：`registry.ts` 按 `import.meta.url` 找 `../templates`
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm, stat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const dist = join(here, 'dist')

/** 12MB 的单文件不该被压缩成 1 行：出问题时用户发来的堆栈要能对上源码 */
const BANNER = `import { createRequire as __tenonCreateRequire } from 'node:module'
const require = __tenonCreateRequire(import.meta.url)`

const kib = (bytes) => `${(bytes / 1024).toFixed(0)}KB`

async function sizeOf(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await sizeOf(child)
    else total += (await stat(child)).size
  }
  return total
}

/**
 * PGlite 必须**外部化**，不能打进单文件。
 *
 * 它不是纯 JS 包：`dist/` 里有 `pglite.wasm`（8.7MB）、`pglite.data`（6MB）和几十个
 * 扩展的 `.tar.gz`，运行时按 `import.meta.url` 的相对位置去读。esbuild 把 JS 打进
 * `server.mjs` 之后这些路径全部失效 —— 症状是「应用起得来、对话正常，一建全栈应用就
 * 报 ENOENT pglite.wasm」，而构建本身一声不响地成功。
 *
 * 做法：external + 把整个包原样拷到 `dist/server/node_modules/`，
 * 让 Node 按正常的模块解析规则从 `server.mjs` 往上层找。
 */
const PGLITE_EXTERNAL = ['@electric-sql/pglite', '@electric-sql/pglite/*']

/**
 * CodeAct 的脚本沙箱（M4 第 6 步）同理，而且**两处**都靠 `import.meta.url`：
 * - `quickjs-wasi/quickjs.wasm` 用 `createRequire(import.meta.url).resolve()` 找；
 * - worker 线程用 `new URL('./worker.js', import.meta.url)` 起。
 *
 * 打进单文件之后这两个路径都指向 `server.mjs` 旁边，worker 起不来、wasm 读不到。
 * 症状比 PGlite 更隐蔽：构建成功、其它功能全好，只有"派活给 codeact"会报 sandbox 错误。
 *
 * 做法同上：external + 整包拷进 `dist/server/node_modules/`。`quickjs-wasi` 只拷
 * `package.json` 与 `quickjs.wasm` —— 那几个 `extensions/*.so` 是别用不上的 WASI 扩展。
 */
const CODEMODE_EXTERNAL = [
  '@earendil-works/pi-codemode',
  '@earendil-works/pi-codemode/*',
  'quickjs-wasi',
  'quickjs-wasi/*',
]

function resolvePgliteDir() {
  const req = createRequire(join(root, 'packages', 'db-provisioner', 'package.json'))
  // 包没有导出 `./package.json`，所以从主入口往上退两级
  return dirname(dirname(req.resolve('@electric-sql/pglite')))
}

/**
 * pi-codemode 的包根。
 *
 * 不能用 `require.resolve('@earendil-works/pi-codemode')`：它的 `exports` 只有
 * `types` / `source` / `import` 三个条件，**没有 `require` / `default`** —— CJS 解析直接报
 * `No "exports" main defined`。而 `./package.json` 子路径也没导出，绕不过去。
 * pnpm 把直接依赖做成软链，`realpath` 一下就是真包目录（扁平布局下返回自身，同样对）。
 */
function resolveCodemodeDir() {
  return realpath(join(root, 'packages', 'agent', 'node_modules', '@earendil-works', 'pi-codemode'))
}

/** `quickjs.wasm` 的真实路径：从 pi-codemode 自己那里解析，与运行期走的是同一条规则 */
async function resolveQuickJSWasm() {
  const req = createRequire(join(await resolveCodemodeDir(), 'package.json'))
  return req.resolve('quickjs-wasi/quickjs.wasm')
}

/**
 * 自检：照着运行期那两条规则验一遍沙箱的布局。
 *
 * 这条链路最坏的失败是**构建成功、功能坏掉**：esbuild 把 `import.meta.url` 指到 `server.mjs`
 * 旁边之后，worker 与 wasm 都读不到，而报错要到用户派活给 codeact 那一刻才出现。
 * 所以在构建时就按 `dist/wasm.js` / `dist/runtime/host.js` 的位置各解析一次，错了当场失败。
 */
function assertCodemodeLayout() {
  const pkg = join(dist, 'server', 'node_modules', '@earendil-works', 'pi-codemode')
  const wasm = createRequire(join(pkg, 'dist', 'wasm.js')).resolve('quickjs-wasi/quickjs.wasm')
  const worker = join(pkg, 'dist', 'runtime', 'worker.js')
  for (const [label, path] of [
    ['quickjs.wasm', wasm],
    ['codemode worker', worker],
  ]) {
    if (!existsSync(path)) throw new Error(`脚本沙箱缺文件（${label}）：${path}`)
  }
  // 解析到仓库自己的 node_modules 不算成功 —— 打包后那台机器上没有它
  if (!wasm.startsWith(dist)) {
    throw new Error(`quickjs.wasm 解析到了安装包之外：${wasm}（应该落在 ${dist} 里）`)
  }
}

/**
 * 审计安装包里的原生模块 —— 只报不拦（见文件头）。
 *
 * 查 `.node` / `binding.gyp` / 平台动态库。**不查 `.wasm`**：PGlite 的 `pglite.wasm`
 * 是必须随包走的字节码，跨平台、无需编译，跟"原生模块"是两回事。
 *
 * 平台标签从路径猜（`reflink.darwin-arm64.node`、`.../win32-x64/...`）：出现非本平台的
 * 产物说明带了用不上的东西，值得在输出里点出来，但不该因此让构建失败。
 */
async function auditNative(path) {
  const found = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await auditNative(child)))
      continue
    }
    const isNative =
      entry.name.endsWith('.node') ||
      entry.name === 'binding.gyp' ||
      /\.(dylib|so|dll)$/.test(entry.name)
    if (!isNative) continue
    const rel = relative(dist, child)
    const platform = /(darwin|win32|linux|freebsd)-(arm64|x64|ia32|arm)/.exec(rel)?.[0] ?? null
    found.push({ rel, platform, bytes: (await stat(child)).size })
  }
  return found
}

function reportNatives(natives) {
  if (natives.length === 0) return ['原生模块      无']
  const total = natives.reduce((sum, n) => sum + n.bytes, 0)
  const lines = [`原生模块      ${natives.length} 个 / ${kib(total)}（已放开，仅审计）`]
  for (const n of natives.sort((a, b) => b.bytes - a.bytes)) {
    const tag =
      n.platform === null
        ? '跨平台'
        : n.platform === `${process.platform}-${process.arch}`
          ? '本平台'
          : '其他平台·不加载'
    lines.push(`  ${kib(n.bytes).padStart(6)}  ${tag.padEnd(15)} ${n.rel}`)
  }
  return lines
}

async function main() {
  await rm(dist, { recursive: true, force: true })
  await mkdir(join(dist, 'server'), { recursive: true })

  // 1) 主进程：electron 外部化，其余（paths/supervisor）全部打进来
  await build({
    entryPoints: [join(here, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    outfile: join(dist, 'main.mjs'),
    logLevel: 'warning',
    banner: { js: "import { createRequire as __tenonCreateRequire } from 'node:module'\nconst require = __tenonCreateRequire(import.meta.url)" },
  })

  // 2) 整个 server 打成一个文件
  await build({
    entryPoints: [join(root, 'packages', 'server', 'src', 'bin.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(dist, 'server', 'server.mjs'),
    logLevel: 'warning',
    banner: { js: BANNER },
    external: [...PGLITE_EXTERNAL, ...CODEMODE_EXTERNAL],
  })

  // 2b) PGlite 原样随包走（含 wasm / data / 扩展）
  const pgliteSrc = resolvePgliteDir()
  await cp(pgliteSrc, join(dist, 'server', 'node_modules', '@electric-sql', 'pglite'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map') && !src.endsWith('.d.ts') && !src.endsWith('.d.cts'),
  })

  // 2b-2) 脚本沙箱：pi-codemode 整包 + quickjs.wasm
  //
  // 两者必须**放在同一个 node_modules 树里**：pi-codemode 用 `createRequire` 从自己的位置
  // 解析 `quickjs-wasi/quickjs.wasm`，所以 `dist/server/node_modules/quickjs-wasi/` 正好是
  // 它往上找时的落点。改目录结构前先读一遍 `dist/wasm.js` 那三行。
  await cp(await resolveCodemodeDir(), join(dist, 'server', 'node_modules', '@earendil-works', 'pi-codemode'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map') && !src.endsWith('.d.ts'),
  })
  /*
   * quickjs-wasi 要整个包（`dist/` 也要）：`vm.js` 会 `import { QuickJS } from "quickjs-wasi"`
   * 拿它自己的 JS 驱动层。但 `extensions/*.so` 不用拷 —— 那是「可选的原生 WASI 扩展」，
   * 只有给 `QuickJS.create({ extensions })` 才加载，pi-codemode 一个都不传。
   * 少拷 540KB，也让安装包的原生模块审计只剩真正要看的那些。
   */
  const quickjsPkg = dirname(await resolveQuickJSWasm())
  await cp(quickjsPkg, join(dist, 'server', 'node_modules', 'quickjs-wasi'), {
    recursive: true,
    filter: (src) => !src.includes('/extensions/') && !src.endsWith('.map') && !src.endsWith('.d.ts'),
  })

  // 2c) pnpm 也随包走：用户机器上不该假设装了 pnpm
  //
  // 这是「双击装完却起不来预览」的根治办法。`deps.ts` 用 `import.meta.url` 相对定位
  // 它（打包后正好是 `<Resources>/server/node_modules/pnpm/bin/pnpm.cjs`），
  // 找到就用 node 跑，找不到才退回 PATH 里的 `pnpm`。
  const reqDesktop = createRequire(join(here, 'package.json'))
  // `resolve('pnpm')` 给的是 package.json 本身（它没有可解析的主入口）
  const pnpmPkg = dirname(reqDesktop.resolve('pnpm'))
  await cp(pnpmPkg, join(dist, 'server', 'node_modules', 'pnpm'), {
    recursive: true,
    // pnpm 自带 4 个平台的 `reflink.*.node`（copy-on-write 加速，可选依赖）。
    // v1.2.12 及以前这里把它们删掉了，为的是守住"零原生模块"；放开之后没必要再削它 ——
    // 留着能让 `install` 在支持 reflink 的文件系统（APFS / Btrfs / ReFS）上少拷一遍文件。
    // 非本平台的那几个会在审计输出里标成"其他平台·包内无用"，几百 KB，不影响功能。
    filter: (src) => !src.endsWith('.map'),
  })

  // 3) 模板（真实文件，渲染时逐个读）
  await cp(join(root, 'packages', 'generator', 'templates'), join(dist, 'templates'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.endsWith('/dist'),
  })

  /*
   * 3b) 官方组件（真实文件，加载器按目录找 `manifest.json`）。
   *
   * 目录可以暂时是空的（M5 第 3 步才放第一个组件），但**目录本身必须存在**：
   * 主进程把 `TENON_PLUGINS_DIR` 指过来，少一个目录就等于"官方组件全丢了"，
   * 而那种缺失在界面上只表现为插件页空空如也。
   */
  const pluginsSrc = join(root, 'plugins', 'bundled')
  if (!existsSync(pluginsSrc)) throw new Error(`缺少官方组件目录：${pluginsSrc}`)
  await cp(pluginsSrc, join(dist, 'plugins'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })

  // 4) 渲染器产物
  const webDist = join(root, 'apps', 'web', 'dist')
  try {
    await stat(join(webDist, 'index.html'))
  } catch {
    throw new Error('缺少 apps/web/dist —— 先跑 `pnpm build:web`（根脚本 build:desktop 已经代劳）')
  }
  await cp(webDist, join(dist, 'web'), { recursive: true })

  assertCodemodeLayout()

  const natives = await auditNative(dist)
  if (natives.length > 0 && process.env['TENON_STRICT_NATIVE'] === '1') {
    throw new Error(
      `TENON_STRICT_NATIVE=1 且 dist 里出现了原生模块：\n${natives.map((n) => n.rel).join('\n')}`,
    )
  }

  const mainSize = (await stat(join(dist, 'main.mjs'))).size
  const serverSize = (await stat(join(dist, 'server', 'server.mjs'))).size
  process.stdout.write(
    [
      `main.mjs      ${kib(mainSize)}`,
      `server.mjs    ${kib(serverSize)}`,
      `pglite+pnpm   ${kib(await sizeOf(join(dist, 'server', 'node_modules')))}（外部化）/ pnpm ${kib(await sizeOf(join(dist, 'server', 'node_modules', 'pnpm')))}`,
      `codemode      ${kib(await sizeOf(join(dist, 'server', 'node_modules', '@earendil-works', 'pi-codemode')))} + quickjs.wasm ${kib((await stat(join(dist, 'server', 'node_modules', 'quickjs-wasi', 'quickjs.wasm'))).size)}`,
      `templates     ${kib(await sizeOf(join(dist, 'templates')))}`,
      `plugins       ${kib(await sizeOf(join(dist, 'plugins')))}`,
      `web           ${kib(await sizeOf(join(dist, 'web')))}`,
      ...reportNatives(natives),
    ].join('\n') + '\n',
  )
}

main().catch((error) => {
  process.stderr.write(`构建失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
