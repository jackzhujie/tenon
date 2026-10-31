/**
 * 桌面版构建：把"三个能独立跑的东西"铺成一份同构的 `dist/`。
 *
 * ```
 * apps/desktop/dist/
 *   main.mjs              ← Electron 主进程（只有 electron 是外部依赖）
 *   server/server.mjs     ← 整个 server 打成一个文件（12MB，含 fastify/pi/isomorphic-git）
 *   templates/            ← 建应用用的模板（真实文件，必须随包走）
 *   web/                  ← 渲染器产物（`pnpm build:web` 的 dist）
 * ```
 *
 * 为什么 server 能打成一个文件：M1 的服务端依赖全是纯 JS（产品库是 `node:sqlite`，
 * 生成应用才可能碰 PGlite），**没有任何需要按平台编译的模块** —— 铁律 3 在这里守住。
 * 打包末尾会扫一遍 `dist/`，发现 `.node` 就直接失败，而不是等用户装完才发现。
 *
 * 两个必须写进配置的细节：
 * 1. `banner` 注入 `createRequire`：isomorphic-git 里有 CJS 依赖，ESM 产物里没有 `require`
 * 2. `templates` 必须落在 `dist/templates`：`registry.ts` 按 `import.meta.url` 找 `../templates`
 */
import { build } from 'esbuild'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
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

function resolvePgliteDir() {
  const req = createRequire(join(root, 'packages', 'db-provisioner', 'package.json'))
  // 包没有导出 `./package.json`，所以从主入口往上退两级
  return dirname(dirname(req.resolve('@electric-sql/pglite')))
}

/** 铁律 3：安装包里不许有需要按平台编译的东西 */
async function findNative(path) {
  const found = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) found.push(...(await findNative(child)))
    else if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') found.push(child)
  }
  return found
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
    external: PGLITE_EXTERNAL,
  })

  // 2b) PGlite 原样随包走（含 wasm / data / 扩展）
  const pgliteSrc = resolvePgliteDir()
  await cp(pgliteSrc, join(dist, 'server', 'node_modules', '@electric-sql', 'pglite'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map') && !src.endsWith('.d.ts') && !src.endsWith('.d.cts'),
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
    // 删掉不影响功能（实测验过 `install` 正常），换来「安装包里零原生模块」这条不变量 ——
    // 它比那点 clone 加速值钱得多，也让跨平台产物只有一份。
    filter: (src) => !src.endsWith('.map') && !src.endsWith('.node'),
  })

  // 3) 模板（真实文件，渲染时逐个读）
  await cp(join(root, 'packages', 'generator', 'templates'), join(dist, 'templates'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.endsWith('/dist'),
  })

  // 4) 渲染器产物
  const webDist = join(root, 'apps', 'web', 'dist')
  try {
    await stat(join(webDist, 'index.html'))
  } catch {
    throw new Error('缺少 apps/web/dist —— 先跑 `pnpm build:web`（根脚本 build:desktop 已经代劳）')
  }
  await cp(webDist, join(dist, 'web'), { recursive: true })

  const natives = await findNative(dist)
  if (natives.length > 0) {
    throw new Error(`dist 里出现了需要按平台编译的模块（铁律 3）：\n${natives.map((n) => relative(dist, n)).join('\n')}`)
  }

  const mainSize = (await stat(join(dist, 'main.mjs'))).size
  const serverSize = (await stat(join(dist, 'server', 'server.mjs'))).size
  process.stdout.write(
    [
      `main.mjs      ${kib(mainSize)}`,
      `server.mjs    ${kib(serverSize)}`,
      `pglite+pnpm   ${kib(await sizeOf(join(dist, 'server', 'node_modules')))}（外部化）/ pnpm ${kib(await sizeOf(join(dist, 'server', 'node_modules', 'pnpm')))}`,
      `templates     ${kib(await sizeOf(join(dist, 'templates')))}`,
      `web           ${kib(await sizeOf(join(dist, 'web')))}`,
      '原生模块      无 ✅',
    ].join('\n') + '\n',
  )
}

main().catch((error) => {
  process.stderr.write(`构建失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
