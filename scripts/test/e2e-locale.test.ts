/**
 * 验收脚本的语言必须钉住 —— 否则断言在按中文找一个会说英文的系统。
 *
 * 这条规则来自两次同样的失败：
 *
 * 1. `shot:plugins` 的 12 条断言全是中文文案（"下载并安装"、"已装"）。脚本从没设过
 *    界面语言，而本机系统语言是英文 → 4 条整片红。第一次跑真以为界面改坏了，
 *    去看截图才发现界面好好的。
 * 2. `e2e:hub` 第 7 节断言"提示里说清了为什么不能下载"，看的是中文原话。CI runner
 *    是 en-US → 服务端按 i18n 之后的英文说 → `... is a paid component and cannot be
 *    downloaded yet`，断言在找「购买」或「付费」。本地绿了三天，第一次上 Windows/macOS
 *    的 CI 就红。
 *
 * 两次的症状都是"看起来像功能坏了"，实际是**脚本与被测系统的语言不一致**。
 * 这类失败最贵的地方不是修它，是它教人不再相信红的 CI。
 *
 * 所以：**断言里出现中文字面量的验收脚本，必须显式钉住语言**。
 * 钉的两种写法都算 —— `setLocale('zh')`（只影响服务端消息）与
 * `settings.set { 'ui.locale': 'zh' }`（设置表 + 界面，真实用户的路径）。
 *
 * 范围限定在 `scripts/(e2e|shot)-*.ts`：这些是验收脚本，断言的是产品行为。
 * 工具脚本（`export-app.ts`、`dev-web.ts`）不在其中 —— 它们没有断言。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPTS = join(ROOT, 'scripts')

/** 断言中文字面量的几种写法（`x.includes('中文')`、`/中文/.test(x)` …） */
const ASSERTS_HAN = [
  /\.(?:includes|startsWith|endsWith|toContain)\(\s*['"`][^'"`]*[\u4e00-\u9fa5]/,
  /\/[^/\n]*[\u4e00-\u9fa5][^/\n]*\/\.test\(/,
  /\.test\(\s*['"`][^'"`]*[\u4e00-\u9fa5]/,
]

const PINNED = /setLocale\('zh'\)|'ui\.locale': 'zh'/

/**
 * 豁免：这几处中文字面量**不是产品文案**，是脚本自己造的内容 ——
 * 界面翻成英文它们也不会变，所以钉不钉语言都无所谓。
 *
 * 豁免按文件走（不按行），因为这几份的断言通篇都在说自己造的东西。
 * 代价照例要写清：**如果哪天这些脚本开始断言产品文案，这里会替它挡住红**。
 * 加新豁免之前先问一句："这句文字是产品渲染出来的吗？" 是 → 去钉语言，别加豁免。
 */
const EXEMPT: Record<string, string> = {
  'e2e-e2e-agent.ts': '断言的是脚本让 Agent 写的演示页（计数器 / 已点击 / ✓ 断言通过）',
  'e2e-fullstack.ts': '断言的是脚本自己注入页面的错误文案（e2e: 页面渲染失败）',
  'e2e-inspector.ts': '断言的是脚本自己写进页面的元素文本（精调 E2E）',
  'e2e-preview.ts': '断言的是脚本自己改过的文件内容（改过了）',
  'e2e-provider.ts': '断言的是脚本指定的待办清单演示内容',
}

/** 注释里的中文不算断言 —— 这些脚本的注释全是中文 */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  return trimmed.replace(/\/\/.*$/, '')
}

describe('验收脚本钉住了语言', () => {
  it('断言中文的 e2e / shot 脚本必须显式设语言', () => {
    const problems: string[] = []

    for (const name of readdirSync(SCRIPTS)) {
      if (!/^(e2e|shot)-[^/]*\.ts$/.test(name)) continue
      if (EXEMPT[name] !== undefined) continue
      const file = join(SCRIPTS, name)
      const text = readFileSync(file, 'utf8')
      // 只抓起真服务的那些：不起服务就没有"服务端说什么话"的问题
      if (!text.includes('startServer(')) continue
      if (PINNED.test(text)) continue

      const hits = text
        .split('\n')
        .map((line, index) => ({ code: codeOf(line), line: index + 1 }))
        .filter((item) => ASSERTS_HAN.some((pattern) => pattern.test(item.code)))
      // 只报第一条：一个文件钉没钉语言是"是/否"，列全了反而看不清
      const hit = hits[0]
      if (hit === undefined) continue

      problems.push(
        `scripts/${name}:${hit.line} — 断言的文案是中文，这个脚本却没设语言：\n    ${hit.code.slice(0, 110)}`,
      )
    }

    expect(
      problems,
      `这些脚本会被系统语言影响（CI runner 是 en-US）：\n${problems.join('\n')}\n\n` +
        "改法：在 startServer 之后加一行 —— 只验服务端消息用 setLocale('zh')；" +
        "要让界面也跟着中文，走 rpc('settings.set', { values: { 'ui.locale': 'zh' } })",
    ).toEqual([])
  })
})
