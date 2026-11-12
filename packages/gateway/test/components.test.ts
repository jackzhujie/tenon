/**
 * 组件脚本注入（`injectComponentScript`）。
 *
 * 这一段是**拼字符串**生成的 inline script，没有任何类型系统帮忙 —— 一个引号写错
 * 就是整页白屏，而症状只会是"预览打不开"。所以这里盯三件事：
 * 语言确实写进去了、错误捕手没被挤掉、重复注入不会挂两次。
 */
import { describe, expect, it } from 'vitest'
import { injectComponentScript } from '../src/components.js'

const URL = '/__tenon/component.js?appId=app_1'
const HTML = '<html><body><div id="app">x</div></body></html>'

describe('injectComponentScript', () => {
  it('插在 </body> 之前，不是 </head>（组件要能看见已经渲染的页面）', () => {
    const out = injectComponentScript(HTML, URL, 'zh')
    expect(out.indexOf(URL)).toBeGreaterThan(out.indexOf('<div id="app">'))
    expect(out.indexOf(URL)).toBeLessThan(out.indexOf('</body>'))
  })

  it('把语言写进全局：首屏那一份不另发一次请求', () => {
    expect(injectComponentScript(HTML, URL, 'zh')).toContain('window.__tenonLocale="zh";')
    expect(injectComponentScript(HTML, URL, 'en')).toContain('window.__tenonLocale="en";')
  })

  it('挂 message 监听：切语言时改全局并派发事件', () => {
    const out = injectComponentScript(HTML, URL, 'en')
    // 名字由 JSON.stringify 生成，所以是双引号
    expect(out).toContain('d.type!=="tenon:locale"')
    expect(out).toContain('dispatchEvent(new CustomEvent("tenon:locale"')
    /*
     * 只认 en / zh 两个值。放开的话，父页面（或页面里任何脚本）发一个
     * `"zh-CN"` 就能把组件推进"表里没有这个 key"的分支 —— 那会静默显示空白。
     */
    expect(out).toContain("d.locale!=='en'&&d.locale!=='zh'")
  })

  it('错误捕手还在：组件加载失败时唯一的线索', () => {
    const out = injectComponentScript(HTML, URL, 'zh')
    expect(out).toContain('window.__tenonComponentErrors=[]')
    expect(out).toContain("addEventListener('unhandledrejection'")
  })

  it('重复注入是幂等的：两次注入不能有两个组件、两份监听', () => {
    const once = injectComponentScript(HTML, URL, 'zh')
    expect(injectComponentScript(once, URL, 'en')).toBe(once)
  })

  it('没有 </body> 也不抛（注入失败只该表现为"球不在"，不是预览 500）', () => {
    const out = injectComponentScript('<div>片段</div>', URL, 'zh')
    expect(out).toContain(URL)
  })
})
