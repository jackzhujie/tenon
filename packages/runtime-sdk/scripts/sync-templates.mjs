#!/usr/bin/env node
/**
 * 把 `@tenon/runtime` 的源码同步进模板（源码分发）。
 *
 * 为什么是"拷贝"而不是"让应用依赖这个包"：
 * 生成的应用要能在任何机器上 `pnpm install`，还要能导出成 Docker 镜像；
 * `@tenon/runtime` 没有发布到 npm，做成依赖 = 换个环境就装不上（铁律 2 的反面）。
 *
 * 用法：
 *   node packages/runtime-sdk/scripts/sync-templates.mjs          # 写入
 *   node packages/runtime-sdk/scripts/sync-templates.mjs --check  # 只校验（CI / 测试用）
 *
 * 漂移由 `test/sync.test.ts` 拦住，所以改了源却忘了同步会直接测试失败。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sdkDir = dirname(here)
const templatesDir = join(dirname(sdkDir), 'generator', 'templates')

/** 源文件 → 目标（相对仓库根） */
export const SYNC_MAP = [
  ['src/browser/tenon-log.ts', 'react-vite/src/tenon-log.ts'],
  ['src/browser/tenon-log.ts', 'nest-api/src/tenon-log.ts'],
  ['src/browser/tenon-boundary.tsx', 'react-vite/src/tenon-boundary.tsx'],
  ['src/browser/tenon-boundary.tsx', 'nest-api/src/tenon-boundary.tsx'],
  ['src/nest/tenon-logger.ts', 'nest-api/api/tenon-logger.ts'],
]

const check = process.argv.includes('--check')
const drifted = []

for (const [from, to] of SYNC_MAP) {
  const source = join(sdkDir, from)
  const target = join(templatesDir, to)
  const expected = readFileSync(source, 'utf8')

  if (!existsSync(target) || readFileSync(target, 'utf8') !== expected) {
    drifted.push(relative(join(sdkDir, '../..'), target))
    if (!check) writeFileSync(target, expected)
  }
}

if (check && drifted.length > 0) {
  console.error(
    `模板副本与 @tenon/runtime 不一致（${drifted.length} 个）：\n` +
      drifted.map((file) => `  - ${file}`).join('\n') +
      '\n跑 `node packages/runtime-sdk/scripts/sync-templates.mjs` 同步。',
  )
  process.exit(1)
}

console.log(
  check
    ? `同步检查通过（${SYNC_MAP.length} 个文件）`
    : `已同步 ${SYNC_MAP.length} 个文件${drifted.length === 0 ? '（无变化）' : ''}`,
)
