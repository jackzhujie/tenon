/**
 * LISTEN/NOTIFY 能不能穿过 PGlite + pg-gateway 桥？
 * 这一条决定「后端改动推前端」要不要另找通道（DESIGN §9 说用网关 SSE）。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { startPgliteGateway } from './pglite-gateway.js'

const ROOT = new URL('..', import.meta.url).pathname
const DATA_DIR = join(ROOT, 'pgdata-notify')

const gw = await startPgliteGateway({ dataDir: DATA_DIR })
await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
await mkdir(DATA_DIR, { recursive: true }).catch(() => {})

const conn = { host: gw.host, port: gw.port, user: 'postgres', database: 'postgres' }
const listener = new Client(conn)
const sender = new Client(conn)
await listener.connect()
await sender.connect()

const received: string[] = []
listener.on('notification', (msg) => received.push(`${msg.channel}:${msg.payload}`))

await listener.query('LISTEN tenon_events')
await sender.query(`NOTIFY tenon_events, 'hello-from-nest'`)
await new Promise<void>((r) => setTimeout(r, 1200))

console.log(`收到通知 ${received.length} 条：${received.join(',') || '(无)'}`)
console.log(
  received.length > 0
    ? '✅ LISTEN/NOTIFY 可用，后端可主动推前端'
    : '❌ 收不到通知：pg-gateway 的 onMessage 是一次请求一次响应，PGlite 的异步 NotificationResponse 没有回推通道 → 前端推送必须走网关 SSE',
)

await listener.end()
await sender.end()
await gw.close()
