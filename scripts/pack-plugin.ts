/**
 * 把一个官方组件打包成 Hub 能分发的 `bundle.json`（M6）。
 *
 * 为什么要有这个脚本：Hub 客户端（`packages/component-host/src/hub.ts`）验签很严，
 * 而"严格"必须能用一条命令走通 —— 否则第一次上架时才发现"我们的包先生不出来"，
 * 那时候所有压力都在发布当天。
 *
 * 它做的事：
 *   1. 读 `plugins/bundled/<id>/manifest.json` 与清单里声明的 facet 文件
 *   2. 组装成 `{ format, manifest, files }`，用**私钥**签名
 *   3. 写 `<out>/<id>-<version>.json`
 *
 * 私钥从哪来：`TENON_HUB_PRIVATE_KEY`（PEM）。**私钥不进仓库、不进安装包** ——
 * 它只在发布流水线上。没有私钥就拒绝生成（不能出"没有签名的包"，客户端一定验不过）。
 *
 * 用法：
 *   TENON_HUB_PRIVATE_KEY="$(cat ~/.tenon/hub-key.pem)" pnpm pack:plugin tenon.official.ai-assistant
 *   # 可选：--out <dir>   默认 dist/hub
 *   # 生成密钥（只在需要时）：openssl genpkey -algorithm ed25519 -out hub-key.pem
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 脚本走源码相对路径（与其它 scripts 一致）：这里不需要构建产物
import { parseManifest, signBundle } from '../packages/component-host/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(join(here, '..'))

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const id = process.argv[2]
if (id === undefined || id.startsWith('--')) {
  console.error('用法：pnpm pack:plugin <组件 id> [--out dist/hub] [--dir plugins/bundled]')
  console.error('需要环境变量 TENON_HUB_PRIVATE_KEY（Ed25519 私钥 PEM）')
  process.exit(2)
}

const privateKey = process.env['TENON_HUB_PRIVATE_KEY'] ?? ''
if (privateKey.trim() === '') {
  // 出"没有签名的包"是最坏的一种友好：客户端一定拒，而问题要到安装那一刻才暴露
  console.error('缺 TENON_HUB_PRIVATE_KEY。没有私钥就不该产出包 —— 客户端只认签名过的。')
  process.exit(2)
}

const sourceDir = resolve(arg('dir', join(repo, 'plugins', 'bundled'))!)
const outDir = resolve(arg('out', join(repo, 'dist', 'hub'))!)
const pluginDir = join(sourceDir, id)

const rawManifest = JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8')) as unknown
const parsed = parseManifest(rawManifest)
if (parsed.manifest === null) {
  console.error(`清单不合法：\n- ${parsed.issues.join('\n- ')}`)
  process.exit(1)
}
const manifest = parsed.manifest
if (manifest.id !== id) {
  console.error(`目录名是 ${id}，清单里是 ${manifest.id} —— 两者必须一致（加载器按目录名找）`)
  process.exit(1)
}

/*
 * 打进包里的文件：清单声明的 facet + README（agentHints 的完整版，人也要读）。
 * 不打包 `*.ts` 源文件：facet 是构建产物，装上就能跑；带上源码只会让包变大，
 * 还会让人以为"Hub 上的组件是可以就地改的"。
 */
const files: Record<string, string> = {}
for (const [host, facet] of Object.entries(manifest.facets)) {
  if (typeof facet !== 'string') continue
  try {
    files[facet] = await readFile(join(pluginDir, facet), 'utf8')
  } catch {
    console.error(`清单声明了 ${host} facet「${facet}」，但文件不存在 —— 先跑 pnpm build:plugins`)
    process.exit(1)
  }
}
try {
  files['README.md'] = await readFile(join(pluginDir, 'README.md'), 'utf8')
} catch {
  // README 是给 Agent 读的用法说明，可选
}

const bundle = signBundle(
  {
    format: 1,
    // source 由安装端改写，这里照实写 hub 之外的值也没有意义 —— 统一写 hub
    manifest: { ...manifest, source: 'hub' },
    files,
  },
  privateKey,
)

await mkdir(outDir, { recursive: true })
const outFile = join(outDir, `${manifest.id}-${manifest.version}.json`)
await writeFile(outFile, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')

const bytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8')
console.log(`已打包并签名：${outFile}`)
console.log(`  ${manifest.id} v${manifest.version} · ${Object.keys(files).length} 个文件 · ${(bytes / 1024).toFixed(1)} KB`)
console.log('  上传到 Hub 之后，客户端用 TENON_HUB_PUBLIC_KEY 验签安装。')
