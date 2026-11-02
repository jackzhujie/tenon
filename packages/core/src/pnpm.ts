/**
 * 找到一个**能用**的包管理器。
 *
 * 两个地方需要它，所以抽到这里：
 * - 预览起不来时装依赖（`packages/gateway/src/deps.ts`）
 * - 发布前跑应用的 `test` 脚本（`packages/agent/src/checks.ts`）
 *
 * 顺序是"越确定越靠前"：
 * 1. `TENON_PNPM` —— 用户/测试显式指定，最高优先级
 * 2. **随包自带的 pnpm**（桌面版 `Resources/server/node_modules/pnpm/bin/pnpm.cjs`）——
 *    这是"双击装完却起不来预览"的根治办法：用户机器上不该假设有 pnpm，
 *    从 Dock 启动的 GUI 进程 PATH 还很短
 * 3. 和 node 同目录的 pnpm —— nvm / 官方安装器常见布局
 * 4. `PATH` 里的 `pnpm` —— 最后兜底
 *
 * `import.meta.url` 这一条在打包后依然成立：core 被内联进 `server.mjs`，那个路径正好是
 * `<Resources>/server/server.mjs`，指向随包目录；开发态是 `packages/core/src/pnpm.ts`，
 * 那个路径不存在 → 自动落到下一档。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PackageManager {
  command: string
  /** 是 JS 入口就得用 node 跑（`.bin/pnpm` 那种 shell 包装不能直接 spawn） */
  isScript: boolean
}

export function resolvePnpm(env: NodeJS.ProcessEnv): PackageManager {
  const explicit = env['TENON_PNPM']
  if (explicit !== undefined && explicit !== '') {
    return { command: explicit, isScript: /\.(?:c|m)?js$/.test(explicit) }
  }

  const bundled = fileURLToPath(new URL('./node_modules/pnpm/bin/pnpm.cjs', import.meta.url))
  if (existsSync(bundled)) return { command: bundled, isScript: true }

  // nvm / 官方安装器里 pnpm 通常和 node 同目录；GUI 启动时 PATH 常常没有它
  const sibling = join(dirname(process.execPath), 'pnpm')
  if (existsSync(sibling)) return { command: sibling, isScript: false }

  return { command: 'pnpm', isScript: false }
}
