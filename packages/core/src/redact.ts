/**
 * 诊断信息的脱敏 —— 交给用户的报告里，哪些字不能出现。
 *
 * ## 为什么这件事比报告本身重要
 *
 * Tenon 是本地优先的产品：用户的项目名、目录结构、数据库连接串、模型密钥
 * 全在这台机器上。崩溃堆栈里最常见的三样恰好都是隐私：
 *
 * - 绝对路径 → `/Users/<用户名>/project/<客户名>/...`（用户名 + 项目名一起走）
 * - 错误消息 → SQL、表名、应用名（"客户合同管理"本身就是业务信息）
 * - 配置片段 → `OPENAI_API_KEY=sk-...`、`Bearer eyJ...`
 *
 * 所以这里的原则是**宁可多脱**：脱掉的内容只是让排错多问一句，留下的内容
 * 可能就是别人不该看到的生意。
 *
 * ## 刻意**不**脱的东西（不然报告会失去全部价值）
 *
 * - 系统路径（`/usr/local/lib/node_modules/...`、`/opt/homebrew/...`）：不含用户名
 * - git sha（40 位十六进制）：它就是用来定位版本的，而 blob 规则要求出现 `+` / `/` / `=`
 * - 版本号与端口：`1.2.3` 与 `127.0.0.1:5173` 是排错必需
 *
 * ## 最后一道不是这里，是人
 *
 * 自动脱敏不可能穷尽（用户自己的业务字段名不会命中任何规则）。所以界面上
 * **发送前一定把原文摊开给人看** —— 这个函数负责"明显不该出的东西不出"，
 * 人负责"这一条我不想给"。
 */

export interface RedactOptions {
  /** 家目录的真实路径。不传就只能靠 `/Users/…` 这类模式猜 */
  readonly home?: string
  /** 应用仓库目录（`<TENON_HOME>/apps/<id>/repo`）。不传就不替换 */
  readonly appDir?: string
}

export interface RedactResult {
  readonly text: string
  /** 替换了几处。界面显示「已脱敏 N 处」，让人能确认确实处理过 */
  readonly count: number
  /** 命中的规则名（去重，按命中顺序）。测试用它断言"命中了哪条" */
  readonly rules: string[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Windows 上同一个目录可能以 `\` 或 `/` 出现在日志里，两种都得换 */
function variants(path: string): string[] {
  const forward = path.replaceAll('\\', '/')
  return forward === path ? [path] : [path, forward]
}

/**
 * `to` 是函数而不是字符串：`String.replace` 只在**传字符串**时解释 `$1`，
 * 传函数时返回值是字面量 —— 写 `'$1<key>'` 会把 `$1` 原样留在报告里。
 * 要保留前缀就在函数里拼（`groups[0]`）。
 */
interface PatternRule {
  readonly name: string
  readonly pattern: RegExp
  readonly to: (match: string, groups: readonly string[]) => string
}

/** 只脱"用户目录"，系统路径保留 —— 后者不含隐私且是排错线索 */
const PATTERNS: readonly PatternRule[] = [
  // macOS / Linux / Windows 的用户目录（家目录被精确替换之后，这里兜别处的）
  { name: 'user-path', pattern: /\/Users\/[^\s'"`]+/g, to: () => '<home>' },
  { name: 'user-path', pattern: /\/home\/[^\s'"`]+/g, to: () => '<home>' },
  { name: 'user-path', pattern: /[A-Za-z]:\\Users\\[^\s'"`]+/g, to: () => '<home>' },
  { name: 'user-path', pattern: /[A-Za-z]:\/Users\/[^\s'"`]+/g, to: () => '<home>' },

  /*
   * 数据库连接串整段换掉。它一定含口令，而口令通常不在 `password=` 这种形状里
   * （`postgres://user:hunter2@host/db`），所以要在 email 规则之前先吃整串 ——
   * 否则 `user:hunter2@host` 会被 email 规则啃掉一半，留下半截更难判断。
   */
  {
    name: 'dsn',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s'"`]+/g,
    to: () => '<dsn>',
  },

  { name: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, to: () => '<email>' },

  // 令牌：三种最常见的形状各一条（前缀本身是线索，所以 Bearer 保留前缀）
  { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: () => 'Bearer <key>' },
  { name: 'api-key', pattern: /sk-[A-Za-z0-9_-]{16,}/g, to: () => '<key>' },
  { name: 'api-key', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, to: () => '<key>' },
  {
    name: 'assignment',
    // 值里不许出现 `<`：那是占位符的开头，否则前面 `dsn` 已经换好的 `<dsn>`
    // 会被这条规则再吃一次，变成含义更少的 `<key>`
    pattern:
      /((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|database[_-]?url|dsn|connection[_-]?string)\s*[:=]\s*)["']?[^\s"',;&<]{4,}["']?/gi,
    to: (_match, groups) => `${groups[0] ?? ''}<key>`,
  },

  // URL 里的 query：常有 `?token=` 与内部域名
  {
    name: 'url-query',
    pattern: /(https?:\/\/[^\s/?#]+[^\s?#]*)\?[^\s#]*/g,
    to: (_match, groups) => `${groups[0] ?? ''}?<query>`,
  },

  /*
   * 长 blob 分两条，因为它们的特征不同：
   * - JWT 一律以 `eyJ` 开头（`{"` 的 base64），且是 base64url（含 `-` `_`）
   * - 其他签名/证书片段是标准 base64：**必须含 `+` `/` `=`** 才算，且不能从
   *   `/` 或字母中间开始 —— 否则一条长系统路径（`/usr/local/lib/node_modules/…`）
   *   会被当成 blob 整段吃掉，而它恰恰是排错要看的
   * - 40 位纯十六进制的 git sha 两条都不命中：它是用来定位版本的，必须留着
   */
  { name: 'blob', pattern: /eyJ[A-Za-z0-9_.-]{20,}/g, to: () => '<blob>' },
  {
    name: 'blob',
    pattern: /(?<![A-Za-z0-9+/\\])(?=[A-Za-z0-9+/]*[+/])[A-Za-z0-9+/]{40,}={0,2}/g,
    to: () => '<blob>',
  },
]

export function redactDiagnostic(text: string, options: RedactOptions = {}): RedactResult {
  let out = text
  let count = 0
  const rules: string[] = []

  const apply = (
    name: string,
    pattern: RegExp,
    to: (match: string, groups: readonly string[]) => string,
  ): void => {
    out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
      // 回调的最后两个参数是 offset 与整串，前面剩下的才是分组
      const groups = rest.slice(0, Math.max(0, rest.length - 2)) as string[]
      count += 1
      if (!rules.includes(name)) rules.push(name)
      return to(match, groups)
    })
  }

  /*
   * 顺序有讲究：**先 app 再 home**。
   * 应用目录通常在家目录下面（`<home>/.tenon/apps/<id>/repo`），先换 home 的话
   * 那段字符串已经不存在了，`<app>` 永远换不上 —— 结果是应用名留在报告里。
   */
  for (const name of ['app', 'home'] as const) {
    const value = name === 'home' ? options.home : options.appDir
    if (value === undefined || value.trim() === '') continue
    for (const one of variants(value)) {
      apply(name, new RegExp(escapeRegExp(one), 'g'), () => `<${name}>`)
    }
  }

  for (const rule of PATTERNS) apply(rule.name, rule.pattern, rule.to)

  return { text: out, count, rules }
}
