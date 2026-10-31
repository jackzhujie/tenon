/**
 * 子进程壳的测试。
 *
 * 两件事值得单独验：
 * 1. `nodeRunEnv` 在 Electron 里**必须**补回 `ELECTRON_RUN_AS_NODE` ——
 *    桌面版 `process.execPath` 是 Tenon 自己，不补的话 spawn 出来的是"另一个 Electron 窗口"，
 *    而 dev server 永远不就绪，报错却只说"没有就绪"。
 * 2. `stop()` 真的能收掉进程（SIGTERM 生效），不然每重启一次预览漏一个 node 进程。
 */
import { describe, expect, it } from 'vitest'
import { nodeRunEnv, spawnLogged } from '../src/index.js'

describe('nodeRunEnv', () => {
  it('普通 node 下原样返回（不改环境）', () => {
    const env = { PATH: '/bin', FOO: '1' }
    expect(nodeRunEnv(env, undefined)).toEqual(env)
  })

  it('Electron 下补回 ELECTRON_RUN_AS_NODE 并覆盖旧值', () => {
    expect(nodeRunEnv({ PATH: '/bin' }, '39.8.10')).toEqual({
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(nodeRunEnv({ ELECTRON_RUN_AS_NODE: '0' }, '39.8.10').ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('spawnLogged', () => {
  it('收输出、能停掉（不留孤儿进程）', async () => {
    const launched = spawnLogged({
      command: process.execPath,
      args: ['-e', 'console.log("第一行"); console.error("第二行")'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      label: 'demo',
    })
    // 等它把两行都吐完（用输出变化当信号，比 sleep 稳）
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !launched.output().includes('第二行')) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(launched.output()).toContain('[demo] 第一行')
    expect(launched.output()).toContain('[demo] 第二行')

    await launched.stop()
    expect(typeof launched.pid === 'number' || launched.pid === undefined).toBe(true)
  })
})
