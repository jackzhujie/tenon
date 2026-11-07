/**
 * 给子进程准备一个 `node`（v1.2.25）。
 *
 * ## 为什么需要
 *
 * 打包版的机器上**没有 Node** —— 这是刻意的：`ELECTRON_RUN_AS_NODE=1` 时 Electron 二进制
 * 就是 Node，所以安装包不要求用户装任何东西。
 *
 * 但**应用自己的 `node_modules/.bin/*` 脚本是 `exec node` 的 shim**：
 *
 * ```sh
 * if [ -x "$basedir/node" ]; then exec "$basedir/node" ...; else exec node ...; fi
 * ```
 *
 * 于是打包版里 `pnpm run lint` 报：
 *
 * ```
 * node_modules/.bin/eslint: line 16: exec: node: not found
 * ```
 *
 * 同一个原因让 `pnpm run build`（导出静态包 / Docker 上下文）也失败。
 * `tsc` 那一项之所以能过，是因为我们**直接用 `process.execPath` 跑 tsc 的入口**，
 * 绕过了 shim —— 也就是说这是一个"一半能跑"的坑，更容易被漏掉。
 *
 * ## 做法
 *
 * 在临时目录里放一个**薄壳**，把自己伪装成 `node`，实际转调 `process.execPath`
 * 并设上 `ELECTRON_RUN_AS_NODE=1`（`.bin` 脚本不会设这个变量），然后把那个目录
 * 放到子进程 `PATH` 的最前面。
 *
 * - 只在实际跑在 Electron 里时启用（开发态 `node` 本来就在 PATH 上，不该覆盖它）
 * - 目录名带 `execPath` 的哈希：不同版本/不同安装路径不会互相踩
 * - **同步创建**、进程内缓存一次：调用点是构造 env 的地方（多为同步），
 *   为它改成异步会把整条链路染成 async，不值得（一次几毫秒）
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface NodeShimOptions {
  /** 默认 `process.execPath`（打包态是 `Tenon.app/Contents/MacOS/Tenon`） */
  execPath?: string
  platform?: NodeJS.Platform
  /** 测试用：即使不在 Electron 里也建一个 */
  force?: boolean
}

/** 单引号转义：路径里可能有空格（`/Applications/Tenon.app/...` 就有） */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

let cached: string | null | undefined

/**
 * 建（或复用）那个薄壳目录。返回 `null` = 不需要（不在 Electron 里，或建不出来）。
 *
 * 建不出来时**不抛**：宁可让脚本跑到"node 找不到"，也不要让构造 env 这件事本身失败。
 */
export function nodeShimDir(options: NodeShimOptions = {}): string | null {
  // 只缓存**成功**的结果：`null` 有可能是"这次没 force"，缓存它会让后面的调用也拿到 null
  if (cached !== undefined && cached !== null) return cached
  const dir = createShim(options)
  cached = dir
  return dir
}

function createShim(options: NodeShimOptions): string | null {
  const inElectron = process.versions.electron !== undefined
  if (!inElectron && options.force !== true) return null

  const execPath = options.execPath ?? process.execPath
  const platform = options.platform ?? process.platform
  const hash = createHash('sha256').update(execPath).digest('hex').slice(0, 12)
  const dir = join(tmpdir(), `tenon-node-${hash}`)

  try {
    mkdirSync(dir, { recursive: true })
    if (platform === 'win32') {
      /*
       * Windows 上 `node` 得叫 `node.cmd`：`cmd.exe` 按 PATHEXT 找（.COM/.EXE/.BAT/.CMD），
       * 而 npm/pnpm 生成的 `.bin/*.cmd` 里写的就是 `node ...`。
       */
      writeFileSync(
        join(dir, 'node.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" %*\r\n`,
        'utf8',
      )
    } else {
      const file = join(dir, 'node')
      writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} "$@"\n`, 'utf8')
      chmodSync(file, 0o755)
    }
  } catch {
    return null
  }
  return dir
}

/**
 * 把这个薄壳目录塞进 `env` 的 `PATH` 最前面。
 *
 * 注意 Windows 上 `PATH` 的键名可能是 `Path`（Node 不区分大小写地读，但对象里的键是字面量）——
 * 两个都处理，否则会出现"设了一个没人读的变量"。
 */
export function withNodeShim(env: NodeJS.ProcessEnv, options: NodeShimOptions = {}): NodeJS.ProcessEnv {
  const dir = nodeShimDir(options)
  if (dir === null) return env

  const sep = (options.platform ?? process.platform) === 'win32' ? ';' : ':'
  const key = env['PATH'] !== undefined ? 'PATH' : env['Path'] !== undefined ? 'Path' : 'PATH'
  const current = env[key] ?? ''
  return { ...env, [key]: current === '' ? dir : `${dir}${sep}${current}` }
}
