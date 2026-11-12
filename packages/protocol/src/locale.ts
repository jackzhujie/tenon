/**
 * 界面语言的**内核**：插值、复数、以及"现在是什么语言"。
 *
 * 为什么在 protocol：说人话的地方不止网页。服务端（错误消息）、agent（门禁摘要）、
 * gateway（预览失败原因）都要按同一个语言说话，而它们都能依赖本包 —— 这是唯一
 * 一个它们都够得着的地方（依赖方向：`protocol` ← 全部）。
 *
 * 两套规则各写一份的后果很具体：网页把 `{count} files` 变成 `1 file`，服务端却写成
 * `1 files`，同一个界面上两种语法。所以插值与单复数只在这里实现一次，
 * 网页那边的 `lib/i18n.tsx` 把表传进来复用（见 `renderMessage`）。
 *
 * 语言的**真相**是服务端设置（`ui.locale`），本文件只持有"此刻的值"：
 * - 服务端启动时从 settings 读一次，用户切换时更新（`packages/server/src/index.ts`）
 * - 网页在 `I18nProvider` 里同步同一个值（它自己也要读一次 settings 才能首屏不闪）
 *
 * 进程级单例是有意的：语言是**进程级偏好**，一个进程一个用户，没有并发请求要区分语言。
 * 把它做成依赖注入会要求 79 个抛出点各自接一条 `t` 的来源，而它们没有一个是"每次调用
 * 语言都不同"的场景。
 */

export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh'
}

/**
 * `zh-CN` / `zh-Hans-CN` / `en_US` → 我们支持的两种。
 *
 * 认不出来一律**英文**：这是国际化产品的默认值，不该是中文。`navigator.language`
 * 给的是大写的区域码，`Intl` 的 `resolvedOptions().locale` 可能带下划线，两种都要吃。
 */
export function normalizeLocale(tag: string | null | undefined): Locale {
  if (typeof tag !== 'string') return 'en'
  return tag.toLowerCase().replace('_', '-').startsWith('zh') ? 'zh' : 'en'
}

export type MessageParams = Record<string, string | number>

/** 文案表：键 → 句子。`en` 是基准，`zh` 必须逐键覆盖（类型上强制） */
export type MessageTable = Record<string, string>

function interpolate(template: string, params: MessageParams | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

/**
 * 取一条文案。
 *
 * 复数只写两个键：**基础键 = 复数形式**，额外的 `<key>.one` = 单数。
 * 于是 `t('chat.versions', { count })` 的类型是自然的，单数自动落到 `.one`；
 * 中文没有单复数，`.one` 写同一句（或者干脆不写，缺席就退回基础键）。
 *
 * `count` 不是数字时不走复数分支 —— 调用方偶尔会把 `"20+"` 这种已经格式化好的
 * 字符串塞进来（"至少 N 个版本"），那时候单复数已经不重要了。
 */
export function renderMessage(
  table: MessageTable,
  locale: Locale,
  key: string,
  params?: MessageParams,
): string {
  const count = params?.['count']
  if (typeof count === 'number' && locale === 'en') {
    const variant = count === 1 ? `${key}.one` : `${key}.other`
    if (variant in table) return interpolate(table[variant]!, params)
    // 没写 `.other` 时退回基础键（基础键就是复数形式）
  }
  const template = table[key]
  // 键由类型系统守着；真漏了（旧版本前端 + 新服务端）也不要抛 —— 报错消息再抛错最难查
  if (template === undefined) return key
  return interpolate(template, params)
}

/**
 * 此刻的语言。默认英文：没有设置过、读设置失败、字段被人手改坏，都落到这里。
 *
 * 注意它**不是**"用户偏好"，而是"当前进程该说什么话"。设置是偏好的真相，
 * 这里是它在内存里的投影。
 */
let activeLocale: Locale = 'en'

export function getLocale(): Locale {
  return activeLocale
}

/** 只在服务端启动、设置变更、网页 Provider 初始化这三处调用 */
export function setLocale(locale: Locale): void {
  activeLocale = locale
}
