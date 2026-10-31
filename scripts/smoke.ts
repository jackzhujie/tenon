/**
 * 端到端冒烟：**真的 spawn `bin.ts`**，只用 HTTP 走一遍 M1 主干。
 *
 * 与 vitest 的分工：单测直连（in-process），这里验证进程边界上的那些约定 ——
 * `TENON_READY` 行、随机端口、Bearer Token、SSE 长连接、SIGTERM 收尾。
 *
 *   pnpm smoke
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SseEvent } from '@tenon/protocol'

const ROOT = new URL('..', import.meta.url).pathname
const facts: Array<{ name: string; ok: boolean; detail: string }> = []

function fact(name: string, ok: boolean, detail: string): void {
  facts.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`)
}

interface ReadyInfo {
  url: string
  port: number
  token: string
  home: string
  model: { mode: string; modelId: string } | null
}

function waitReady(child: ReturnType<typeof spawn>, timeoutMs = 25_000): Promise<ReadyInfo> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('TENON_READY '))
      if (line === undefined) return
      clearInterval(timer)
      clearTimeout(deadline)
      resolve(JSON.parse(line.slice('TENON_READY '.length)) as ReadyInfo)
      void stderr
    }, 40)
    const deadline = setTimeout(() => {
      clearInterval(timer)
      reject(new Error(`等服务就绪超时。stdout=${stdout} stderr=${stderr}`))
    }, timeoutMs)
  })
}

/** 带头部与超时的 fetch，避免某个环节静默挂住整条冒烟 */
async function httpJson(url: string, init: RequestInit, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'tenon-smoke-'))
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'packages/server/src/bin.ts')], {
    cwd: ROOT,
    env: { ...process.env, TENON_HOME: home, TENON_FAUX: '1', TENON_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    const ready = await waitReady(child)
    fact('TENON_READY 可解析', ready.port > 0 && ready.token.length > 16, JSON.stringify(ready.model))

    const health = await httpJson(`${ready.url}/api/health`, {})
    fact('健康检查免 Token', health.ok === true, `model=${health.data.model?.mode ?? 'null'}`)

    const auth = { 'content-type': 'application/json', authorization: `Bearer ${ready.token}` }
    const unauthorized = await fetch(`${ready.url}/rpc/app.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    fact('无 Token 被拒', unauthorized.status === 401, `status=${unauthorized.status}`)

    const created = await httpJson(`${ready.url}/rpc/app.create`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '冒烟应用' }),
    })
    const appId = created.data?.app?.id as string | undefined
    fact('建应用（含 git init）', typeof appId === 'string', `appId=${appId}`)
    if (appId === undefined) throw new Error('没拿到 appId')

    // 先连上 SSE 再提交 —— 顺序反了会丢掉开头的增量
    const sseController = new AbortController()
    const sse = await fetch(`${ready.url}/events?appId=${appId}`, {
      headers: { authorization: `Bearer ${ready.token}` },
      signal: sseController.signal,
    })
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    const events: SseEvent[] = []
    let buffer = ''
    await reader.read() // `: connected`

    await httpJson(`${ready.url}/rpc/chat.submit`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ appId, content: '做一个待办清单应用', requestId: 'smoke-1' }),
    })

    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && !events.some((event) => event.type === 'message.end')) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 1000),
        ),
      ])
      if (next.done === true) continue
      buffer += decoder.decode(next.value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine !== undefined) events.push(JSON.parse(dataLine.slice(6)) as SseEvent)
      }
    }
    sseController.abort()

    const deltas = events.filter((event) => event.type === 'message.delta')
    const text = deltas.map((event) => (event.type === 'message.delta' ? event.text : '')).join('')
    fact('SSE 收到流式增量', deltas.length > 0 && text.length > 10, `${deltas.length} 帧 / ${text.length} 字`)
    fact(
      '收到 assistant 的 message.end',
      events.some((event) => event.type === 'message.end'),
      `共有事件：${[...new Set(events.map((event) => event.type))].join(',')}`,
    )

    const history = await httpJson(`${ready.url}/rpc/chat.history`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ appId }),
    })
    const roles = (history.data?.messages ?? []).map((message: { role: string }) => message.role)
    fact('历史为 user → assistant', roles.join('→') === 'user→assistant', roles.join('→'))

    const log = await httpJson(`${ready.url}/rpc/git.log`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ appId }),
    })
    fact(
      'git 有初始化 commit',
      (log.data?.commits ?? []).length === 1,
      `${(log.data?.commits ?? []).length} 个：${log.data?.commits?.[0]?.message?.split('\n')[0] ?? '-'}`,
    )

    const tree = await httpJson(`${ready.url}/rpc/files.tree`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ appId }),
    })
    fact(
      '工作区可浏览',
      (tree.data?.nodes ?? []).length > 0,
      (tree.data?.nodes ?? []).map((node: { path: string }) => node.path).slice(0, 4).join(','),
    )
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await rm(home, { recursive: true, force: true })
  }

  const failed = facts.filter((item) => !item.ok)
  console.log(`\n合计 ${facts.length} 项，通过 ${facts.length - failed.length}，失败 ${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error('冒烟失败：', err)
  process.exitCode = 1
})
