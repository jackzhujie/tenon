/**
 * 端口探测。
 *
 * 为什么不用「vite 自己找空闲端口」：那样网关先把路由指到一个猜的端口，
 * 等 vite 起来才知道真实端口，中间那段时间 iframe 是 502，而且一旦 vite 换了端口
 * （既没 `strictPort` 又有占用）整个 HMR 的 clientPort 就错了。
 *
 * 所以顺序固定：**先拿到确定的端口 → 用它配 strictPort → 再起进程**。
 * 代价是存在极小的 TOCTOU 窗口（关掉探测 socket 到 vite 真正 listen 之间被抢），
 * 本地单用户场景可接受；真被抢了 strictPort 会让 vite 直接失败，而不是悄悄换端口。
 */
import { createServer } from 'node:net'

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (port === 0) throw new Error('拿不到空闲端口')
  return port
}

/**
 * 一次要两个端口（dev server + 网关）。`used` 在同一个进程内去重，
 * 避免「探测两次拿到同一个端口」这种自伤。
 */
export async function findFreePorts(count: number, used: Set<number> = new Set()): Promise<number[]> {
  const ports: number[] = []
  for (let i = 0; i < count; i += 1) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await findFreePort()
      if (!used.has(port)) {
        used.add(port)
        ports.push(port)
        break
      }
    }
  }
  if (ports.length !== count) throw new Error(`端口探测失败：要 ${count} 个，只拿到 ${ports.length} 个`)
  return ports
}
