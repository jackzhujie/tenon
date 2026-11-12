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
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  renderMessage,
  setLocale as setProcessLocale,
  type Locale,
  type MessageParams,
} from '@tenon/protocol/locale'
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

/*
 * `Locale` / `LOCALES` / `isLocale` / `MessageParams` 都来自协议层：
 * 服务端也要按同一种语言说话，"支持哪两种语言"这件事只能有一处定义。
 */
export { LOCALES, isLocale } from '@tenon/protocol/locale'
export type { Locale, MessageParams } from '@tenon/protocol/locale'

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

const TABLES: Record<Locale, Record<MessageKey, string>> = { en, zh }

export type TFunction = (key: MessageKey, params?: MessageParams) => string

/**
 * 取一条文案。
 *
 * 插值与单复数的**实现**在协议层（`renderMessage`）：服务端也用它，两套规则各写一份
 * 会漂移成"网页把 `1 files` 写成 `1 file`、服务端不会"。这里只负责挑表。
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return renderMessage(TABLES[locale], locale, key, params)
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

interface I18nValue {
  locale: Locale
  t: TFunction
  setLocale(locale: Locale): void
}

/*
 * "此刻的语言"在协议层（`@tenon/protocol/locale`）—— 服务端也说同一种话，
 * 两个进程各存一份必然对不上。这里只把它转出去，给非组件代码（`lib/rpc.ts`
 * 的网络错误、hook 里的提前返回）用。
 */
export { getLocale } from '@tenon/protocol/locale'

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
   * 首屏的值由 `main.tsx` 在 render 之前写进协议层（它已经把设置读出来了），
   * 这里只管**切换**。用 effect 不是为了等一帧，是为了不在 render 里写模块级状态 ——
   * 那个写法 lint 会拦（`react-hooks/globals`），而且真会在并发渲染下写错。
   */
  useEffect(() => {
    setProcessLocale(locale)
  }, [locale])

  const setLocale = useCallback(
    (next: Locale) => {
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
