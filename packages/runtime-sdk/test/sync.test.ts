/**
 * 漂移闸门：模板里的副本必须与 `@tenon/runtime` 的源码**逐字节一致**。
 *
 * 为什么需要它：生成应用不能 import 这个包（没发布 npm、导出成 Docker 也要能装），
 * 所以副本是逃不掉的。但"两份代码"最容易演变成"改了一份忘了另一份"，
 * 然后在用户的应用里表现为"这个修好的 bug 又回来了"。
 *
 * 改完源码跑：`node packages/runtime-sdk/scripts/sync-templates.mjs`
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sdkDir = join(here, '..')
const templatesDir = join(sdkDir, '..', 'generator', 'templates')

/** [源码, 模板副本（相对 templates/）] —— 与 scripts/sync-templates.mjs 的 SYNC_MAP 一致 */
const PAIRS: Array<[string, string]> = [
  ['src/browser/tenon-log.ts', 'react-vite/src/tenon-log.ts'],
  ['src/browser/tenon-log.ts', 'nest-api/src/tenon-log.ts'],
  ['src/browser/tenon-boundary.tsx', 'react-vite/src/tenon-boundary.tsx'],
  ['src/browser/tenon-boundary.tsx', 'nest-api/src/tenon-boundary.tsx'],
  ['src/vite/tenon-loc.ts', 'react-vite/src/tenon-loc-plugin.ts'],
  ['src/vite/tenon-loc.ts', 'nest-api/src/tenon-loc-plugin.ts'],
  ['src/browser/tenon-loc.ts', 'react-vite/src/tenon-loc.ts'],
  ['src/browser/tenon-loc.ts', 'nest-api/src/tenon-loc.ts'],
  ['src/nest/tenon-logger.ts', 'nest-api/api/tenon-logger.ts'],
]

describe('模板副本与 @tenon/runtime 同步', () => {
  for (const [source, target] of PAIRS) {
    it(`${target} 与 ${source} 一致`, () => {
      const expected = readFileSync(join(sdkDir, source), 'utf8')
      const actual = readFileSync(join(templatesDir, target), 'utf8')
      expect(
        actual,
        `${target} 与 ${source} 不一致 —— 跑 node packages/runtime-sdk/scripts/sync-templates.mjs`,
      ).toBe(expected)
    })
  }

  it('同步表里的每个源文件都存在（防止改名后测试静默变弱）', () => {
    for (const [source] of PAIRS) {
      expect(() => readFileSync(join(sdkDir, source), 'utf8')).not.toThrow()
    }
  })
})
