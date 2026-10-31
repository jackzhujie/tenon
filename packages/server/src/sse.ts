/**
 * SSE 总线：Tenon 唯一的「后端推前端」通道。
 *
 * 为什么必须自己写：PGlite 下 `LISTEN/NOTIFY` 实测收不到通知（SPIKES §1），
 * 而 Tenon 自身不用 WebSocket（WS 只留给预览的 Vite HMR）。所以事件只能走这条。
 *
 * 关键行为：
 * - `seq` 由总线单点分配，永远单调递增
 * - 环形缓冲保留最近 N 条，`since` 续传；追不上就下发 `stream.reset`
 * - 每个客户端一个订阅函数，写失败即摘除（SSE 断开很常见，不能当异常处理）
 */
import type { SseEvent, SseEventInput } from '@tenon/protocol'

const BUFFER_LIMIT = 2048

type Listener = (event: SseEvent) => void

export class SseBus {
  private seq = 0
  private readonly buffer: SseEvent[] = []
  private readonly listeners = new Set<Listener>()

  /** 已分配的最大 seq（新建客户端据此判断是否需要 reset） */
  get lastSeq(): number {
    return this.seq
  }

  /** 缓冲里最早还能重放的 seq */
  get oldestSeq(): number {
    return this.buffer[0]?.seq ?? this.seq + 1
  }

  publish(input: SseEventInput): SseEvent {
    this.seq += 1
    const event = { ...input, seq: this.seq } as SseEvent
    this.buffer.push(event)
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT)
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 单个客户端写失败不影响其他订阅者
        this.listeners.delete(listener)
      }
    }
    return event
  }

  /**
   * 订阅。返回重放的历史事件（可能为空）与取消函数。
   * `since` 早于缓冲起点时，重放列表以 `stream.reset` 开头 —— 由调用方决定随后是否让前端全量拉取。
   */
  subscribe(since: number | undefined, listener: Listener): { replay: SseEvent[]; unsubscribe: () => void } {
    const replay: SseEvent[] = []
    if (since !== undefined && since !== 0) {
      if (since < this.oldestSeq - 1) {
        this.seq += 1
        replay.push({ type: 'stream.reset', seq: this.seq, reason: 'gap' })
      } else {
        for (const event of this.buffer) {
          if (event.seq > since) replay.push(event)
        }
      }
    }
    this.listeners.add(listener)
    return {
      replay,
      unsubscribe: () => {
        this.listeners.delete(listener)
      },
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}
