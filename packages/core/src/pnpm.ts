/**
 * 找到一个**能用**的包管理器，并把它变成一个**能 spawn 的调用**。
 *
 * 四处需要它，所以抽到这里（原先"`isScript` 就换 node"那段判断被复制了四遍）：
 * - 预览起不来时装依赖（`packages/gateway/src/deps.ts`）
 * - 发布前跑应用的 `test` / `lint` 脚本（`packages/agent/src/checks.ts`）
 * - 导出静态包 / Docker 上下文时跑应用的 `build` 脚本（`packages/server/src/export.ts`）
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
 *
 * ## Windows 这一档为什么不能只是"换个扩展名"
 *
 * 两条都是实测出来的（三平台 CI 第一次跑就全挂在 `spawn pnpm ENOENT` 上）：
 *
 * 1. Windows 上 `pnpm` 实际是 `pnpm.cmd`（Node 的 spawn **不做 PATHEXT 补全**），
 *    所以直接 `spawn('pnpm')` 是 ENOENT —— 表现是"脚本起不来"，看着像环境坏了。
 * 2. 而从 Node 18.20 / 20.12 起（CVE-2024-27980 的修复），**`spawn` 不允许直接跑
 *    `.cmd`/`.bat`**，必须 `shell: true`（交给 `cmd.exe` 解析）。
 *
 * 所以 Windows 上要同时做两件事：`pnpm.cmd` + `shell: true`。这也意味着**参数里不能有
 * 需要引用才安全的空格**。我们的参数只有子命令与开关（`run lint` / `install
 * --prefer-offline`），没有路径 —— 路径一律走 `cwd`。加参数时记住这条。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface PackageManager {
  command: string
  /** 是 JS 入口就得用 node 跑（`.bin/pnpm` 那种 shell 包装不能直接 spawn） */
  isScript: boolean
  /** 是否必须经过 shell（Windows 上的 `.cmd`）。其它平台恒为 `false` */
  shell: boolean
}

/** 一次准备 spawn 的调用：`spawn(command, args, { shell, ... })` */
export interface PnpmInvocation {
  readonly command: string
  readonly args: string[]
  readonly shell: boolean
}

export function resolvePnpm(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): PackageManager {
  const win = platform === 'win32'

  const explicit = env['TENON_PNPM']
  if (explicit !== undefined && explicit !== '') {
    const isScript = /\.(?:c|m)?js$/i.test(explicit)
    return { command: explicit, isScript, shell: win && !isScript }
  }

  const bundled = fileURLToPath(new URL('./node_modules/pnpm/bin/pnpm.cjs', import.meta.url))
  if (existsSync(bundled)) return { command: bundled, isScript: true, shell: false }

  // nvm / 官方安装器里 pnpm 通常和 node 同目录；GUI 启动时 PATH 常常没有它
  const siblingDir = dirname(process.execPath)
  const sibling = win ? join(siblingDir, 'pnpm.cmd') : join(siblingDir, 'pnpm')
  if (existsSync(sibling)) return { command: sibling, isScript: false, shell: win }

  return { command: win ? 'pnpm.cmd' : 'pnpm', isScript: false, shell: win }
}

/**
 * 把包管理器 + 参数变成一个可 spawn 的调用。
 *
 * 随包的 `.cjs` 走 `node <pnpm.cjs> …`（打包态还需要 `ELECTRON_RUN_AS_NODE`，
 * 那个由调用方决定，因为只有它们知道自己在不在 Electron 里）。
 */
export function invokePnpm(pm: PackageManager, args: readonly string[]): PnpmInvocation {
  if (pm.isScript) {
    return { command: process.execPath, args: [pm.command, ...args], shell: false }
  }
  return { command: pm.command, args: [...args], shell: pm.shell }
}
