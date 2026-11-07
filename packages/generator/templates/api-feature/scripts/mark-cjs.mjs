/**
 * 给后端编译产物钉住模块格式。
 *
 * Nest 的产物是 CommonJS，而这个应用的 `package.json` 里有 `"type": "module"`
 * （React 模板普遍这么写）。Node 判定一个 `.js` 是 ESM 还是 CJS，**只看离它最近的
 * package.json 的 `type`** —— 于是 `dist-server/api/main.js` 会被当成 ESM 执行，
 * 启动第一行就 `ReferenceError: require is not defined`。
 *
 * 修法就是在产物目录里放一个 `{"type":"commonjs"}`：它是最近的 package.json，
 * 作用域只覆盖 dist-server/，不影响应用自己的 ESM。
 *
 * 只在真的会冲突时才写（根 package.json 没有 `type: module` 就什么都不做）。
 * `pnpm build:api` 会在 tsc 之后调它；Tenon 起预览时自己编译，那一侧由网关补。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.type !== 'module') process.exit(0)

// 与 `build:api` 里 tsc 的 outDir 一致。改 outDir 的话这里也要改。
const outDir = join(root, 'dist-server')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`)
