/**
 * 界面语言（i18n）。
 *
 * ## 为什么自己写而不上 i18next
 *
 * 用得到的只有两件：**插值**（`{count}`）和**复数**（英文 one / other）。
 * i18next 那套 namespace / 后端加载 / 插件体系在这里一个都用不上，却要带进来 ~40KB 运行时
 * —— 而 `build:web` 现在总共 322KB。
 *
 * 更要紧的是**类型安全**：`key` 的类型由英文表推导，写成受限联合类型。
 * `t('release.titel')` 拼错一个字母，`tsc` 当场报错；用 i18next 时那是运行时才在黑框里
 * 看到的问题。三百多个 key 的规模上，这个差别就是"敢不敢重构"。
 *
 * ## 语言从哪来
 *
 * 真相在服务端（`settings` 的 `ui.locale`），但首屏读它要一次异步往返，
 * 于是先看 `localStorage` 缓存（同步，不闪），读到设置再对齐。默认跟随系统语言，
 * 认不出来时**英文兜底** —— 国际化产品的默认值不该是中文。
 *
 * ## 文案表怎么组织
 *
 * `messages/<feature>.ts` 每个文件一对 `en` / `zh`，键是**扁平**的 `feature.thing.detail`。
 * 中文表声明为 `Record<Key, string>`，少一条编译期就报错（不会出现"英文界面里夹一句中文"）。
 *
 * 复数只写两个键：**基础键 = 复数形式**，额外的 `<key>.one` = 单数形式。
 * 这样 `t('chat.versions', { count })` 的类型是自然的，单数时自动落到 `.one`。
 * 中文没有单复数，`.one` 写同一句。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { appsEn, appsZh } from './messages/apps.js'
import { chatEn, chatZh } from './messages/chat.js'
import { diffEn, diffZh } from './messages/diff.js'
import { logsEn, logsZh } from './messages/logs.js'
import { pluginsEn, pluginsZh } from './messages/plugins.js'
import { previewEn, previewZh } from './messages/preview.js'
import { releaseEn, releaseZh } from './messages/release.js'
import { settingsEn, settingsZh } from './messages/settings.js'
import { usageEn, usageZh } from './messages/usage.js'
import { shellEn, shellZh } from './messages/shell.js'

export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

/** 英文表是基准：所有 key 与它的形状绑定 */
const en = {
  ...shellEn,
  ...chatEn,
  ...diffEn,
  ...releaseEn,
  ...appsEn,
  ...logsEn,
  ...previewEn,
  ...settingsEn,
  ...pluginsEn,
  ...usageEn,
} as const

export type MessageKey = keyof typeof en

/** 中文表必须覆盖每一个 key —— 少一条 `tsc` 就报 */
const zh: Record<MessageKey, string> = {
  ...shellZh,
  ...chatZh,
  ...diffZh,
  ...releaseZh,
  ...appsZh,
  ...logsZh,
  ...previewZh,
  ...settingsZh,
  ...pluginsZh,
  ...usageZh,
}

export type MessageParams = Record<string, string | number>

const TABLES: Record<Locale, Record<MessageKey, string>> = { en, zh }

/** 英文单复数：只有 1 用 `one`，其余 `other`（中文没有这一层） */
function pluralSuffix(locale: Locale, count: number): 'one' | 'other' {
  if (locale !== 'en') return 'other'
  return count === 1 ? 'one' : 'other'
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

export type TFunction = (key: MessageKey, params?: MessageParams) => string

/**
 * 取一条文案。
 *
 * 带 `count` 时先找 `<key>.one` / `<key>.other`，没有就退回 `<key>` ——
 * 这样"只有一个版本"的句子不用为复数拆两遍。
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const table = TABLES[locale]
  const count = params?.['count']
  if (typeof count === 'number') {
    const variant = `${key}.${pluralSuffix(locale, count)}` as MessageKey
    if (variant in table) return interpolate(table[variant], params)
  }
  return interpolate(table[key], params)
}

/** 系统语言 → 我们支持的两种；认不出来一律英文（国际化产品的默认值不该是中文） */
export function detectLocale(): Locale {
  const language =
    typeof navigator === 'undefined' ? '' : (navigator.languages?.[0] ?? navigator.language ?? '')
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 同步缓存：首屏先用它，避免"先中文再变英文"的闪动 */
const CACHE_KEY = 'tenon.locale'

export function readCachedLocale(): Locale | null {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return value === 'en' || value === 'zh' ? value : null
  } catch {
    return null
  }
}

export function cacheLocale(locale: Locale): void {
  try {
    localStorage.setItem(CACHE_KEY, locale)
  } catch {
    // 隐私模式下 localStorage 会抛；缓存只是省一次闪动，丢了不影响功能
  }
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh'
}

interface I18nValue {
  locale: Locale
  t: TFunction
  setLocale(locale: Locale): void
}

/**
 * 当前语言。**给非组件代码用**（`lib/rpc.ts` 的网络错误、`hooks/useWorkspace.ts` 的
 * 提前返回）：那些地方没有 hook 可调，又不能把整句话留成中文。
 *
 * 这是刻意接受的"第二处真相"：它只在一处被写（Provider 的 setLocale），
 * 且只读不参与渲染 —— 语言切换后重新渲染的仍然是 Context。
 */
let activeLocale: Locale = 'en'

/** 非组件代码取当前语言（配合 `translate`） */
export function getLocale(): Locale {
  return activeLocale
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({
  initial,
  onLocaleChange,
  children,
}: {
  initial: Locale
  /** 切换后回调（用来写进服务端设置）；不传就只改内存 */
  onLocaleChange?(locale: Locale): void
  children: ReactNode
}) {
  const [locale, setLocaleState] = useState<Locale>(initial)
  /*
   * 首屏就把全局值对齐，别等到第一次切换 —— 否则第一次渲染后到点切换之间，
   * `getLocale()` 读到的还是 'en'（非组件代码里的错误消息会用错语言）。
   *
   * 这两处赋值被 lint 的 `react-hooks/globals` 盯着，但它是**有意的**：
   * 非组件代码（rpc 的网络错误、hook 里的提前返回）没有 hook 可调，
   * 又必须拿到当前语言。只写这一处、只读不参与渲染，切换后重新渲染的仍是 Context。
   */
  // eslint-disable-next-line react-hooks/globals -- 见上：给非组件代码读的镜像值
  activeLocale = locale

  const setLocale = useCallback(
    (next: Locale) => {
      activeLocale = next
      setLocaleState(next)
      cacheLocale(next)
      onLocaleChange?.(next)
    },
    [onLocaleChange],
  )

  const value = useMemo<I18nValue>(
    () => ({ locale, t: (key, params) => translate(locale, key, params), setLocale }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * 组件里取文案。
 *
 * 没有 Provider 时**不抛错**，直接返回英文表 —— 测试里渲染单个组件是常态，
 * 为了"忘记包 Provider"就让测试全红，代价大于收益（而英文兜底正是产品的默认）。
 */
export function useT(): I18nValue {
  const value = useContext(I18nContext)
  return (
    value ?? {
      locale: 'en',
      t: (key, params) => translate('en', key, params),
      setLocale: () => undefined,
    }
  )
}

/** 给非组件代码（纯函数、事件处理）用：只要拿到 locale 就够了 */
export function makeT(locale: Locale): TFunction {
  return (key, params) => translate(locale, key, params)
}
