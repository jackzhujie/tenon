/**
 * 界面文案护栏自己的测试。
 *
 * 为什么需要：这条脚本是"界面没有硬编码中文"这个承诺的**唯一执行者**。
 * 它误报（把文案表当成界面文件）会让 CI 一直红，而一直红的门禁最后一定被人关掉；
 * 它漏报则那句承诺是假的，且没有任何东西会响。
 *
 * 前 4 条测的是 Windows 路径 —— 这是上线后第一次在真 CI 上跑就红的那个 bug：
 * `join` 在 Windows 上产出 `apps\web\src\lib\messages\apps.ts`，而判据写的是
 * `lib/messages`（正斜杠），于是整个中文文案表被逐行扫，几百条全算"漏网"。
 * 本机 macOS 永远复现不了，所以测试要**手动喂 Windows 风格的字符串**，别依赖 host 平台。
 */
import { describe, expect, it } from 'vitest'
import { isMessagesFile, looksLikeCopy } from '../check-i18n.js'

describe('isMessagesFile —— 文案表整目录豁免', () => {
  it('POSIX 路径：文案表被豁免', () => {
    expect(isMessagesFile('apps/web/src/lib/messages/apps.ts')).toBe(true)
  })

  it('Windows 路径：同样被豁免（分隔符要先归一）', () => {
    expect(isMessagesFile('apps\\web\\src\\lib\\messages\\apps.ts')).toBe(true)
  })

  it('界面文件不豁免，两种分隔符都一样', () => {
    expect(isMessagesFile('apps/web/src/features/apps/AppMenu.tsx')).toBe(false)
    expect(isMessagesFile('apps\\web\\src\\features\\apps\\AppMenu.tsx')).toBe(false)
  })

  it('名字相近的目录不能蹭豁免：`lib/messages-v2/` 是界面代码，不是文案表', () => {
    expect(isMessagesFile('apps/web/src/lib/messages-v2/apps.ts')).toBe(false)
  })
})

describe('looksLikeCopy —— 哪些中文算"文案"', () => {
  it('引号里的字符串', () => {
    expect(looksLikeCopy(`throw new Error('已复制')`)).toBe(true)
    expect(looksLikeCopy(`title="新建应用"`)).toBe(true)
  })

  it('同一对标签之间的文本', () => {
    expect(looksLikeCopy('<p className="x">还没有应用</p>')).toBe(true)
    // 中间带插值也算 —— 收窄成 [^<>{}] 就一条都测不到
    expect(looksLikeCopy('<div>装不上的 {problems.length} 条</div>')).toBe(true)
  })

  it('整行就是一句文案（拆成单独一行的按钮文字）', () => {
    expect(looksLikeCopy('发布')).toBe(true)
  })

  it('行首是中文、后面跟插值：`已释放 {formatBytes(x)}`', () => {
    expect(looksLikeCopy('已释放 {formatBytes(outcome.freedBytes)}')).toBe(true)
    expect(looksLikeCopy('删除「{app.name}」？代码、数据库、日志会一起删掉')).toBe(true)
  })

  it('行首是插值、后面跟中文：`{count} 个应用的账本读不到`', () => {
    expect(looksLikeCopy('{count} 个应用的账本读不到')).toBe(true)
    expect(looksLikeCopy('{errorCount} 错误')).toBe(true)
  })

  it('纯代码行不算文案（宁可漏，不要天天误报）', () => {
    expect(looksLikeCopy('const total = formatBytes(report.bytes)')).toBe(false)
    expect(looksLikeCopy("import { t } from '../../lib/i18n.js'")).toBe(false)
    expect(looksLikeCopy('if (index > 0) return')).toBe(false)
    expect(looksLikeCopy('return /^[\\u4e00-\\u9fa5]/')).toBe(false)
  })
})
