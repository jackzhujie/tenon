/**
 * 导出产物里那四个**生成**文件（`serve.mjs` / `start.sh` / `.env.example` / `README.md`）。
 *
 * 为什么单独测"生成出来的文本"：这四个文件是模板字符串拼出来的，而模板字符串里写
 * 代码最容易犯的错是**转义**（`\.` 变成 `.`、`$` 被当成插值、反引号提前收尾），
 * 症状是产物里的 JS 语法错 —— 而那时用户已经在服务器上了。
 *
 * 所以 `serve.mjs` 的两种变体都要过一遍 `node --check`：这是唯一能证明
 * "生成出来的东西是合法 JS"的断言，靠读代码看不出来。
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderEnvExample, renderReadme, renderServe, renderStart } from '../src/export.js'

/** 把生成的文本写盘再让 node 自己检查语法（比任何正则断言都可靠） */
async function checkJs(source: string): Promise<{ ok: boolean; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-export-check-'))
  try {
    const file = join(dir, 'serve.mjs')
    await writeFile(file, source, 'utf8')
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    return { ok: result.status === 0, stderr: result.stderr ?? '' }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('serve.mjs（单端口启动器）', () => {
  it('有后端时生成的是合法 JS，且真的把 /api 转给后端子进程', async () => {
    const source = renderServe({ hasApi: true })
    const syntax = await checkJs(source)
    expect(syntax.ok, syntax.stderr).toBe(true)
    expect(source).toContain('const HAS_API = true')
    expect(source).toContain("url.startsWith('/api/')")
    expect(source).toContain("join(here, 'dist-server', 'api', 'main.js')")
    // 后端端口由启动器算出来传下去，不该让用户手动配两个口
    expect(source).toContain('API_PORT')
  })

  it('没有后端时也合法，而且**不会**去 spawn 一个不存在的入口', async () => {
    const source = renderServe({ hasApi: false })
    const syntax = await checkJs(source)
    expect(syntax.ok, syntax.stderr).toBe(true)
    expect(source).toContain('const HAS_API = false')
    // 关键：没有后端就不该起子进程（否则每次启动都报"找不到文件"）
    expect(source).toContain('if (HAS_API) {')
    expect(source).toContain('api = spawn')
  })

  it('路径穿越被挡住（产物也是要上公网的）', () => {
    const source = renderServe({ hasApi: true })
    expect(source).toContain('normalize')
    expect(source).toContain('file.startsWith(CLIENT_DIR)')
  })

  it('找不到文件时回 index.html（前端路由靠它）', () => {
    const source = renderServe({ hasApi: true })
    expect(source).toContain("join(CLIENT_DIR, 'index.html')")
  })
})

describe('start.sh', () => {
  it('缺 DATABASE_URL 时先拦住，并给出可复制的例子', () => {
    const source = renderStart({ hasApi: true })
    expect(source).toContain('DATABASE_URL')
    expect(source).toContain('exit 1')
    // 这句是产物 README 与报错的共同语言：应用只认一个连接串
    expect(source).toContain('export DATABASE_URL=postgres://')
    expect(source).toContain('exec node serve.mjs')
  })

  it('没有后端的应用会在脚本里说明"这个变量用不上"', () => {
    const source = renderStart({ hasApi: false })
    expect(source).toContain('没有后端')
  })
})

describe('.env.example / README.md', () => {
  it('.env.example 只暴露应用真的会读的变量', () => {
    const source = renderEnvExample({ hasApi: true })
    expect(source).toContain('DATABASE_URL=')
    expect(source).toContain('PORT=3000')
    // 没有 pool.max 的环境判断语义 —— 它是容量参数，注释里说清
    expect(source).toContain('并发容量参数')
  })

  it('README 必须写清产物里**没有**什么（数据库与组件）', () => {
    const source = renderReadme({ appName: '测试应用', appId: 'app_x', hasApi: true, hasLock: true })
    expect(source).toContain('# 测试应用')
    // 这两句是"用户拿走后最容易被误解"的地方
    expect(source).toContain('没有数据库')
    expect(source).toContain('没有组件')
    expect(source).toContain('pnpm install --prod --frozen-lockfile')
  })

  it('没有 lock 文件时不说"可复现"', () => {
    const source = renderReadme({ appName: 'x', appId: 'app_x', hasApi: false, hasLock: false })
    expect(source).toContain('版本可能浮动')
    expect(source).not.toContain('--frozen-lockfile`')
  })
})
