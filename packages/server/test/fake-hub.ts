/**
 * 一个假的官方 Hub：真发**签名索引**与**签名包**。
 *
 * 为什么抽出来共用：\`hub.test.ts\` 与 \`component-store.test.ts\` 都需要"一个能发
 * 索引与包的 HTTP 服务"。各写一份的话，签名逻辑会漂 —— 而漂的表现是"某一边的用例
 * 悄悄测的是错的包"，比没有测试更糟。
 *
 * 三个刻意做成可变的东西，因为更新这件事的本质就是"过一会儿世界变了"：
 * - \`setVersions\`：Hub 上又发了一版
 * - \`setTampered\`：索引在发布之后被改（降级攻击的入口）
 * - 包里内容由调用方给，所以"投毒的包"也能测
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  HUB_INDEX_FORMAT,
  signHubIndex,
  type HubIndexComponent,
} from '@tenon/component-host'

export interface FakeHub {
  readonly url: string
  /** 换一批版本（模拟"Hub 上又发了一版"） */
  setVersions(versions: readonly string[]): void
  /** 索引在发布之后被改（签名对不上） */
  setTampered(value: boolean): void
  close(): Promise<void>
}

export interface FakeHubOptions {
  readonly componentId: string
  readonly name?: string
  readonly description?: string
  /** 清单里的付费标记（索引上的提示，真判据在包里） */
  readonly pricing?: 'free' | 'paid'
  readonly privateKeyPem: string
  /** 版本 → 包内容（已签名的 \`HubBundle\`） */
  readonly bundles: Record<string, unknown>
  readonly versions: readonly string[]
}

export async function startFakeHub(options: FakeHubOptions): Promise<FakeHub> {
  let versions = [...options.versions]
  let tampered = false

  const server: Server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/index.json') {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const component: HubIndexComponent = {
        id: options.componentId,
        name: options.name ?? 'AI 小助手',
        description: options.description ?? 'Hub 上的组件',
        // 故意倒序：客户端不许靠数组顺序取最新
        versions: [...versions].reverse().map((version) => ({
          version,
          url: `${origin}/bundles/${version}.json`,
          notes: `${version} 的说明`,
          publishedAt: 1,
        })),
        ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
      }
      const signed = signHubIndex(
        { format: HUB_INDEX_FORMAT, generatedAt: 1, components: [component] },
        options.privateKeyPem,
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(tampered ? { ...signed, components: [] } : signed))
      return
    }
    const match = /^\/bundles\/(.+)\.json$/.exec(url)
    const payload = match === null ? undefined : options.bundles[match[1] ?? '']
    if (payload !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setVersions(next) {
      versions = [...next]
    },
    setTampered(value) {
      tampered = value
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
