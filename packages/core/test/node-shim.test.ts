/**
 * `node` 薄壳的测试。
 *
 * 它修的是一个**只在打包版出现**的故障：应用自己的 `node_modules/.bin/*` 是
 * `exec node` 的 shim，而打包版的机器上没有 Node（Electron 二进制兼任 Node）。
 * 表现是发布门禁报 `exec: node: not found`、导出静态包/Docker 报 `pnpm run build 退出码 1`。
 *
 * 这里能验的是"薄壳本身能用"；"打包版里真的走了它"由 `scripts/e2e-packaged-gate.ts` 验
 * （用 Electron 二进制跑 dist/server/server.mjs）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeShimDir, withNodeShim } from '../src/node-shim.js'

describe('node shim', () => {
  it('不在 Electron 里 → null（开发态 node 本来就在 PATH 上，不该覆盖它）', () => {
    // vitest 跑在 node 里，所以这里必然是 null
    expect(nodeShimDir()).toBeNull()
  })

  it('建出来的薄壳**真的能当 node 用**', () => {
    const dir = nodeShimDir({ force: true })
    expect(dir).not.toBeNull()
    const file = join(dir!, process.platform === 'win32' ? 'node.cmd' : 'node')
    expect(existsSync(file)).toBe(true)

    // 直接执行它：这是薄壳存在的唯一意义
    const out = execFileSync(file, ['-p', 'process.version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    expect(out.trim()).toMatch(/^v\d+\./)
  })

  it('withNodeShim 把薄壳目录放在 PATH **最前面**（否则会被真的 node 抢走）', () => {
    const dir = nodeShimDir({ force: true })!
    const env = withNodeShim({ PATH: '/usr/bin:/bin' }, { force: true })
    expect(env['PATH']).toBe(`${dir}${process.platform === 'win32' ? ';' : ':'}/usr/bin:/bin`)
  })

  it('PATH 原本为空 → 只有薄壳目录（不是以分隔符开头）', () => {
    const dir = nodeShimDir({ force: true })!
    expect(withNodeShim({ PATH: '' }, { force: true })['PATH']).toBe(dir)
  })

  it('不动其它环境变量', () => {
    const env = withNodeShim({ PATH: '/bin', HOME: '/tmp/x', CI: '1' }, { force: true })
    expect(env['HOME']).toBe('/tmp/x')
    expect(env['CI']).toBe('1')
  })
})
