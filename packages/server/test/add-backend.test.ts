/**
 * 「给已有应用加后端」的端到端（进程内）验收。
 *
 * 为什么值得单独一个文件：这条能力的风险全在**改动已存在的代码**上 ——
 * 用户那个应用的 package.json 里可能已经有他定制过的 build、有 `"type": "module"`、
 * 有他自己的 eslint 配置。加后端必须只"补"，不能"重写"。
 *
 * 同时验证工具与 RPC 走的是**同一条**路径（`applyApiFeature`）：
 * 两条路各写一份是本项目已经踩过的坑（组装声明 / 组件安装都各错过一次）。
 */
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackendTools, ADD_BACKEND_TOOL } from '@tenon/agent'
import { startServer, type RunningServer } from '../src/index.js'
import { appPaths } from '@tenon/core'

let dir: string
let running: RunningServer | undefined

async function rpc<T>(
  server: RunningServer,
  method: string,
  input: unknown = {},
): Promise<{ status: number; body: { ok: boolean; data?: T; error?: { code: string; message: string } } }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(input),
  })
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-addbackend-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type ToolText = { output: Array<{ type: string; text: string }> }

interface AddBackendResult {
  applied: boolean
  reason?: string
  files: string[]
  addedScripts: string[]
  addedDependencies: string[]
  notes: string[]
  deps: { installed: boolean } | null
}

describe('app.addBackend', () => {
  it('给已有的 react-vite 应用加后端：写文件、写 tenon.api、不覆盖用户的改动', async () => {
    running = await startServer({
      port: 0,
      token: 'test-token',
      env: { TENON_HOME: dir, TENON_FAUX: '1' },
      // 这条用例只验文件搬运，装依赖（要联网下 NestJS）在这里没有意义
      preview: { installDeps: false },
    })

    const created = await rpc<{ app: { id: string } }>(running, 'app.create', {
      name: '账单',
      templateId: 'react-vite',
      styleId: null,
    })
    expect(created.body.ok).toBe(true)
    const appId = created.body.data!.app.id
    const repoDir = appPaths(running.core.home, appId).repoDir

    // 用户改过一个脚本：加后端**不能**把它冲掉
    const pkgPath = join(repoDir, 'package.json')
    const before = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
    const scripts = before['scripts'] as Record<string, string>
    scripts['build'] = 'vite build --mode mine'
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(pkgPath, JSON.stringify(before, null, 2), 'utf8'),
    )

    const added = await rpc<AddBackendResult>(running, 'app.addBackend', {
      id: appId,
      installDeps: false,
    })
    expect(added.body.ok, added.body.error?.message).toBe(true)
    const result = added.body.data!
    expect(result.applied).toBe(true)
    expect(result.files).toContain('api/main.ts')
    expect(result.addedScripts).toContain('build:api')

    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
    expect((pkg['scripts'] as Record<string, string>)['build']).toBe('vite build --mode mine')
    // ★ 平台靠这个字段决定起不起后端；漏了就是"加了后端但 /api 永远 502"
    expect((pkg['tenon'] as Record<string, string>).api).toBe('api/main.ts')

    // 网关真的要认它（不看声明，看它的解析函数）
    const { resolveApiEntry } = await import('@tenon/gateway')
    expect(resolveApiEntry(repoDir)?.source).toBe('api/main.ts')

    // 后端自己那半边也能被 tsc 编译：tsconfig 存在且 include 了 api/shared
    const serverTsconfig = await readFile(join(repoDir, 'tsconfig.server.json'), 'utf8')
    expect(serverTsconfig).toContain('"api"')
    expect(serverTsconfig).toContain('"shared"')
  })

  it('幂等：第二次调用什么都不改（不产生空 commit）', async () => {
    running = await startServer({
      port: 0,
      token: 'test-token',
      env: { TENON_HOME: dir, TENON_FAUX: '1' },
      preview: { installDeps: false },
    })
    const created = await rpc<{ app: { id: string } }>(running, 'app.create', {
      name: '记账',
      templateId: 'react-vite',
      styleId: null,
    })
    const appId = created.body.data!.app.id

    const first = await rpc<AddBackendResult>(running, 'app.addBackend', { id: appId, installDeps: false })
    expect(first.body.data!.applied).toBe(true)

    const second = await rpc<AddBackendResult>(running, 'app.addBackend', { id: appId, installDeps: false })
    expect(second.body.data!.applied).toBe(false)
    expect(second.body.data!.reason).toBe('already')
    expect(second.body.data!.files).toEqual([])
  })

  it('不存在的应用 → APP_NOT_FOUND（不是 500）', async () => {
    running = await startServer({
      port: 0,
      token: 'test-token',
      env: { TENON_HOME: dir, TENON_FAUX: '1' },
      preview: { installDeps: false },
    })
    const missing = await rpc(running, 'app.addBackend', { id: 'app_nope', installDeps: false })
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('APP_NOT_FOUND')
  })
})

describe('add_backend 工具', () => {
  it('工具与 RPC 走同一条路径：加完之后再说一次就是"已经有后端了"', async () => {
    running = await startServer({
      port: 0,
      token: 'test-token',
      env: { TENON_HOME: dir, TENON_FAUX: '1' },
      preview: { installDeps: false },
    })
    const created = await rpc<{ app: { id: string } }>(running, 'app.create', {
      name: '清单',
      templateId: 'react-vite',
      styleId: null,
    })
    const appId = created.body.data!.app.id
    const repoDir = appPaths(running.core.home, appId).repoDir

    let handedOff = false
    const tools = createBackendTools({
      appId,
      repoDir,
      onApplied: () => {
        handedOff = true
      },
    })
    const tool = tools.find((item) => item.name === ADD_BACKEND_TOOL)
    expect(tool).toBeDefined()

    /*
     * `execute` 的类型签名带环境参数（工具运行上下文），而这里只想验"动作本身"——
     * 与 components 那组测试同一写法：断言成只吃一个参数的函数。
     */
    const readText = (result: ToolText): string => result.output.map((part) => part.text).join('')
    const execute = tool!.execute as unknown as (input: unknown) => Promise<ToolText>

    const text = readText(await execute({ reason: '要存报销单' }))
    expect(text).toContain('Added a backend to this app')
    expect(text).toContain('要存报销单')
    // 装依赖 + 重启由宿主接手（不给的话模型下一步会看到一堆"找不到 @nestjs/core"）
    expect(handedOff).toBe(true)

    expect(readText(await execute({}))).toContain('already has a backend')
  })
})
