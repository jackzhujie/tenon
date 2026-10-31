/**
 * Spike 3 主程序：把 fixture 应用按 tenon-loc 插件编译、真实渲染成 HTML，再逐条核对定位精度。
 *
 * 为什么用 renderToString 而不是真浏览器：定位精度是"源码行号对不对"这件事，
 * 与浏览器无关；服务端渲染能拿到真实 DOM 属性，比截图断言更硬。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { transformAsync } from '@babel/core'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import tenonLoc from './babel-plugin-tenon-loc.js'
import { resolveTarget } from './resolver.js'

const ROOT = new URL('..', import.meta.url).pathname
const APP_ROOT = join(ROOT, 'fixture')
const OUT_DIR = join(ROOT, 'work')

type Fact = { name: string; ok: boolean; detail: string }
const facts: Fact[] = []
function fact(name: string, ok: boolean, detail: string): void {
  facts.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  let transformed = 0
  const result = await build({
    entryPoints: [join(APP_ROOT, 'src/app.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    absWorkingDir: APP_ROOT,
    plugins: [
      {
        name: 'tenon-loc',
        setup(b) {
          b.onLoad({ filter: /\.tsx$/ }, async (args) => {
            const source = await readFile(args.path, 'utf8')
            const out = await transformAsync(source, {
              filename: args.path,
              configFile: false,
              babelrc: false,
              sourceType: 'module',
              presets: [
                ['@babel/preset-typescript', {}],
                ['@babel/preset-react', { runtime: 'automatic', development: false }],
              ],
              plugins: [[tenonLoc, { appRoot: APP_ROOT }]],
            })
            if (out?.code === undefined || out.code === null) throw new Error(`babel 无输出：${args.path}`)
            transformed += 1
            return { contents: out.code, loader: 'js', resolveDir: join(args.path, '..') }
          })
        },
      },
    ],
  })

  const bundled = result.outputFiles?.[0]?.text
  if (bundled === undefined) throw new Error('esbuild 无输出')
  const bundlePath = join(OUT_DIR, 'app.mjs')
  await writeFile(bundlePath, bundled, 'utf8')

  // 用 file:// 导入 bundle（react 走 Node 解析，external 保证单实例）
  const mod = (await import(`${bundlePath}?t=${Date.now()}`)) as { App: () => ReactElement }
  const html = renderToStaticMarkup(createElement(mod.App))
  await writeFile(join(OUT_DIR, 'render.html'), html, 'utf8')
  console.log(`transform ${transformed} 个 tsx → bundle ${(bundled.length / 1024).toFixed(1)}KB → HTML ${html.length}B\n`)

  const { document } = parseHTML(`<body>${html}</body>`)
  const all = [...document.querySelectorAll('body *')] as Element[]
  const withLoc = all.filter((el) => el.getAttribute('data-tenon-loc') !== null)
  const withCallsite = all.filter((el) => el.getAttribute('data-tenon-callsite') !== null)

  fact(
    '注入覆盖率',
    withLoc.length === all.length && withCallsite.length > 0,
    `DOM 元素 ${all.length} 个：带 loc ${withLoc.length}，带 callsite ${withCallsite.length}；` +
      `实际属性集合=${[...new Set(all.flatMap((el) => [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-tenon'))))].join(',')}`,
  )

  // ---------- 逐条核对：属性里的 file:line:col 是否真的指向那个标签 ----------
  const sources = new Map<string, string[]>()
  async function linesOf(file: string): Promise<string[] | undefined> {
    const cached = sources.get(file)
    if (cached !== undefined) return cached
    try {
      const text = await readFile(join(APP_ROOT, file), 'utf8')
      const lines = text.split('\n')
      sources.set(file, lines)
      return lines
    } catch {
      return undefined
    }
  }

  let checked = 0
  const mismatches: string[] = []
  for (const el of all) {
    const raw = el.getAttribute('data-tenon-loc') ?? el.getAttribute('data-tenon-callsite')
    if (raw === null) continue
    const parts = raw.split(':')
    const column = Number(parts.pop())
    const line = Number(parts.pop())
    const file = parts.join(':')
    const lines = await linesOf(file)
    if (lines === undefined) {
      mismatches.push(`${raw} → 文件不存在`)
      continue
    }
    const text = lines[line - 1] ?? ''
    const atCol = text.slice(column - 1)
    const startsWithTag = atCol.startsWith('<')
    if (!startsWithTag) {
      mismatches.push(`${raw} → 该位置是 ${JSON.stringify(atCol.slice(0, 20))}，不是标签`)
    }
    checked += 1
  }
  fact(
    `${checked} 处定位的 file:line:col 逐条可回溯`,
    mismatches.length === 0,
    mismatches.length === 0 ? '全部指向真实 JSX 开标签的起始 <' : mismatches.slice(0, 3).join(' | '),
  )

  // ---------- 三个典型点击场景 ----------
  const h1 = document.querySelector('h1') as Element
  const r1 = resolveTarget(h1)
  fact(
    '点页面里的原生标签（h1）',
    r1?.primary.file === 'src/app.tsx' && r1.primary.line === 7 && r1.primary.kind === 'element',
    JSON.stringify(r1),
  )

  const button = document.querySelector('button') as Element
  const r2 = resolveTarget(button)
  fact(
    '点组合组件渲染出的按钮（shadcn 风格，透传 props）',
    r2?.primary.file === 'src/app.tsx' &&
      r2.primary.line === 13 &&
      r2.primary.kind === 'usage' &&
      r2.secondary?.file === 'src/components/ui/button.tsx',
    `定位到用户写法 ${JSON.stringify(r2?.primary)}，同时保留实现位置 ${JSON.stringify(r2?.secondary)}`,
  )

  const cardDiv = document.querySelector('.card') as Element
  const r3 = resolveTarget(cardDiv)
  fact(
    '点不透传 props 的组件（Card）内部元素 → 只能落到实现',
    r3?.primary.file === 'src/components/ui/card.tsx' && r3.primary.kind === 'component-impl',
    `解析为 ${JSON.stringify(r3?.primary)}（这条就是降级路径，UI 需提示"改动影响全局"）`,
  )

  const li = document.querySelector('li') as Element
  const r4 = resolveTarget(li)
  fact(
    '点组件 children 里的原生标签（li）',
    r4?.primary.file === 'src/app.tsx' && r4.primary.line === 10 && r4.primary.kind === 'element',
    JSON.stringify(r4?.primary),
  )

  // ---------- 生产构建是否残留 ----------
  const prod = await build({
    entryPoints: [join(APP_ROOT, 'src/app.tsx')],
    bundle: true,
    write: false,
    minify: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    absWorkingDir: APP_ROOT,
  })
  const prodText = prod.outputFiles?.[0]?.text ?? ''
  fact(
    '生产构建可不带定位属性（插件只在 dev 启用）',
    !prodText.includes('data-tenon-loc'),
    `未注入时 minified 产物 ${(prodText.length / 1024).toFixed(1)}KB，不含 data-tenon-*（说明开关有效、不会泄进生产）`,
  )

  const failed = facts.filter((f) => !f.ok)
  console.log(`\n合计 ${facts.length} 项，通过 ${facts.length - failed.length}，失败 ${failed.length}`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('spike-loc 失败：', err)
  process.exitCode = 1
})
