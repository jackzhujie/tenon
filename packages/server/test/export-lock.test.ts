/**
 * 导出互斥（v1.2.28）。
 *
 * 起因是用户的一次截图：**导出静态包成功、导出 Docker 失败**
 * （"构建失败 pnpm run build 退出码 1"），而那条命令我手动跑是 exit 0。
 *
 * 原因：两个导出按钮都走 `pnpm run build`，而 vite build **先清空 `dist/`** ——
 * 点得快的时候后一个把前一个的产物删掉，前一个就报"构建失败"。
 * 代码一行都没错，错的是一次跑两个。
 */
import { describe, expect, it } from 'vitest'
import { withExportLock } from '../src/export.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('导出互斥', () => {
  it('同一个仓库并发导出：第二个立刻被拒，并说清"等它跑完"', async () => {
    let release = (): void => {}
    const first = withExportLock('/repo/a', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'first'
    })

    await expect(withExportLock('/repo/a', async () => 'second')).rejects.toThrow(/正在导出/)
    release()
    await expect(first).resolves.toBe('first')
  })

  it('不同仓库互不影响（两个应用可以同时导）', async () => {
    const results = await Promise.all([
      withExportLock('/repo/x', async () => {
        await sleep(10)
        return 'x'
      }),
      withExportLock('/repo/y', async () => {
        await sleep(10)
        return 'y'
      }),
    ])
    expect(results).toEqual(['x', 'y'])
  })

  it('失败也要释放锁（否则这个应用再也导不出来）', async () => {
    await expect(
      withExportLock('/repo/b', async () => {
        throw new Error('构建炸了')
      }),
    ).rejects.toThrow('构建炸了')
    // 锁已释放：下一次能进
    await expect(withExportLock('/repo/b', async () => 'ok')).resolves.toBe('ok')
  })
})
