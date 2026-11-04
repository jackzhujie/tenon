/**
 * 存储门面（M6 第 4 步）：按清单权限开门 + 读改写串行化。
 *
 * 这一层不碰数据库（后端是注入的窄接口），所以用例可以全在内存里跑。
 * 三个属性各有具体的错法：
 *
 * 1. **没权限要拿不到**（不是"拿到了但一调就失败"）—— 否则组件必须写 try/catch
 *    才能区分"没权限"和"真出错"，写错就静默降级。
 * 2. **只读的组件不能写** —— 一个 import 了但没用上的写操作，比"根本没这个能力"难查得多。
 * 3. **读改写要串行** —— 审批流那种"读列表 → 加一条 → 写回"并发跑两次，
 *    后写的会吃掉先写的，而界面上表现为"我刚提交的单子不见了"。
 */
import { describe, expect, it } from 'vitest'
import { createComponentStorage, type StorageBackend } from '../src/storage.js'

function memoryBackend(): StorageBackend & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    read: (key) => data.get(key) ?? null,
    write: (key, value) => {
      data.set(key, value)
    },
    remove: (key) => data.delete(key),
    keys: (prefix) => [...data.keys()].filter((key) => prefix === null || key.startsWith(prefix)).sort(),
  }
}

describe('存储门面', () => {
  it('清单里没有 db:* 权限 → 直接不给（不是给个一调就炸的对象）', () => {
    const storage = createComponentStorage({
      backend: memoryBackend(),
      permissions: [],
      componentId: 'test.a',
    })
    expect(storage).toBeUndefined()
  })

  it('只给 db:read → 读得到，写不了，错误里说清该加什么权限', async () => {
    const backend = memoryBackend()
    backend.data.set('k', 'v')
    const storage = createComponentStorage({
      backend,
      permissions: ['db:read'],
      componentId: 'test.a',
    })
    expect(storage).toBeDefined()
    expect(await storage!.get('k')).toBe('v')
    expect(await storage!.keys()).toEqual(['k'])

    await expect(storage!.set('k2', 'x')).rejects.toMatchObject({
      code: 'COMPONENT_PERMISSION_DENIED',
    })
    await expect(storage!.delete('k')).rejects.toMatchObject({ code: 'COMPONENT_PERMISSION_DENIED' })
    // 提示要能照着做：说的是"加 db:write"，不是"权限不足"（hint 在 details 里）
    await expect(storage!.set('k2', 'x')).rejects.toMatchObject({
      details: { hint: expect.stringContaining('db:write') },
    })
    // 被拒之后后端一点没变
    expect(backend.data.size).toBe(1)
  })

  it('只给 db:write → 写得进，读不了', async () => {
    const backend = memoryBackend()
    const storage = createComponentStorage({
      backend,
      permissions: ['db:write'],
      componentId: 'test.a',
    })
    await storage!.set('k', 'v')
    expect(backend.data.get('k')).toBe('v')
    await expect(storage!.get('k')).rejects.toMatchObject({ code: 'COMPONENT_PERMISSION_DENIED' })
  })

  it('读不到（键不存在）返回 null，不抛', async () => {
    const storage = createComponentStorage({
      backend: memoryBackend(),
      permissions: ['db:read', 'db:write'],
      componentId: 'test.a',
    })
    expect(await storage!.get('nope')).toBeNull()
    // 删不存在的键也不算错
    expect(await storage!.delete('nope')).toBe(false)
  })

  it('update 并发同一键不丢更新（读改写被串行化）', async () => {
    const storage = createComponentStorage({
      backend: memoryBackend(),
      permissions: ['db:read', 'db:write'],
      componentId: 'test.a',
    })
    await storage!.set('n', '0')
    // 十个并发 +1：不串行的话后写的会覆盖先写的，结果远小于 10
    await Promise.all(
      Array.from({ length: 10 }, () =>
        storage!.update('n', (old) => String(Number(old ?? '0') + 1)),
      ),
    )
    expect(await storage!.get('n')).toBe('10')
  })

  it('update 里抛错 → 值不变，而且后续 update 还能用（队列不被带崩）', async () => {
    const storage = createComponentStorage({
      backend: memoryBackend(),
      permissions: ['db:read', 'db:write'],
      componentId: 'test.a',
    })
    await storage!.set('n', '1')
    await expect(
      storage!.update('n', () => {
        throw new Error('业务校验没过')
      }),
    ).rejects.toThrow('业务校验没过')
    expect(await storage!.get('n')).toBe('1')

    const next = await storage!.update('n', (old) => String(Number(old ?? '0') + 1))
    expect(next).toBe('2')
  })

  it('keys 的前缀过滤原样交给后端（前缀为空 = 全部）', async () => {
    const backend = memoryBackend()
    backend.data.set('a:1', 'x')
    backend.data.set('a:2', 'y')
    backend.data.set('b:1', 'z')
    const storage = createComponentStorage({
      backend,
      permissions: ['db:read'],
      componentId: 'test.a',
    })
    expect(await storage!.keys('a:')).toEqual(['a:1', 'a:2'])
    expect(await storage!.keys('')).toEqual(['a:1', 'a:2', 'b:1'])
  })
})
