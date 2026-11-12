/**
 * 组件（web facet）怎么知道界面语言。
 *
 * 组件的浏览器半边是**注入进应用页面的独立脚本**：它跑在网关的源上、不在 Tenon 的
 * React 树里，拿不到 i18n 的 Context，将来还可能由别人写。所以语言只能是注入时
 * 递给它的一个值 —— 与 `?appId=` 同一条通道。
 *
 * 这套约定有三个使用方，**必须同源**（这三个常量放这里就是为了它）：
 * - 网关：注入 HTML 时把语言写进 `window[COMPONENT_LOCALE_GLOBAL]`，并挂一个
 *   `message` 监听，收到 `COMPONENT_LOCALE_MESSAGE` 时改全局 + 派发事件
 * - Tenon 界面：用户切语言后往预览 iframe `postMessage({type: COMPONENT_LOCALE_MESSAGE, locale})`
 * - 组件自己：读全局拿首屏语言，听 `COMPONENT_LOCALE_EVENT` 重画文案
 *
 * 写成 `tenon:locale` 而不是 `tenon-component-locale`：它已经是页面里的公开约定，
 * 短名字利于别人写组件时记住。
 */
export const COMPONENT_LOCALE_GLOBAL = '__tenonLocale'
/** 父页面 postMessage 的 `type`（也用作事件名，见下） */
export const COMPONENT_LOCALE_MESSAGE = 'tenon:locale'
/**
 * 组件监听的 DOM 事件名。
 *
 * 为什么与 message 同名：注入的引导脚本收到消息后会派发一个同名的 `CustomEvent`，
 * 组件只写一个 `addEventListener` 就够；查日志时也不必记两套名字。
 */
export const COMPONENT_LOCALE_EVENT = 'tenon:locale'
