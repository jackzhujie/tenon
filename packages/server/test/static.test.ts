/**
 * 同源托管（Electron 壳 / Web 模式的页面来源）。
 *
 * 这里每条断言都对着一个"打包之后才会暴露"的失败模式：
 * - 页面免 Token（否则窗口里只有 401 的 JSON）
 * - **接口不免 Token**（否则本机任何进程都能读写用户磁盘）
 * - index.html 每次回源（缓存住 = 注入的 token 永远是上一次启动的）
 * - 前端路由回落成 HTML，但 `/assets/*.js` 不许回落（回落成 HTML = `SyntaxError`）
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunningServer } from '../src/index.js'
import { createStaticServing } from '../src/static.js'
import { TEST_TOKEN, boot } from './support.js'

const INDEX = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'

describe('同源托管渲染器产物', () => {
  let server: RunningServer
  let home: string
  let webDir: string

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'tenon-static-'))
    webDir = join(home, 'web')
    await mkdir(join(webDir, 'assets'), { recursive: true })
    await writeFile(join(webDir, 'index.html'), INDEX, 'utf8')
    await writeFile(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)\n', 'utf8')
    server = await boot(home, { webDir })
  })

  afterAll(async () => {
    await server.close()
  })

  const get = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.url}${path}`, init)

  it('首页免 Token，且把 Token 注入到 <head> 里', async () => {
    const response = await get('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain(`window.__TENON__={"token":"${TEST_TOKEN}"}`)
    // 必须在 head 里：页面脚本执行前就得读得到
    expect(html.indexOf('__TENON__')).toBeLessThan(html.indexOf('</head>'))
  })

  it('前端路由回落成 index.html（Electron 里 F5 不能白屏）', async () => {
    const response = await get('/apps/app_123')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('__TENON__')
  })

  it('带哈希的 assets 永久缓存', async () => {
    const response = await get('/assets/app-abc123.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(await response.text()).toBe('console.log(1)\n')
  })

  it('缺文件不回落（否则浏览器拿到 HTML 会报 SyntaxError，看不出是 404）', async () => {
    const response = await get('/assets/missing.js')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('__TENON__')
  })

  it('接口仍然要 Token —— 页面公开不等于接口公开', async () => {
    const health = await get('/api/health')
    expect(health.status).toBe(200) // 健康检查本来就不需要

    const rpc = await get('/rpc/health')
    expect(rpc.status).toBe(401)
    const events = await get('/events')
    expect(events.status).toBe(401)
  })

  it('带 Token 的 RPC 照旧', async () => {
    const response = await fetch(`${server.url}/rpc/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
      body: '{}',
    })
    expect(response.status).toBe(200)
  })

  it('不越出 dist 目录', async () => {
    /*
     * 分两层测：
     *
     * - HTTP 层只能断言"没泄露"：Fastify 的路由在匹配前就把 `..` 规范化掉了，
     *   所以真正到达处理函数的路径是 `/etc/passwd`（然后按前端路由回落成 index.html）
     * - 处理函数层直接喂一条没被规范化的 URL：这才是守卫生效的地方
     */
    const response = await get('/%2e%2e/%2e%2e/etc/passwd')
    expect([200, 400, 404]).toContain(response.status)
    expect(await response.text()).not.toContain('root:')
  })
})

describe('没有 webDir 时（纯 API 服务）', () => {
  it('根路径就是 404，不会莫名其妙冒出 HTML', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tenon-noweb-'))
    const server = await boot(home)
    try {
      const response = await fetch(`${server.url}/`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('路径守卫（绕过 HTTP 路由层直接喂未规范化的 URL）', () => {
  /** 只实现被用到的三个方法；断言"发了什么"比断言"路由怎么处理"更准 */
  const fakeReply = (): { reply: never; status: () => number | undefined } => {
    let code: number | undefined
    const reply = {
      code(value: number) {
        code = value
        return reply
      },
      header() {
        return reply
      },
      type() {
        return reply
      },
      send() {
        return reply
      },
    }
    return { reply: reply as never, status: () => code }
  }

  it('`..` 一律 400，不会去读 dist 外面的文件', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tenon-guard-'))
    const webDir = join(home, 'web')
    await mkdir(webDir, { recursive: true })
    await writeFile(join(webDir, 'index.html'), INDEX, 'utf8')
    const serving = createStaticServing({ dir: webDir, token: 't' })

    for (const url of ['/../../etc/passwd', '/assets/../../../etc/hosts', '/..%2f..%2fetc%2fpasswd']) {
      const { reply, status } = fakeReply()
      const handled = await serving.handle({ method: 'GET', url } as never, reply)
      expect(handled).toBe(true)
      expect(status()).toBe(400)
    }
  })
})
