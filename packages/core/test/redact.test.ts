/**
 * 脱敏的护栏。
 *
 * 这些用例的价值和别处不一样：**别的地方错了是功能不对，这里错了是数据泄露。**
 * 而且泄露是静默的 —— 报告看起来完全正常，只是里面多了用户的项目名。
 * 所以每条规则都要有正例（该脱的脱掉）和反例（不该脱的别动）。
 */
import { describe, expect, it } from 'vitest'
import { redactDiagnostic } from '../src/redact.js'

describe('redactDiagnostic', () => {
  /**
   * **只换家目录那一段，相对路径留着** —— 用户名要藏，但 `/src/a.ts` 是排错要看的。
   * 全吃掉的话堆栈会变成一排 `<home>`，报告就没用了。
   * 代价是项目名还在（用户自己的业务），这一层交给"发送前人看一眼"。
   */
  it('把家目录那一段换成 <home>，后面的相对路径留着', () => {
    const result = redactDiagnostic('read /Users/jack/project/demo/src/a.ts failed', {
      home: '/Users/jack',
    })
    expect(result.text).toBe('read <home>/project/demo/src/a.ts failed')
    expect(result.rules).toContain('home')
  })

  it('Windows 的两种分隔符都换', () => {
    const options = { home: 'C:\\Users\\jack' }
    expect(redactDiagnostic('at C:\\Users\\jack\\app\\a.js:1:2', options).text).toBe(
      'at <home>\\app\\a.js:1:2',
    )
    expect(redactDiagnostic('at C:/Users/jack/app/a.js:1:2', options).text).toBe(
      'at <home>/app/a.js:1:2',
    )
  })

  it('应用目录换成 <app> —— 应用名本身就是业务信息', () => {
    const result = redactDiagnostic('spawn /tmp/tenon/apps/ap-1/repo/node_modules/.bin/vite', {
      appDir: '/tmp/tenon/apps/ap-1/repo',
    })
    expect(result.text).toBe('spawn <app>/node_modules/.bin/vite')
    expect(result.rules).toContain('app')
  })

  /**
   * 应用目录通常在家目录下面，所以**必须先换 app 再换 home** ——
   * 反过来的话 home 先吃掉前缀，`<app>` 永远换不上，应用名就留在报告里了。
   */
  it('同时给了 appDir 与 home 时，应用目录优先', () => {
    const result = redactDiagnostic('crash at /Users/jack/.tenon/apps/ap-1/repo/src/main.ts:3', {
      home: '/Users/jack',
      appDir: '/Users/jack/.tenon/apps/ap-1/repo',
    })
    expect(result.text).toBe('crash at <app>/src/main.ts:3')
  })

  it('没传家目录时，别处的 /Users/… 也照样脱（兜底模式）', () => {
    const result = redactDiagnostic('loaded /Users/someone/Library/Preferences/x.json')
    expect(result.text).toBe('loaded <home>')
    expect(result.rules).toContain('user-path')
  })

  it('邮箱', () => {
    const result = redactDiagnostic('notify jack@example.com and a.b+c@sub.example.co.uk')
    expect(result.text).toBe('notify <email> and <email>')
    expect(result.count).toBe(2)
  })

  it('模型密钥与 GitHub 令牌', () => {
    expect(redactDiagnostic('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc').text).toContain(
      'Bearer <key>',
    )
    expect(redactDiagnostic('key sk-abcdefghijklmnopqrstuvwx').text).toBe('key <key>')
    expect(redactDiagnostic('tok ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6').text).toBe('tok <key>')
  })

  it('key=value 形式的赋值（保留键名，值换掉）', () => {
    // 连接串整段换掉（它一定含口令），但键名留着 —— 排错时"是哪个变量"才是信息
    expect(redactDiagnostic('DATABASE_URL=postgres://u:hunter2@db:5432/x').text).toBe(
      'DATABASE_URL=<dsn>',
    )
    expect(redactDiagnostic('password: hunter2').text).toBe('password: <key>')
    expect(redactDiagnostic('secret = "abcdefgh"').text).toBe('secret = <key>')
  })

  it('裸的连接串也整段换掉（口令通常在 URL 里，不在 key=value 里）', () => {
    const result = redactDiagnostic('connect failed: postgres://app:hunter2@127.0.0.1:5432/tenon')
    expect(result.text).toBe('connect failed: <dsn>')
    expect(result.rules).toContain('dsn')
  })

  it('URL 只留 origin 与路径，query 换掉', () => {
    const result = redactDiagnostic('GET https://api.internal.example.com/v1/run?token=abc&x=1 502')
    expect(result.text).toBe('GET https://api.internal.example.com/v1/run?<query> 502')
    expect(result.rules).toContain('url-query')
  })

  it('长 base64 换掉（JWT 中段、签名）', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'
    expect(redactDiagnostic(`jwt ${jwt}`).text).toBe('jwt <blob>')
  })

  /** 反例：这三样必须原样留着，否则报告就没用了 */
  it('不脱 git sha、系统路径、版本号', () => {
    const input =
      'commit 051d342a1b2c3d4e5f60718293a4b5c6d7e8f901 from /usr/local/lib/node_modules/vite/dist, v22.22.2'
    expect(redactDiagnostic(input).text).toBe(input)
  })

  it('普通文本一个字符都不动', () => {
    const input = 'Error: cannot find module typebox while starting the preview'
    const result = redactDiagnostic(input)
    expect(result.text).toBe(input)
    expect(result.count).toBe(0)
    expect(result.rules).toEqual([])
  })

  it('没给 home / appDir 时不会因为空串把整段文本吃掉', () => {
    const result = redactDiagnostic('hello world', { home: '', appDir: '   ' })
    expect(result.text).toBe('hello world')
    expect(result.count).toBe(0)
  })

  it('多条规则叠加时计数累加（界面要显示"脱敏了几处"）', () => {
    const result = redactDiagnostic('jack@example.com at /Users/jack/x with sk-abcdefghijklmnopqrst', {
      home: '/Users/jack',
    })
    expect(result.count).toBeGreaterThanOrEqual(3)
    expect(result.rules).toEqual(expect.arrayContaining(['home', 'email', 'api-key']))
  })
})
