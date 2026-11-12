/**
 * 服务端口径的文案表：一张表，两种语言，外加一个"按当前语言取句子"的入口。
 *
 * 为什么合成一张：调用方不该关心某句话属于"错误"还是"检查"。`msg('error.x')`
 * 与 `msg('check.y')` 是同一件事 —— 把一句人话填好参数交给用户。
 *
 * 为什么不把网页那份表也搬过来：网页的文案是**界面布局的一部分**（按钮、标签、
 * 空状态），跟着组件走才好改；这里的是**服务端一次性说出口的句子**。两类东西的
 * 生命周期不同，合在一起只会让两边都不敢动。共用的是**内核**（插值 / 单复数 /
 * 当前语言），那才是容易漂移的部分。
 */
import { getLocale, renderMessage, type Locale, type MessageParams, type MessageTable } from '../locale.js'
import { checksEn, checksZh, type CheckMessageKey } from './checks.js'
import { componentsEn, componentsZh, type ComponentMessageKey } from './components.js'
import { errorsEn, errorsZh, type ErrorMessageKey } from './errors.js'

const en = { ...errorsEn, ...checksEn, ...componentsEn } as const
const zh: Record<keyof typeof en, string> = { ...errorsZh, ...checksZh, ...componentsZh }

export type ServerMessageKey = keyof typeof en

const TABLES: Record<Locale, MessageTable> = { en, zh }

/** 按**当前进程语言**取一条服务端文案 */
export function msg(key: ServerMessageKey, params?: MessageParams): string {
  return renderMessage(TABLES[getLocale()], getLocale(), key, params)
}

/**
 * 指定语言取一条（测试与"与当前语言无关"的场合用）。
 *
 * 例如发布记录里存的 `gate_summary` 是**历史**，它写下时是什么语言就是什么语言 ——
 * 重新渲染旧记录会让同一条历史在切语言后变形。
 */
export function msgIn(locale: Locale, key: ServerMessageKey, params?: MessageParams): string {
  return renderMessage(TABLES[locale], locale, key, params)
}

export type { CheckMessageKey, ComponentMessageKey, ErrorMessageKey }
