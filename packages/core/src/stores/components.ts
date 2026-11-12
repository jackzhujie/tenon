/**
 * 组件的键值存储（M6 第 4 步）。
 *
 * 为什么是 **KV 而不是让组件直接连应用数据库**：组件声明 `db:write` 的意思是"我要存点
 * 自己的数据"，不是"我可以动用户业务表"。给一条 SQL 通道，一个写得不好的组件就能
 * `DROP TABLE orders` —— 而组件是第三方代码，这种风险不该由用户承担。
 *
 * 命名空间是 `(appId, componentId)`：
 * - 同一个组件装进两个应用 → 各自的数据互不可见（审批流在两个应用里互不干扰）；
 * - 两个组件装进同一个应用 → 也互不可见（CSV 导出不该看到审批的单子）。
 *
 * 配额（见 `STORAGE_LIMITS`）不是"以防万一"，而是这个能力的**边界**：没有上限，
 * 一个写坏循环的组件能把这个产品库撑爆，而那时整个 Tenon 都起不来。
 */
import { msg } from '@tenon/protocol'
import type { TenonDatabase } from '../db.js'

export const STORAGE_LIMITS = {
  /** 单个值的上限（UTF-8 字节）。够存几百条审批单，又不至于被塞进一个视频 */
  maxValueBytes: 64 * 1024,
  /** 每个 (应用, 组件) 的键数量上限 */
  maxKeys: 500,
  /** 键的长度上限（防止用超长键把索引撑坏） */
  maxKeyLength: 200,
} as const

/** 超过配额时抛这个，带上具体是哪一条超了 —— 否则用的人只知道"存不进去" */
export class ComponentStorageLimitError extends Error {
  constructor(
    readonly reason: 'value-too-large' | 'too-many-keys' | 'bad-key',
    message: string,
  ) {
    super(message)
    this.name = 'ComponentStorageLimitError'
  }
}

interface KvRow {
  key: string
  value: string
}

export class ComponentStore {
  constructor(private readonly db: TenonDatabase) {}

  get(appId: string, componentId: string, key: string): string | null {
    const row = this.db.get<KvRow>(
      'SELECT key, value FROM component_kv WHERE app_id = ? AND component_id = ? AND key = ?',
      appId,
      componentId,
      key,
    )
    return row?.value ?? null
  }

  /** 键列表（可按前缀过滤）。按 key 排序，调用方要"最近改过的"就自己按 updated_at 再查 */
  keys(appId: string, componentId: string, prefix: string | null = null): string[] {
    const rows =
      prefix === null || prefix === ''
        ? this.db.all<KvRow>(
            'SELECT key, value FROM component_kv WHERE app_id = ? AND component_id = ? ORDER BY key',
            appId,
            componentId,
          )
        : this.db.all<KvRow>(
            `SELECT key, value FROM component_kv
              WHERE app_id = ? AND component_id = ? AND key LIKE ? ESCAPE '\\'
              ORDER BY key`,
            appId,
            componentId,
            `${escapeLike(prefix)}%`,
          )
    return rows.map((row) => row.key)
  }

  count(appId: string, componentId: string): number {
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM component_kv WHERE app_id = ? AND component_id = ?',
      appId,
      componentId,
    )
    return row?.n ?? 0
  }

  /**
   * 写一个键。**配额在这里判**，而不是在调用方 —— 调用方有两个（宿主的 facade、
   * 将来的导入工具），只在一个地方判等于没有判。
   */
  set(appId: string, componentId: string, key: string, value: string): void {
    if (key === '' || key.length > STORAGE_LIMITS.maxKeyLength) {
      throw new ComponentStorageLimitError(
        'bad-key',
        msg('error.componentStorage.badKey', { max: STORAGE_LIMITS.maxKeyLength }),
      )
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > STORAGE_LIMITS.maxValueBytes) {
      throw new ComponentStorageLimitError(
        'value-too-large',
        msg('error.componentStorage.valueTooLarge', {
          max: STORAGE_LIMITS.maxValueBytes / 1024,
          actual: (bytes / 1024).toFixed(1),
        }),
      )
    }
    const existing = this.db.get<{ key: string }>(
      'SELECT key FROM component_kv WHERE app_id = ? AND component_id = ? AND key = ?',
      appId,
      componentId,
      key,
    )
    // 只有"新增键"才查数量：改已有的键不该因为到了上限而被拒
    if (existing === undefined && this.count(appId, componentId) >= STORAGE_LIMITS.maxKeys) {
      throw new ComponentStorageLimitError(
        'too-many-keys',
        msg('error.componentStorage.tooManyKeys', { max: STORAGE_LIMITS.maxKeys }),
      )
    }
    this.db.run(
      `INSERT INTO component_kv (app_id, component_id, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id, component_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      appId,
      componentId,
      key,
      value,
      Date.now(),
    )
  }

  delete(appId: string, componentId: string, key: string): boolean {
    const before = this.db.get<{ key: string }>(
      'SELECT key FROM component_kv WHERE app_id = ? AND component_id = ? AND key = ?',
      appId,
      componentId,
      key,
    )
    if (before === undefined) return false
    this.db.run(
      'DELETE FROM component_kv WHERE app_id = ? AND component_id = ? AND key = ?',
      appId,
      componentId,
      key,
    )
    return true
  }

  /** 删应用时清理它的全部组件数据（注册表里没做外键，所以这里显式删） */
  removeApp(appId: string): number {
    const before = this.count(appId, '')
    this.db.run('DELETE FROM component_kv WHERE app_id = ?', appId)
    return before
  }
}

/** `%` 和 `_` 在 LIKE 里是通配符：前缀里带它们时必须转义，否则前缀过滤会匹配多 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}
