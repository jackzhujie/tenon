/**
 * supervisor 的测试：**不启动 Electron**，用 node 跑假 server。
 *
 * 这几条对应四种真实故障，而不是"能不能 spawn"：
 * 1. 正常就绪（`TENON_READY` 解析）
 * 2. 启动即失败（打包漏了模板 / 端口被占）→ 报错必须带上 stderr，否则用户只看到"起不来"
 * 3. 就绪之后崩溃 → 退避重启，并把**新的** url/token 交回窗口
 * 4. 一直不就绪 → 超时，不许永远转圈
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReady, startSupervisor } from '../src/supervisor.js'

async function fakeServer(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-sup-'))
  const file = join(dir, 'fake-server.mjs')
  await writeFile(file, body, 'utf8')
  return file
}

const STAY = `
const port = 4242
process.stdout.write('TENON_READY ' + JSON.stringify({
  url: 'http://127.0.0.1:' + port, port, token: 'tok-1', home: '/tmp/x',
  model: { mode: 'faux', modelId: 'faux-mini' },
}) + '\\n')
process.on('SIGTERM', () => { process.stdout.write('bye\\n'); process.exit(0) })
setInterval(() => {}, 1000)
`

describe('parseReady', () => {
  it('认得约定行', () => {
    const ready = parseReady(
      'TENON_READY {"url":"http://127.0.0.1:1","port":1,"token":"t","home":"/h","model":null}',
    )
    expect(ready?.token).toBe('t')
    expect(ready?.model).toBeNull()
  })

  it('不是约定行或 JSON 坏了就返回 null（别把普通日志当成就绪）', () => {
    expect(parseReady('[tenon] 启动中')).toBeNull()
    expect(parseReady('TENON_READY {oops')).toBeNull()
    expect(parseReady('TENON_READY {"url":1}')).toBeNull()
  })
})

describe('supervisor', () => {
  it('就绪 → 交回 url/token；stop() 走 SIGTERM 让它自己收尾', async () => {
    const logs: string[] = []
    const supervisor = startSupervisor({
      entry: await fakeServer(STAY),
      env: process.env,
      execPath: process.execPath,
      onLog: (line) => logs.push(line),
    })

    const ready = await supervisor.ready
    expect(ready.port).toBe(4242)
    expect(ready.token).toBe('tok-1')

    await supervisor.stop()
    // 收到 SIGTERM 后它自己打印了 bye 才退出 —— 证明不是被 SIGKILL 打死的
    expect(logs).toContain('bye')
  })

  it('启动即失败：错误里必须带 stderr（否则只知道"起不来"）', async () => {
    const supervisor = startSupervisor({
      entry: await fakeServer(`
        process.stderr.write('模板目录不存在：/nope/templates\\n')
        process.exit(1)
      `),
      env: process.env,
      execPath: process.execPath,
    })

    await expect(supervisor.ready).rejects.toThrow(/模板目录不存在/)
  })

  it('就绪后崩溃 → 重启，并把新地址交回窗口', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenon-sup-'))
    const marker = join(dir, 'boot-count')
    const seen: string[] = []
    const gaveUp: string[] = []

    const supervisor = startSupervisor({
      entry: await fakeServer(`
        import { existsSync, writeFileSync } from 'node:fs'
        const n = existsSync(${JSON.stringify(marker)}) ? 2 : 1
        writeFileSync(${JSON.stringify(marker)}, String(n))
        process.stdout.write('TENON_READY ' + JSON.stringify({
          url: 'http://127.0.0.1:1000', port: 1000, token: 'tok-' + n, home: '/tmp/x', model: null,
        }) + '\\n')
        setTimeout(() => process.exit(1), 60)
      `),
      env: process.env,
      execPath: process.execPath,
      maxRestarts: 1,
      restartDelayMs: 5,
      onReady: (ready) => seen.push(ready.token),
      onGaveUp: (error) => gaveUp.push(error.message),
    })

    await supervisor.ready
    // 等它崩 → 重启 → 再崩 → 放弃
    for (let i = 0; i < 100 && gaveUp.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(seen).toEqual(['tok-1', 'tok-2'])
    expect(supervisor.restarts).toBe(1)
    expect(gaveUp[0]).toContain('放弃重启')
  })

  it('一直不就绪 → 超时失败，不许永远转圈', async () => {
    const supervisor = startSupervisor({
      entry: await fakeServer('setInterval(() => {}, 1000)'),
      env: process.env,
      execPath: process.execPath,
      readyTimeoutMs: 200,
    })

    await expect(supervisor.ready).rejects.toThrow(/没等到 TENON_READY/)
    await supervisor.stop()
  })
})
