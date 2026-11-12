/**
 * 服务端说哪种话（i18n 第二半）。
 *
 * 界面文案跟着浏览器走，这件事网页自己就能验；但**错误消息、门禁结论是服务端生成的**，
 * 它们只认 `settings` 里的 `ui.locale`。这一组要钉的就是那条链路：
 *
 * 1. 默认说英文（国际化产品的默认值不该是中文）
 * 2. `settings.set` 之后，**同一个错误**换一种语言（不是前端翻译，是服务端重新生成）
 * 3. 重启服务仍然记得（真相在设置里，不在进程内存里）
 *
 * 为什么不用纯函数测：`msg()` 单独调当然对，但"设置改了之后抛出点真的会说新语言"
 * 靠的是 `startServer` 读一次 + `settings.set` 更新一次这两个接线点 —— 纯函数一个都验不到。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLocale } from '@tenon/protocol'
import { boot, rpc, TEST_TOKEN } from './support.js'
import type { RunningServer } from '../src/index.js'

let dir: string
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-locale-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** 打一个必然失败的方法，把 `{ code, message }` 拿回来（`rpc` 会抛，这里要的是那条消息） */
async function failingCall(
  server: RunningServer,
  method: string,
  input: unknown = {},
): Promise<{ code?: string; message?: string }> {
  const response = await fetch(`${server.url}/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as { ok: boolean; error?: { code?: string; message?: string } }
  expect(body.ok).toBe(false)
  return body.error ?? {}
}

describe('服务端说的语言', () => {
  it('没设过语言时说英文（不是中文）', async () => {
    running = await boot(dir, { locale: 'en' })
    const error = await failingCall(running, 'app.get', { id: 'nope' })
    expect(error.code).toBe('APP_NOT_FOUND')
    expect(error.message).toBe('No such app: nope')
  })

  it('设成中文之后，同一个错误换一种语言（服务端重新生成，不是前端翻译）', async () => {
    running = await boot(dir, { locale: 'en' })
    expect((await failingCall(running, 'app.get', { id: 'nope' })).message).toBe('No such app: nope')

    await rpc(running, 'settings.set', { values: { 'ui.locale': 'zh' } })

    expect(getLocale()).toBe('zh')
    const error = await failingCall(running, 'app.get', { id: 'nope' })
    expect(error.message).toBe('应用不存在：nope')
    // code 是契约，不跟着语言变 —— 前端按它分支
    expect(error.code).toBe('APP_NOT_FOUND')
  })

  it('重启之后仍然记得（真相在设置里，不在进程内存里）', async () => {
    running = await boot(dir, { locale: 'en' })
    await rpc(running, 'settings.set', { values: { 'ui.locale': 'zh' } })
    await running.close()
    running = undefined

    // 这次**故意不传 locale**：新进程必须自己从设置里读出来
    running = await boot(dir)
    expect(getLocale()).toBe('zh')
    expect((await failingCall(running, 'app.get', { id: 'nope' })).message).toBe('应用不存在：nope')
  })

  it('设置里写了个坏值时不被带坏：保持在用英文', async () => {
    running = await boot(dir, { locale: 'en' })
    await rpc(running, 'settings.set', { values: { 'ui.locale': 'klingon' } })
    expect(getLocale()).toBe('en')
    expect((await failingCall(running, 'app.get', { id: 'nope' })).message).toBe('No such app: nope')
  })
})
