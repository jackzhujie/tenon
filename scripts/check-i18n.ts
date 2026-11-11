/**
 * 中文残留检测 —— i18n 能不能维持住，全靠这一条。
 *
 * 为什么它是必需品而不是锦上添花：界面文案有 340 条，靠人一条条改，**漏掉五条是必然**。
 * 而漏掉的表现是英文界面里突然冒出一句中文 —— 比全中文还难看，且只有那一个分支的用户看得到。
 * 这条检查进 CI 之后，漏的那条会让门禁红，改起来是五分钟的事。
 *
 * 判据刻意宽松（只扫"引号里"与"JSX 文本里"的中文，且跳过注释）：
 * 宁可漏掉一句拼在模板字符串深处的，也不要天天误报把人逼到关掉它。
 *
 * 两处豁免：
 * - `lib/messages/` 整个目录 —— 那里就是文案表本身
 * - 行内写 `i18n-ignore` —— 品牌字（`榫`）、命令示例、正则里的中文字符集
 *
 * 另外查一件事：**英文表里不能出现中文**。这条比残留更严重 ——
 * 英文界面显示中文说明"这条压根没翻译"，而它藏在一个不会被误报的目录里。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB_SRC = 'apps/web/src'
const MESSAGES_DIR = 'lib/messages'
const HAN = /[\u4e00-\u9fa5]/
const IGNORE_MARK = 'i18n-ignore'

interface Hit {
  file: string
  line: number
  text: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/** 去掉行注释：`https://x` 里的 `//` 不算（前面是冒号） */
function stripLineComment(code: string): string {
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] === '/' && code[i + 1] === '/') {
      const before = code[i - 1]
      if (before === undefined || before !== ':') return code.slice(0, i)
    }
  }
  return code
}

/** 去掉块注释（含跨行），返回"这行还剩多少代码" */
function stripBlockComments(lines: string[]): string[] {
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    let code = ''
    let index = 0
    while (index < line.length) {
      if (inside) {
        const end = line.indexOf('*/', index)
        if (end === -1) {
          index = line.length
          break
        }
        inside = false
        index = end + 2
        continue
      }
      const open = line.indexOf('/*', index)
      if (open === -1) {
        code += line.slice(index)
        break
      }
      code += line.slice(index, open)
      const close = line.indexOf('*/', open + 2)
      if (close === -1) {
        inside = true
        break
      }
      index = close + 2
    }
    out.push(code)
  }
  return out
}

/**
 * 只认"文案形状"的中文，三种：
 * 1. 引号里的字符串（`'已复制'`、`title="新建应用"`）
 * 2. 同一行里标签之间的文本（`<p>还没有应用</p>`）
 * 3. **整行就是一个纯文案**（里面没有 `= ; { } ( ) < >` 这些代码符号）
 *
 * 第 3 条是后补的：`<Button>` 里把文字单独放一行（
 * `>` 换行 `发布` 换行 `</Button>`）时前两条都测不到 —— 而那正是最常见的写法，
 * 漏掉它就等于门禁对按钮文字完全失效。
 */
function looksLikeCopy(code: string): boolean {
  const quoted = /'[^'\n]*[\u4e00-\u9fa5][^'\n]*'|"[^"\n]*[\u4e00-\u9fa5][^"\n]*"|`[^`]*[\u4e00-\u9fa5][^`]*`/.test(
    code,
  )
  if (quoted) return true

  const jsxText = />[^<>{}]*[\u4e00-\u9fa5][^<>{}]*</.test(code)
  if (jsxText) return true

  const bare = code.trim()
  return /^[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9，。：；、！？「」『』（）…·\-—\s]*$/.test(bare)
}

function scanSources(): Hit[] {
  const hits: Hit[] = []
  for (const file of walk(WEB_SRC)) {
    if (file.includes(MESSAGES_DIR)) continue
    const raw = readFileSync(file, 'utf8').split('\n')
    const code = stripBlockComments(raw)
    code.forEach((line, index) => {
      // 豁免可以在本行，也可以在**上一行** —— JSX 里 `{/* ... */}` 只能写在外面
      if (raw[index].includes(IGNORE_MARK)) return
      if (index > 0 && raw[index - 1].includes(IGNORE_MARK)) return
      const stripped = stripLineComment(line)
      if (!HAN.test(stripped)) return
      if (!looksLikeCopy(stripped)) return
      hits.push({ file, line: index + 1, text: raw[index].trim().slice(0, 120) })
    })
  }
  return hits
}

/**
 * 英文表里混进中文。
 *
 * 用正则抓 `xxxEn = { ... } as const` 这一整段：文案表是**扁平对象字面量**，
 * 没有嵌套函数，所以这个粗解析够用；真有复杂的就该拆文件了。
 */
function scanEnglishTables(): Hit[] {
  const hits: Hit[] = []
  const dir = join(WEB_SRC, MESSAGES_DIR)
  for (const name of readdirSync(dir)) {
    if (!/\.ts$/.test(name)) continue
    const file = join(dir, name)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/export const \w+En = \{([\s\S]*?)\n\} as const/g)) {
      const body = match[1] ?? ''
      body.split('\n').forEach((line, index) => {
        // 只看**值**：`'key': 'value'` 里冒号后的那个字符串。注释里写中文是允许的
        const value = /:\s*'([^']*)'/.exec(line)?.[1]
        if (value !== undefined && HAN.test(value)) {
          hits.push({ file, line: index + 1, text: line.trim() })
        }
      })
    }
  }
  return hits
}

const leftovers = scanSources()
const englishWithHan = scanEnglishTables()

if (leftovers.length > 0) {
  console.error(`\n✗ 界面文件里还有 ${leftovers.length} 处中文没走文案表：\n`)
  for (const hit of leftovers) console.error(`  ${hit.file}:${hit.line}\n    ${hit.text}`)
  console.error(
    '\n改法：把文案挪进 apps/web/src/lib/messages/<feature>.ts 的 en / zh 两张表，' +
      '代码里用 t(\'feature.key\')。\n' +
      '确实是品牌字/命令示例的，在该行写注释 i18n-ignore。\n',
  )
}

if (englishWithHan.length > 0) {
  console.error(`\n✗ 英文文案表里混进了 ${englishWithHan.length} 处中文：\n`)
  for (const hit of englishWithHan) console.error(`  ${hit.file}:${hit.line}\n    ${hit.text}`)
  console.error('\n英文表里出现中文，说明这一条压根没翻译 —— 而它藏在不会被误报的目录里。\n')
}

if (leftovers.length > 0 || englishWithHan.length > 0) process.exit(1)
console.log('✓ 没有未走文案表的中文')
