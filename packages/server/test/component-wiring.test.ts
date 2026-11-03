/**
 * 「工具真的进到会话里了吗」—— 一条只能靠**穿过整条装配链**才能验的用例。
 *
 * 起因（真模型验收时撞到的）：`install_component` 从 M5 第 4 步就写好了、测试也过了，
 * 但真实运行时里模型一调就回 `Tool install_component is not available`。
 * 原因是中间少了一跳：`AgentRuntimeOptions.components` 声明了、server 也传了、
 * `HarnessPool` 也用得上，**却没从 createAgentRuntime 传进 HarnessPool**。
 *
 * 为什么原有测试抓不到：`component-uninstall.test.ts` 直接构造 `HarnessPool`（或走
 * 带 components 的夹具），跳过了"server → runtime → pool"这段；类型检查也抓不到，
 * 因为两侧的类型都对，只是没连起来。
 *
 * 所以这条用例刻意**从 server 起步**，只问一件事：主会话的工具清单里有没有它们。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, rpc } from './support.js'

let dir: string | undefined
let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('组件工具的装配链', () => {
  it('server 起起来之后，主会话真的拿得到 install / remove / list', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-wiring-'))
    const server = await boot(dir, {
      // 测试机上真实的 plugins/bundled（有则用，没有也可以 —— 这里只验"工具挂没挂上"）
      pluginRoots: [{ kind: 'bundled', dir: join(process.cwd(), 'plugins', 'bundled') }],
    })
    close = () => server.close()

    const created = await rpc<{ app: { id: string } }>(server, 'app.create', { name: '装配链' })
    const session = await server.agent.pool?.acquire(created.app.id)
    expect(session).toBeDefined()

    const names = session!.rootTools.map((tool) => tool.name)
    expect(names).toContain('install_component')
    expect(names).toContain('remove_component')
    expect(names).toContain('list_components')
  })

  it('装了组件工具也不会把子角色的工具漏给主角色（分工没被顺手带乱）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-wiring-none-'))
    const server = await boot(dir, { pluginRoots: [] })
    close = () => server.close()

    const created = await rpc<{ app: { id: string } }>(server, 'app.create', { name: '没有组件' })
    const session = await server.agent.pool?.acquire(created.app.id)
    const names = session!.rootTools.map((tool) => tool.name)
    /*
     * 组件工具是"加法"，容易顺手把别的也加进来。主角色拿的必须是**显式列举**的那份：
     * 页面的 `preview_*`、评审的 `git_diff` / `typecheck` 都只该在子角色手里
     * （否则"自己改的自己审"这道关就形同虚设）。
     */
    expect(names).toContain('install_component')
    expect(names).not.toContain('preview_click')
    expect(names).not.toContain('git_diff')
    expect(names).not.toContain('typecheck')
  })

  it('子角色拿不到安装工具（装组件是设计决策，不该派出去）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-wiring-sub-'))
    const server = await boot(dir, {
      pluginRoots: [{ kind: 'bundled', dir: join(process.cwd(), 'plugins', 'bundled') }],
    })
    close = () => server.close()

    const created = await rpc<{ app: { id: string } }>(server, 'app.create', { name: '子角色' })
    const session = await server.agent.pool?.acquire(created.app.id)
    // `tools` 是会话里全部可用工具（含子角色白名单能挑的），`rootTools` 才是主角色那份
    const rootNames = session!.rootTools.map((tool) => tool.name)
    const subagent = session!.rootTools.find((tool) => tool.name === 'subagent')
    expect(subagent).toBeDefined()
    expect(rootNames).toContain('install_component')
  })
})
