/**
 * 发布一个官方组件到 Hub（CLI 薄壳）。
 *
 * 真正的逻辑在 `scripts/lib/pack.ts` —— 因为 `pnpm e2e:hub` 必须走**同一段代码**，
 * 否则验收验的是"另一套打包器"。
 *
 * 用法：
 *   TENON_HUB_PRIVATE_KEY="$(cat ~/.tenon/hub-key.pem)" pnpm pack:plugin tenon.official.ai-assistant
 *   # 可选：--out <dir>            默认 dist/hub
 *   #      --dir <插件源目录>      默认 plugins/bundled
 *   #      --hub-url <url>        默认取 TENON_HUB_URL；都没有就只打包、不写索引
 *   # 生成密钥（只在需要时）：openssl genpkey -algorithm ed25519 -out hub-key.pem
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PackError, packComponent } from './lib/pack.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(join(here, '..'))

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const id = process.argv[2]
if (id === undefined || id.startsWith('--')) {
  console.error('用法：pnpm pack:plugin <组件 id> [--out dist/hub] [--dir plugins/bundled] [--hub-url <url>]')
  console.error('需要环境变量 TENON_HUB_PRIVATE_KEY（Ed25519 私钥 PEM）')
  process.exit(2)
}

const privateKey = process.env['TENON_HUB_PRIVATE_KEY'] ?? ''
if (privateKey.trim() === '') {
  // 出"没有签名的包"是最坏的一种友好：客户端一定拒，而问题要到安装那一刻才暴露
  console.error('缺 TENON_HUB_PRIVATE_KEY。没有私钥就不该产出包 —— 客户端只认签名过的。')
  process.exit(2)
}

const hubUrl = (process.env['TENON_HUB_URL'] ?? arg('hub-url', '') ?? '').trim().replace(/\/+$/, '')

try {
  const result = await packComponent({
    sourceDir: resolve(arg('dir', join(repo, 'plugins', 'bundled'))!),
    outDir: resolve(arg('out', join(repo, 'dist', 'hub'))!),
    id,
    privateKey,
    hubUrl: hubUrl === '' ? null : hubUrl,
  })

  console.log(`已打包并签名：${result.file}`)
  console.log(`  ${id} v${result.version} · ${result.files} 个文件 · ${(result.bytes / 1024).toFixed(1)} KB`)
  if (result.indexFile === null) {
    console.log('')
    console.log('跳过索引：没给 TENON_HUB_URL。')
    console.log('  索引里必须写绝对地址（客户端只认 Hub 源之下的 URL），所以这里不猜。')
  } else {
    console.log(`已更新索引：${result.indexFile}（${result.indexComponents} 个组件）`)
  }
  console.log('  上传 dist/hub/ 下的全部文件到 Hub，客户端用 TENON_HUB_PUBLIC_KEY 验签。')
} catch (error) {
  // PackError 的 message 已经是"人能读"的；其它错误保留类型，方便发现真 bug
  console.error(error instanceof PackError ? error.message : `打包失败：${String(error)}`)
  process.exit(1)
}
