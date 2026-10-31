/**
 * 启动壳（`pnpm dev:desktop` 走这里，而不是直接 `electron .`）。
 *
 * 唯一的原因是**环境变量**：`ELECTRON_RUN_AS_NODE` 如果出现在环境里（从 IDE 或其他
 * Electron 应用里启动脚本时会自动带上），`electron .` 就会被当成普通 node 运行，
 * 于是 `import { app } from 'electron'` 解析到 npm 包那个"返回可执行文件路径"的 shim，
 * 报 `does not provide an export named 'BrowserWindow'` —— 看起来像 ESM 不支持，
 * 其实是环境变量。这里显式删掉它，让"能跑"不依赖用户碰巧没有这个变量。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']

// `pnpm start -- --no-sandbox` 会把 `--` 也塞进 argv：Electron 会把它当成"文件路径分隔符"，
// 后面的开关全部失效（症状是"明明传了 --no-sandbox 还是沙箱报错"）
const extra = process.argv.slice(2).filter((arg) => arg !== '--')

const child = spawn(electronPath, ['.', ...extra], { stdio: 'inherit', env })
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1))
})
