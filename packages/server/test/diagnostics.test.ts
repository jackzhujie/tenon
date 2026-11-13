/**
 * 诊断报告：**发给作者的那份东西里到底有什么。**
 *
 * 这组测试的重点不是"报告好不好看"，是"不该出现的字有没有出现"：
 * 家目录、邮箱、密钥、连接串。它们一旦漏出去，报告看起来完全正常 ——
 * 用户不会知道自己把项目名发了出去。
 *
 * 所以每条断言都写成「原文一定不在报告里」，而不是「报告里有 `<home>`」：
 * 前者在实现换了占位符之后仍然成立。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCore, type CoreServices } from '@tenon/core'
import type { LogEntry } from '@tenon/protocol'
import { buildDiagnostics, DIAGNOSTICS_FORMAT } from '../src/diagnostics.js'
import { boot, rpc } from './support.js'
import type { RunningServer } from '../src/index.js'

let dir: string
let core: CoreServices
let running: RunningServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-diag-'))
  core = openCore({ inMemoryDb: true, env: { TENON_HOME: join(dir, 'home') } })
})

afterEach(async () => {
  await running?.close()
  running = undefined
  core.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 'l-1',
    appId: 'ap-1',
    at: Date.parse('2026-11-13T14:02:11.000Z'),
    source: 'api',
    level: 'error',
    message: 'boom',
    detail: null,
    repeat: 1,
    ...overrides,
  }
}

function report(entries: readonly LogEntry[], appId?: string): ReturnType<typeof buildDiagnostics> {
  return buildDiagnostics({ version: '1.2.3-test', core, appId, entries })
}

describe('诊断报告', () => {
  it('带环境信息：版本、平台、node、语言、格式号', () => {
    const { text, format } = report([])
    expect(format).toBe(DIAGNOSTICS_FORMAT)
    expect(text).toContain('version:  1.2.3-test')
    expect(text).toContain(`platform: ${process.platform} ${process.arch}`)
    expect(text).toContain(`node:     ${process.versions.node}`)
    expect(text).toContain('locale:')
    // 没有日志时也要有一句，别让人以为报告生成失败了
    expect(text).toContain('(nothing logged)')
  })

  it('家目录不出现在报告里（用户名是最容易漏的那一项）', () => {
    const home = homedir()
    const { text, redactions } = report([entry({ message: `cannot open ${home}/project/a.ts` })])
    expect(text).not.toContain(home)
    expect(text).toContain('<home>')
    expect(redactions).toBeGreaterThan(0)
  })

  it('邮箱、模型密钥、数据库连接串都不出现', () => {
    const { text } = report([
      entry({
        message: 'notify jack@example.com failed, key sk-abcdefghijklmnopqrstuvwx',
        detail: 'DATABASE_URL=postgres://app:hunter2@127.0.0.1:5432/tenon\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc',
      }),
    ])
    expect(text).not.toContain('jack@example.com')
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('应用目录整段换成 <app>（应用名本身就是业务信息）', () => {
    const repo = join(core.home.root, 'apps', 'ap-1', 'repo')
    const { text } = report([entry({ message: `typecheck failed at ${repo}/src/a.ts:3` })], 'ap-1')
    expect(text).not.toContain(repo)
    expect(text).toContain('<app>/src/a.ts:3')
  })

  it('堆栈只带前 12 行，单行超长会截断 —— 报告不能撑爆聊天窗口', () => {
    const detail = Array.from({ length: 30 }, (_, i) => `    at frame${i}`).join('\n')
    const { text } = report([entry({ detail })])
    expect(text).toContain('at frame0')
    expect(text).toContain('at frame11')
    expect(text).not.toContain('at frame12')

    const long = report([entry({ message: 'x'.repeat(900) })]).text
    expect(long).not.toContain('x'.repeat(401))
  })

  it('RPC 接线：diagnostics.report 能拿到一份完整报告', async () => {
    running = await boot(dir)
    const result = await rpc<{ text: string; redactions: number; format: string }>(
      running,
      'diagnostics.report',
    )
    expect(result.format).toBe(DIAGNOSTICS_FORMAT)
    expect(result.redactions).toBe(0)
    expect(result.text).toContain('Tenon diagnostics')
    // 不传 appId 是合法调用：只发环境信息，日志段为空
    expect(result.text).toContain('(nothing logged)')
  })
})
