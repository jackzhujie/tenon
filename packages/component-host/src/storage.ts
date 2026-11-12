/**
 * 组件的存储能力（M6 第 4 步）。
 *
 * 这一层只做两件事，**不做第三件**：
 * 1. **按权限开门**：没声明 `db:read` 就别想读，没 `db:write` 就别想写。权限来自清单，
 *    而清单是签名过的（Hub 包）—— 所以"组件能干什么"不是它自己运行时说了算。
 * 2. **读改写串行化**：`update()` 把同一个键的并发调用排成队列。审批流那种
 *    "读列表 → 加一条 → 写回"如果并发跑两次，后写的会把先写的吃掉 —— 而这种丢数据
 *    在界面上表现为"我刚提交的单子不见了"，极难复现。
 *
 * **不做配额**：上限属于存储后端（`@tenon/core` 的 `ComponentStore`）。两处各写一遍
 * 限制值迟早漂，而漂的方式是"一边放行一边拒绝"，比没有限制更让人糊涂。
 *
 * 后端是一个很窄的接口（`StorageBackend`），所以这里可以纯单测，也方便换实现
 * （现在是产品库的 sqlite；将来多租户可能换成远端）。
 */
import { msg, TenonError } from '@tenon/protocol'

/** 组件能声明的存储权限（与 `manifest.ts` 的白名单一致） */
export const STORAGE_READ_PERMISSION = 'db:read'
export const STORAGE_WRITE_PERMISSION = 'db:write'

/**
 * 组件看到的存储。**全是 async**：现在的后端是同步的 sqlite，但把"将来会走远端"
 * 这件事提前放进签名里 —— 组件的代码改一次比接口改一次便宜得多。
 */
export interface ComponentStorage {
  /** 读不到（键不存在）返回 null，不抛 —— "没有"是正常状态 */
  get(key: string): Promise<string | null>
  /** 列出自己的键（可按前缀）。**只能看见自己的**，命名空间由宿主绑定 */
  keys(prefix?: string): Promise<string[]>
  set(key: string, value: string): Promise<void>
  /** 返回"之前有没有这个键"。删不存在的键不算错 */
  delete(key: string): Promise<boolean>
  /**
   * 原子读改写：`fn` 返回新值，返回值是写进去的那个。
   * 想删除就用 `delete`，`fn` 里抛错就整条不改。
   */
  update(key: string, fn: (old: string | null) => string): Promise<string>
}

/**
 * 宿主绑定好命名空间之后的窄接口。
 *
 * 三个方法的实现里**不许**再出现 appId / componentId —— 那是宿主的责任。
 * 组件拿不到它们，也就不可能"顺手"去读隔壁的键。
 */
export interface StorageBackend {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): boolean
  keys(prefix: string | null): string[]
}

export interface CreateStorageOptions {
  readonly backend: StorageBackend
  /** 清单里声明的权限（`db:read` / `db:write` …） */
  readonly permissions: readonly string[]
  /** 只用于错误文案：告诉用户是哪个组件被拒了 */
  readonly componentId: string
}

function denied(componentId: string, action: string): TenonError {
  return new TenonError(
    'COMPONENT_PERMISSION_DENIED',
    msg('error.component.permissionDenied', { id: componentId, action }),
    {
      hint:
        action === STORAGE_READ_PERMISSION
          ? msg('component.storage.needRead')
          : msg('component.storage.needWrite'),
    },
  )
}

/**
 * 给一个组件造存储门面。**两个权限都没有就返回 undefined** —— 组件拿到的
 * `storage` 是 undefined，于是它连"试一试"的机会都没有。
 *
 * 为什么不是"给一个一调就抛的对象"：那种情况下组件必须写一堆 try/catch 才能
 * 区分"没权限"和"真出错"，而写错了就会静默降级。undefined 让它在类型层面就得处理。
 */
export function createComponentStorage(
  options: CreateStorageOptions,
): ComponentStorage | undefined {
  const canRead = options.permissions.includes(STORAGE_READ_PERMISSION)
  const canWrite = options.permissions.includes(STORAGE_WRITE_PERMISSION)
  if (!canRead && !canWrite) return undefined

  const { backend, componentId } = options
  /** 每个键一条队列：并发 `update` 同一键时按顺序执行 */
  const queues = new Map<string, Promise<unknown>>()

  function assertRead(): void {
    if (!canRead) throw denied(componentId, STORAGE_READ_PERMISSION)
  }
  function assertWrite(): void {
    if (!canWrite) throw denied(componentId, STORAGE_WRITE_PERMISSION)
  }

  return {
    async get(key) {
      assertRead()
      return backend.read(key)
    },

    async keys(prefix) {
      assertRead()
      return backend.keys(prefix === undefined || prefix === '' ? null : prefix)
    },

    async set(key, value) {
      assertWrite()
      backend.write(key, value)
    },

    async delete(key) {
      assertWrite()
      return backend.remove(key)
    },

    async update(key, fn) {
      assertWrite()
      // 读改写要读，所以顺带要求读权限 —— 只给 db:write 的组件做不了这件事，
      // 与其让它拿到 undefined 再猜，不如在这里说清楚
      assertRead()
      const previous = queues.get(key) ?? Promise.resolve()
      const next = previous.then(() => {
        const value = fn(backend.read(key))
        backend.write(key, value)
        return value
      })
      // 队列只用于排序：失败的 promise 不该把后续调用一起带崩
      const tail = next.catch(() => undefined)
      queues.set(key, tail)
      try {
        return await next
      } finally {
        // 队列跑完就清掉，否则键一多就是一条不释放的引用链
        if (queues.get(key) === tail) queues.delete(key)
      }
    },
  }
}
