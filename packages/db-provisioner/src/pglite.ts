/**
 * `pglite` 档 —— 把 WASM 版 PostgreSQL 暴露成一个真的 TCP 端口（DESIGN §6.4 默认档）。
 *
 * 结构（spike 4 固化成产品代码）：
 *
 *   TypeORM(pg) ──socket──> pg-gateway ──串行队列──> PGlite.execProtocolRaw
 *
 * 三个必须守住的点：
 *
 * 1. **一条全局串行队列。** PGlite 是单 backend 会话，`execProtocolRaw` 不可重入；
 *    两条连接的消息交错进同一个会话会串协议状态。队列只保证"一问一答不交叉"，
 *    不提供并发 —— 并发上限由 `poolMax()` 回答（恒为 1）。
 * 2. **`start()` 幂等、`stop()` 不删数据。** 同一个数据目录被两个 PGlite 实例打开
 *    会直接坏库（PGlite 自己会抛 locked，但那时已经晚了）。停预览 ≠ 删库。
 * 3. **`restore()` 换实例而不是原地灌 SQL。** 数据目录归档用 `dumpDataDir()` 打出
 *    tar.gz，还原走 PGlite 自己的 `loadDataDir`（它内部解包）—— 自己写 tar 解包器
 *    迟早会踩 pax 长文件名，而且这类 bug 只在"库里有中文表名"时才出现。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { join, dirname } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { msg, TenonError } from '@tenon/protocol'
import { fromNodeSocket } from 'pg-gateway/node'
import type { DatabaseProvider, DbSnapshot, DbState, DbStatus, ProviderOptions } from './types.js'

const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 60_000

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class PgliteProvider implements DatabaseProvider {
  readonly mode = 'pglite' as const
  private state: DbState = 'stopped'
  private error: string | null = null
  private db: PGlite | null = null
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private port: number | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private starting: Promise<void> | null = null
  /** 还原用的：下次 `start()` 时把这份归档灌进数据目录（PGlite 内部解包） */
  private loadDataDir: Blob | null = null
  private readonly log: (line: string) => void

  constructor(private readonly options: ProviderOptions & { dataDir: string }) {
    this.log = options.log ?? (() => undefined)
  }

  connectionString(): string {
    if (this.port === null) {
      throw new TenonError('DB_NOT_READY', msg('error.db.notStarted'), { mode: this.mode })
    }
    // PGlite 的默认库就是 postgres；用户名密码是占位（pg-gateway 走 trust）
    return `postgres://postgres:postgres@${HOST}:${this.port}/postgres`
  }

  /** ★ 恒为 1。见 `types.ts` 文件头与 DESIGN §6.4 */
  poolMax(): number {
    return 1
  }

  status(): DbStatus {
    return {
      mode: this.mode,
      state: this.state,
      connectionString: this.port === null ? null : this.connectionString(),
      port: this.port,
      poolMax: this.poolMax(),
      dataDir: this.options.dataDir,
      error: this.error,
    }
  }

  async start(): Promise<void> {
    if (this.state === 'ready') return
    // 并发调用（预览重启与探活同时进来）只起一次
    if (this.starting !== null) return this.starting
    this.starting = this.doStart().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async doStart(): Promise<void> {
    this.state = 'starting'
    this.error = null
    try {
      await mkdir(this.options.dataDir, { recursive: true })
      const db =
        this.loadDataDir === null
          ? new PGlite(this.options.dataDir)
          : new PGlite({ dataDir: this.options.dataDir, loadDataDir: this.loadDataDir })
      this.loadDataDir = null
      await withTimeout(db.waitReady as Promise<unknown>, START_TIMEOUT_MS, () =>
        msg('error.db.pgliteTimeout', {
          seconds: START_TIMEOUT_MS / 1000,
          dir: this.options.dataDir,
        }),
      )
      this.db = db
      await this.listen()
      this.state = 'ready'
      this.log(`[tenon] app database ready (pglite ${this.connectionString()}, pool.max=1)`)
    } catch (err) {
      this.state = 'failed'
      this.error = messageOf(err)
      await this.shutdown()
      throw err instanceof TenonError
        ? err
        : new TenonError('DB_START_FAILED', msg('error.db.startFailed', { detail: this.error ?? '' }), {
            mode: this.mode,
            dataDir: this.options.dataDir,
          })
    }
  }

  /**
   * 起 TCP 端口。
   *
   * 还原之后要复用同一个端口（否则上层缓存的 `DATABASE_URL` 就失效了），
   * 而刚关掉的监听端口可能还在 TIME_WAIT 里 —— 重试几次比换端口安全。
   */
  private async listen(): Promise<void> {
    const db = this.db
    if (db === null) throw new TenonError('DB_NOT_READY', msg('error.db.listenMissing'))

    const server: Server = createServer((socket) => {
      this.sockets.add(socket)
      socket.on('error', () => {
        // 客户端粗暴断开是常态（热重启 / TypeORM 换连接）
      })
      socket.on('close', () => this.sockets.delete(socket))

      void fromNodeSocket(socket, {
        serverVersion: '18.0',
        auth: { method: 'trust' },
        onMessage: (data) => this.enqueue(() => db.execProtocolRaw(data)),
      }).catch(() => {
        socket.destroy()
      })
    })

    const desired = this.port
    const attempts = desired === null ? 1 : 5
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error): void => reject(err)
          server.once('error', onError)
          server.listen(desired ?? 0, HOST, () => {
            server.off('error', onError)
            resolve()
          })
        })
        break
      } catch (err) {
        if (attempt === attempts - 1) throw err
        await sleep(150 * (attempt + 1))
      }
    }

    const address = server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new TenonError('DB_START_FAILED', msg('error.db.noPort'))
    }
    this.port = address.port
    this.server = server
  }

  /** 唯一的一条串行队列：PGlite 只有一个 backend 会话 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.catch(() => undefined)
    return result
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    await this.shutdown()
  }

  private async shutdown(): Promise<void> {
    const server = this.server
    const db = this.db
    this.server = null
    this.db = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 已经关掉的 server 不会再回调 close
        setTimeout(resolve, 2000)
      })
    }
    await this.tail.catch(() => undefined)
    if (db !== null) await db.close().catch(() => undefined)
  }

  /**
   * 整库快照。`dumpDataDir()` 产出的是数据目录的 tar.gz，
   * 与 `restore()` 的 `loadDataDir` 是配套的一对（跨档迁移另走 `pg_dump` 逻辑导出）。
   */
  async dump(file?: string): Promise<DbSnapshot> {
    if (this.db === null || this.state !== 'ready') {
      throw new TenonError('DB_NOT_READY', msg('error.db.notReadyForSnapshot'), { mode: this.mode })
    }
    const target = file ?? join(this.snapshotsDir(), `${Date.now()}.tar.gz`)
    try {
      const archive = await this.db.dumpDataDir('gzip')
      const bytes = new Uint8Array(await archive.arrayBuffer())
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      const info = await stat(target)
      this.log(`[tenon] app database snapshot ${target} (${(info.size / 1024 / 1024).toFixed(1)}MB)`)
      return { mode: this.mode, file: target, bytes: info.size, createdAt: Date.now() }
    } catch (err) {
      if (err instanceof TenonError) throw err
      throw new TenonError('DB_DUMP_FAILED', msg('error.db.dumpFailed', { detail: messageOf(err) }), {
        mode: this.mode,
        dataDir: this.options.dataDir,
      })
    }
  }

  async restore(snapshot: DbSnapshot): Promise<void> {
    try {
      const bytes = await readFile(snapshot.file)
      await this.stop()
      // 数据目录必须清空：PGlite 的 loadDataDir 是"往空目录里解包"
      await rm(this.options.dataDir, { recursive: true, force: true })
      await mkdir(this.options.dataDir, { recursive: true })
      this.loadDataDir = new Blob([new Uint8Array(bytes)])
      await this.start()
    } catch (err) {
      if (err instanceof TenonError) throw err
      throw new TenonError('DB_RESTORE_FAILED', msg('error.db.restoreFailed', { detail: messageOf(err) }), {
        mode: this.mode,
        file: snapshot.file,
      })
    }
  }

  private snapshotsDir(): string {
    return this.options.snapshotsDir ?? join(this.options.dataDir, '..', 'db-snapshots')
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, reason: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason())), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createPgliteProvider(options: ProviderOptions & { dataDir: string }): PgliteProvider {
  return new PgliteProvider(options)
}
