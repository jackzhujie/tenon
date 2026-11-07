/**
 * 一次性验证：给 react-vite 应用加后端之后，**代码真的能编译、lint 真的能过**。
 *
 * 不进测试套件（要联网装 NestJS，几十秒到几分钟）。用法：
 *   npx tsx scripts/verify-api-feature.ts
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { applyApiFeature, scaffoldApp } from '../packages/generator/src/index.js'

const run = promisify(execFile)
const repo = await mkdtemp(join(tmpdir(), 'tenon-verify-api-'))
console.log('工作区：', repo)

await scaffoldApp({ repoDir: repo, appId: 'app_v', appName: '报销', appSlug: 'expense' })
const result = await applyApiFeature({ repoDir: repo })
console.log('加后端：', result.applied, result.files.length, '个文件')
for (const note of result.notes) console.log('  注意：', note)

const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
  type?: string
  scripts: Record<string, string>
  tenon?: { api?: string }
}
console.log('package.json type =', pkg.type, '/ tenon.api =', JSON.stringify(pkg.tenon))

async function step(label: string, command: string, args: string[]): Promise<void> {
  const started = Date.now()
  try {
    const { stdout, stderr } = await run(command, args, { cwd: repo, timeout: 600_000 })
    const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-3).join('\n   ')
    console.log(`✅ ${label}（${Date.now() - started}ms）\n   ${tail}`)
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string }
    console.log(`❌ ${label}\n${(failed.stdout ?? '').slice(-1500)}\n${(failed.stderr ?? '').slice(-1500)}`)
    process.exit(1)
  }
}

// 用仓库自己的 pnpm（与 Tenon 打包态随包的是同一份逻辑）
await step('安装依赖（含 NestJS）', 'pnpm', ['install', '--config.confirmModulesPurge=false'])
await step('lint（应只扫到源码，不扫 dist-server）', 'pnpm', ['run', 'lint'])
await step('build:api（tsc + 钉 commonjs）', 'pnpm', ['run', 'build:api'])

const output = join(repo, 'dist-server', 'api', 'main.js')
console.log(existsSync(output) ? '✅ 编译产物存在 dist-server/api/main.js' : '❌ 没有编译产物')

if (pkg.type === 'module') {
  const marker = join(repo, 'dist-server', 'package.json')
  const text = existsSync(marker) ? await readFile(marker, 'utf8') : '(没有)'
  console.log('dist-server/package.json =', text.trim())
  console.log(text.includes('commonjs') ? '✅ 产物目录钉成 commonjs（否则 require is not defined）' : '❌ 没钉住')
}

await step('build（前后端 typecheck + vite build）', 'pnpm', ['run', 'build'])
console.log('\n全部通过。工作区保留在：', repo)
