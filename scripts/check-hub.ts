/**
 * `pnpm hub:check` —— 从**公网**验一遍线上 Hub 是否真的可用。
 *
 * 为什么不能只 `curl -I` 一下 index.json：客户端真正会失败的地方是两个，
 * 而它们都跟 HTTP 200 无关 ——
 *
 * 1. **索引验签**：URL 对了、文件也在，但签名用的是另一把私钥（或者索引被手改过），
 *    客户端会拒绝整份索引，界面上表现为"商店是空的"。
 * 2. **下载地址"不在 Hub 之下"**：索引里的 `url` 是绝对的，客户端要求它落在
 *    `TENON_HUB_URL` 之下。换个目录部署、少写一段路径，就会装不上。
 *
 * 所以这里走客户端自己的 `fetchHubIndex`（含验签与形状检查），再逐个 HEAD 每个 bundle。
 *
 * 用法：
 *   pnpm hub:check                 # 读 apps/desktop/hub.defaults.json
 *   TENON_HUB_URL=… TENON_HUB_PUBLIC_KEY=… pnpm hub:check   # 验私有 Hub
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchHubIndex, hubIndexUrl, latestVersion } from '../packages/component-host/src/hub.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function configFromDefaults(): { hubUrl: string; publicKey: string } {
  const parsed = JSON.parse(
    readFileSync(join(root, 'apps', 'desktop', 'hub.defaults.json'), 'utf8'),
  ) as { hubUrl?: unknown; publicKey?: unknown }
  if (typeof parsed.hubUrl !== 'string' || typeof parsed.publicKey !== 'string') {
    throw new Error('apps/desktop/hub.defaults.json 缺 hubUrl / publicKey')
  }
  return { hubUrl: parsed.hubUrl, publicKey: parsed.publicKey }
}

const envUrl = (process.env['TENON_HUB_URL'] ?? '').trim()
const envKey = (process.env['TENON_HUB_PUBLIC_KEY'] ?? '').trim()
const config =
  envUrl !== '' && envKey !== '' ? { hubUrl: envUrl.replace(/\/+$/, ''), publicKey: envKey } : configFromDefaults()

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

console.log(`Hub: ${hubIndexUrl(config)}\n`)

const fetched = await fetchHubIndex({ config })
if (!fetched.ok) {
  console.log(`✗ 索引不可用：${fetched.problem.code} ${fetched.problem.message}`)
  if (fetched.problem.hint !== null) console.log(`  ${fetched.problem.hint}`)
  process.exit(1)
}

const { index, keyFingerprint } = fetched.value
check(`索引验签通过（${index.components.length} 个组件）`, true)
console.log(`  公钥指纹 ${keyFingerprint.slice(0, 16)} · generatedAt ${new Date(index.generatedAt).toISOString()}\n`)

for (const component of index.components) {
  const latest = latestVersion(component)
  if (latest === undefined) {
    check(`${component.id} 有版本`, false, 'versions 是空的')
    continue
  }
  const expected = `${config.hubUrl}/`
  check(`${component.id} 的下载地址在 Hub 之下`, latest.url.startsWith(expected), latest.url)

  let status = 0
  let contentType = ''
  let length = ''
  try {
    const response = await fetch(latest.url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
    status = response.status
    contentType = response.headers.get('content-type') ?? ''
    length = response.headers.get('content-length') ?? ''
  } catch (error) {
    check(`${component.id} v${latest.version} 可下载`, false, error instanceof Error ? error.message : String(error))
    continue
  }
  check(`${component.id} v${latest.version} 可下载`, status === 200, `HTTP ${status} · ${latest.url}`)
  if (status !== 200) continue
  /*
   * 内容类型也要看：站点是宝塔托管的，`location` 没写 `default_type` 时 nginx 会按
   * 扩展名给 `application/octet-stream` —— 客户端用 `response.json()` 读，不会因此失败，
   * 但"打开这个地址却是下载"这件事会在排障时浪费很久。
   * `content-length` 在 gzip 分块下拿不到，所以只在有值时打印，不显示 `?`。
   */
  check(
    `${component.id} 的 content-type 是 JSON`,
    contentType.startsWith('application/json'),
    contentType === '' ? '（响应里没有 content-type）' : contentType,
  )
  console.log(`      ${length === '' ? 'gzip/chunked' : `${length} 字节`} · ${latest.url}`)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
