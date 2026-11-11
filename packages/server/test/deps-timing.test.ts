/**
 * 依赖什么时候装（M5.5 第三件）。
 *
 * 之前只有 `preview.start` 才装依赖，于是 Agent 在第一轮对话里跑 `tsc` 时看到的是
 * 一屋子 `TS2688 Cannot find type definition file for 'node'` —— 它会开始"修"一个
 * 根本不存在的类型错误。真模型验收时实测：为此白烧好几轮。
 *
 * 现在：**建应用就开始装**（不阻塞返回），**第一次提交前等它**（通常这时已经装完）。
 *
 * 三条要钉住的：
 * 1. 建完就会去装（不是等用户点预览）
 * 2. 装失败**不阻断**建应用与对话 —— 写代码不需要 node_modules
 * 3. `installDeps: false` 时不装（测试环境不该联网）
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, openSse, rpc } from './support.js'
import type { RunningServer } from '../src/index.js'

let dir: string | undefined
let running: RunningServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  /*
   * `maxRetries`：`close()` 之后还有一个短命的异步写（这一轮的 git 收尾）在落盘，
   * 把目录腾空的瞬间它会再写回来 —— macOS 的 APFS 上于是撞成
   * `ENOTEMPTY: directory not empty`（`rm` 删完再 rmdir 时目录又非空了）。
   * 本机快盘上几十次才见一次，正好在 920 项全量跑里撞上了。
   */
  if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dir = undefined
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等不到')
    await sleep(20)
  }
}

describe('依赖安装的时机', () => {
  it('建应用就开始装，不等用户点预览', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-deps-'))
    const calls: string[] = []
    running = await boot(dir, {
      preview: {
        depsInstaller: async (options) => {
          calls.push(options.repoDir)
          return { installed: true, command: 'fake install', durationMs: 1 }
        },
      },
    })

    expect(calls).toHaveLength(0)
    await rpc<{ app: { id: string } }>(running, 'app.create', { name: '依赖' })
    await waitFor(() => calls.length === 1)
    expect(calls[0]).toContain(join('apps'))
  })

  it('装失败不挡住建应用与对话，只往日志面板推一条 warn', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-deps-fail-'))
    let attempts = 0
    running = await boot(dir, {
      preview: {
        depsInstaller: async () => {
          attempts += 1
          throw new Error('离线：装不了依赖')
        },
      },
    })

    // 建应用照常成功
    const created = await rpc<{ app: { id: string } }>(running, 'app.create', { name: '没网' })
    const appId = created.app.id
    await waitFor(() => attempts >= 1)

    // 这一轮照常能跑：写代码不需要 node_modules
    const sse = openSse(running, appId)
    await sse.connected
    running.agent.model?.script([{ text: '好，我明白了。' }])
    await rpc(running, 'chat.submit', { appId, content: '你好', requestId: 'deps-1' })
    await sse.waitFor((events) =>
      events.some((event) => event.type === 'app.log' && event.entry.level === 'warn'),
    )
    sse.close()

    // 每次提交都会再确认一次（在飞去重、结果不缓存），所以 attempts ≥ 2
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('installDeps: false 时一次都不装（测试环境不联网）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-deps-off-'))
    let calls = 0
    running = await boot(dir, {
      preview: {
        installDeps: false,
        depsInstaller: async () => {
          calls += 1
          return { installed: false, command: 'x', durationMs: 0 }
        },
      },
    })

    await rpc<{ app: { id: string } }>(running, 'app.create', { name: '不装' })
    running.agent.model?.script([{ text: '好' }])
    await rpc(running, 'chat.submit', {
      appId: (await rpc<{ apps: { id: string }[] }>(running, 'app.list', {})).apps[0]!.id,
      content: '你好',
      requestId: 'deps-off',
    })
    expect(calls).toBe(0)
  })
})
