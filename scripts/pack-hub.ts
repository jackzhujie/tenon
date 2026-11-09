/**
 * `pnpm pack:hub` —— 把 `plugins/bundled/` 下**所有**官方组件打包、签名、刷新索引。
 *
 * 为什么要有这条命令：`pack:plugin <id>` 一次只处理一个，而发布会漏。
 * 漏一个的后果不是"少一个包"——索引是**增量重写**的，漏掉的那个组件会保持旧版本，
 * 于是用户那边"点更新"永远升不上去，而 Hub 上看起来一切正常。
 *
 * 用法：
 *   TENON_HUB_PRIVATE_KEY="$(cat ~/.tenon/hub-key.pem)" \
 *   TENON_HUB_URL="https://…/tenon-hub" pnpm pack:hub
 *
 * 产物在 `dist/hub/`（`index.json` + 每个版本一个 bundle），拷到 Hub 的静态目录即可。
 */
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packComponent } from './lib/pack.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(join(here, '..'))

const privateKey = process.env['TENON_HUB_PRIVATE_KEY'] ?? ''
if (privateKey.trim() === '') {
  // 出"没有签名的包"是最坏的一种友好：客户端一定拒，而问题要到安装那一刻才暴露
  console.error('缺 TENON_HUB_PRIVATE_KEY。没有私钥就不该产出包 —— 客户端只认签名过的。')
  console.error('生成（只需一次）：openssl genpkey -algorithm ed25519 -out ~/.tenon/hub-key.pem')
  process.exit(2)
}

const hubUrl = (process.env['TENON_HUB_URL'] ?? '').trim().replace(/\/+$/, '')
if (hubUrl === '') {
  console.error('缺 TENON_HUB_URL。索引里必须写**绝对**下载地址（客户端只认 Hub 源之下的 URL），所以这里不猜。')
  process.exit(2)
}

const sourceDir = resolve(process.env['TENON_HUB_SOURCE'] ?? join(repo, 'plugins', 'bundled'))
const outDir = resolve(process.env['TENON_HUB_OUT'] ?? join(repo, 'dist', 'hub'))

const entries = await readdir(sourceDir, { withFileTypes: true })
const ids = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

if (ids.length === 0) {
  console.error(`${sourceDir} 下没有组件目录`)
  process.exit(1)
}

console.log(`打包 ${ids.length} 个组件 → ${outDir}\n  Hub: ${hubUrl}\n`)

let indexComponents = 0
for (const id of ids) {
  try {
    const result = await packComponent({ sourceDir, outDir, id, privateKey, hubUrl })
    indexComponents = result.indexComponents
    console.log(
      `✓ ${id} v${result.version} · ${result.files} 个文件 · ${(result.bytes / 1024).toFixed(1)} KB`,
    )
  } catch (error) {
    // 一个组件打不出来就整体失败：半套索引比没有索引更难查（用户看到的是"某些组件点不动"）
    console.error(`✗ ${id}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

console.log(`\n索引里有 ${indexComponents} 个组件：${join(outDir, 'index.json')}`)
console.log('下一步：把 dist/hub/ 下的文件拷到 Hub 的静态目录（`index.json` 与 bundle 平铺同一层）。')
