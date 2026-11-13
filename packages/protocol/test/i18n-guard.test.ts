/**
 * 跨包的文案护栏：`packages/*` 与 `plugins/bundled` 的**字符串字面量**里不许出现中文。
 *
 * 为什么需要它：i18n 是分五轮做完的（界面 / 服务端 / Agent / 组件商店 / 组件界面），
 * 每一轮都要用 grep 数"还剩多少处"。数出来的数字每次都比实际少 —— 因为多行字符串里
 * 的中文整行不含中文（错误码一行、消息在下一行），按行 grep 会漏掉三分之一。
 * 等做完再靠人记得"以后要写 msg()"是不可靠的，所以把它变成一条会红的测试。
 *
 * ## 三类例外，都按「为什么」而不是「哪一行」豁免
 *
 * 1. `protocol/src/messages/**` —— 文案表本身，两语言就是它的用途
 * 2. `plugins/bundled/*​/web.ts` 与 `*​/server.ts` —— 组件自带的 en/zh 小表：组件是
 *    独立分发单元，不能依赖宿主的文案表（那会把 30KB 文案塞进每个组件）。
 *    半边的语言来源不同（web 从 `window.__tenonLocale`，server 从 `ActivateInput.getLocale`），
 *    但"各带一张小表"是同一件事，所以按**文件名**豁免，不按半边
 * 3. 提示词里 `"Did not run" / "没跑成"` —— **故意同时点名两种语言**：检查项结论会随
 *    界面语言变，模型必须两版都认得
 *
 * 注释里的中文**不算**：注释是给维护者的，留在中文里读起来更快。所以这条只扫
 * 字符串字面量 —— 先把整行注释剔掉，再看剩下那部分有没有引号包着的中文。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 只扫源码，不扫测试（测试名用中文很合理）与构建产物 */
const SCOPES = ['packages', 'plugins']

const ALLOWED = [
  // 文案表：两语言就是它的用途
  /^packages[\\/]protocol[\\/]src[\\/]messages[\\/]/,
  // 组件自带的 en/zh 小表（浏览器半边与服务端半边各一张，理由见文件头第 2 条）
  /^plugins[\\/]bundled[\\/][^\\/]+[\\/](web|server)\.ts$/,
]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      // `packages/x/test` 与 `dist` 都不该进这个检查
      if (entry === 'test' || entry === 'spikes') continue
      walk(full, out)
      continue
    }
    if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('源码里不再有硬编码中文', () => {
  it('字符串字面量里没有中文（注释不算，三类例外已豁免）', () => {
    const hits: string[] = []
    for (const scope of SCOPES) {
      for (const file of walk(join(ROOT, scope))) {
        const rel = relative(ROOT, file)
        if (ALLOWED.some((pattern) => pattern.test(rel))) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, index) => {
          const trimmed = line.trim()
          // 整行注释 / 块注释正文：注释里的中文是给维护者看的，不算文案
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
          // 去掉行尾注释再判（`// 中文` 不算）
          const code = trimmed.replace(/\/\/.*$/, '')
          // 只在"引号/反引号包着中文"时算命中 —— 变量名、标识符里不会有中文
          if (!/['`"][^'`"]*[\u4e00-\u9fff]/.test(code)) return
          // 提示词里故意同时点名两种写法的那几行。要看**上一行**：长句在源码里是
          // 跨行拼接的（`"... — \"Did not run\" / "` + `"没跑成" — ...`），只看本行会误报
          const previous = index > 0 ? (lines[index - 1] ?? '') : ''
          if (code.includes('没跑成') && (code.includes('Did not run') || previous.includes('Did not run'))) {
            return
          }
          hits.push(`${rel.split(sep).join('/')}:${index + 1}  ${trimmed.slice(0, 100)}`)
        })
      }
    }
    expect(hits, `这些地方还硬编码着中文：\n${hits.join('\n')}`).toEqual([])
  })
})
