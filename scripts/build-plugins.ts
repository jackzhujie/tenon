/**
 * 组件构建：把每个插件目录里的 TS facet 打成**单文件**。
 *
 * 为什么是单文件：插件目录是随包发布的**只读内容**，不在 `node_modules` 里，
 * 也不该指望用户机器上有 `@earendil-works/chord`。把它打进 `server.js` / `web.js`，
 * 运行时只需 `import('<插件目录>/server.js')` 一句，没有解析路径可言。
 * （Spike 5 验过：chord 打得进单文件，726KB，与 pi-codemode 的 worker+wasm 相反。）
 *
 * 产物**不进 git**：它们是构建物，进仓库只会和源码漂移。所以 `dev` / `test` / 打包
 * 之前都要先跑这一份 —— 与 `build:web` 是同一个约定。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const bundledDir = join(root, 'plugins', 'bundled')

interface PluginManifest {
  readonly id: string
  readonly facets?: Record<string, string | undefined>
}

/** facet 宿主 → esbuild 的打包目标。web 是浏览器，其余是 Node */
const PLATFORM: Record<string, 'node' | 'browser'> = {
  server: 'node',
  worker: 'node',
  web: 'browser',
}

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(0)}KB`

export interface BuiltFacet {
  readonly plugin: string
  readonly host: string
  readonly file: string
  readonly bytes: number
}

/**
 * 构建全部内置组件。`only` 给了就只建那几个（测试用）。
 *
 * 注意**没写 manifest 的目录直接忽略**：`plugins/bundled/` 里将来会有测试夹具、
 * 示例源码之类不该被打包的东西，靠"有没有合法清单"来分辨最省事。
 */
export async function buildPlugins(options: { only?: readonly string[] } = {}): Promise<BuiltFacet[]> {
  const built: BuiltFacet[] = []
  let entries: string[]
  try {
    entries = (await readdir(bundledDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return built // 一个插件都没有是合法状态（M5 之前就是）
  }

  for (const id of entries) {
    if (options.only !== undefined && !options.only.includes(id)) continue
    const dir = join(bundledDir, id)
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as PluginManifest
    } catch {
      continue
    }
    for (const [host, outfile] of Object.entries(manifest.facets ?? {})) {
      if (outfile === undefined) continue
      const platform = PLATFORM[host]
      if (platform === undefined) throw new Error(`${id}：不认识的 facet 宿主「${host}」`)
      const entry = join(dir, `${host}.ts`)
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        platform,
        format: 'esm',
        target: platform === 'browser' ? 'es2022' : 'node22',
        outfile: join(dir, outfile),
        logLevel: 'warning',
        // 浏览器那一侧：某些依赖会摸 `process.env`，不定义就是运行时 ReferenceError
        ...(platform === 'browser' ? { define: { 'process.env.NODE_ENV': '"production"' } } : {}),
      })
      if (result.errors.length > 0) {
        throw new Error(`${id} / ${host} 构建失败：${result.errors.map((e) => e.text).join('；')}`)
      }
      built.push({ plugin: id, host, file: join(dir, outfile), bytes: (await stat(join(dir, outfile))).size })
    }
  }
  return built
}

/** 直接 `node scripts/build-plugins.ts` 跑时打印结果 */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const built = await buildPlugins()
  if (built.length === 0) process.stdout.write('没有要构建的组件\n')
  for (const facet of built) {
    process.stdout.write(`${facet.plugin.padEnd(34)} ${facet.host.padEnd(7)} ${kib(facet.bytes)}\n`)
  }
}
