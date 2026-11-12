/**
 * 预览工具（M4 第 4 步）：**e2e 子 Agent 用真实浏览器里的页面自验收**。
 *
 * 为什么不是"读源码 + 猜"：源码对了不等于页面对了 —— 样式被覆盖、文案写死成旧值、
 * `onClick` 绑到没渲染的节点上，源码全都看不出来。DoD ① 要的是"能发现并修复一个
 * 注入的 bug"，而注入的 bug 恰恰就是这类。
 *
 * 三个刻意的取舍：
 *
 * 1. **只有 e2e 角色拿到这些工具**（`roles.ts` 的白名单）。主角色有 `bash`，
 *    能做的事比这四个工具多得多；把它们塞给主角色只会让它绕过"改代码"去做"点页面"。
 * 2. **断言失败不是工具错误**。`preview_assert` 返回 `isError: false` + 一段
 *    "✗ 期望 X，实测 Y"。把它当错误会让模型去重试工具，而它真正该做的是回去改代码。
 *    只有"选择器写错了""页面没连上"才算错误。
 * 3. **这里不 import `@tenon/gateway`**。依赖方向是 `server → gateway` 与
 *    `server → agent`，agent 反过来依赖 gateway 会让"只跑 agent 单测"变成要拉起整个
 *    网关。所以只声明一个**结构上刚好够用**的窄接口，网关那边的 `PageBridge` 天然满足它
 *    （多出来的方法不影响赋值）—— 真正的接线在 server 里做。
 */
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { defineExtension } from '@earendil-works/pi-durable'
import { Type } from 'typebox'

export const PREVIEW_EXTENSION = 'tenon.preview'

/**
 * 命令名与 `@tenon/gateway` 的 `PageCommandName` 是同一套字符串。
 * 刻意各写一份：跨包共享一个类型就得让 agent 依赖 gateway（见文件头第 3 条）。
 */
export type PageCommandName = 'read' | 'assert' | 'click' | 'type' | 'navigate'

export interface PageCommandResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly errors?: string[]
}

export interface PageDriverInfo {
  readonly path: string
  readonly title: string
}

/** 网关 `PageBridge` 的结构子集（`run` 的第三个参数在那边还有更多字段，无妨） */
export interface PageDriver {
  readonly info: PageDriverInfo | null
  run(
    name: PageCommandName,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number; waitMs?: number },
  ): Promise<PageCommandResult>
  navigate(path: string, timeoutMs?: number): Promise<PageDriverInfo>
}

export type PageDriverProvider = (appId: string) => PageDriver | undefined

export interface PreviewToolsOptions {
  appId: string
  /** 懒取：预览可能还没起（甚至永远不起），扩展本身要在那之前就装好 */
  getDriver: PageDriverProvider
}

const DEFAULT_ASSERT_TIMEOUT = 3000
const MAX_ASSERT_TIMEOUT = 15_000

function text(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function errorResult(message: string): { isError: true; output: { type: 'text'; text: string }[] } {
  return { isError: true, output: [text(message)] }
}

/** 页面里的报错跟在每条结果后面 —— 这就是"发现了什么不对"的第一手证据 */
function withErrors(body: string, errors: readonly string[] | undefined): string {
  if (errors === undefined || errors.length === 0) return body
  return `${body}\n\nPage errors:\n${errors.map((line) => `  - ${line}`).join('\n')}`
}

function describeValue(value: unknown): string {
  if (value === undefined) return '(no value returned)'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function createPreviewTools(options: PreviewToolsOptions): ToolRegistration[] {
  const driver = (): PageDriver | undefined => options.getDriver(options.appId)
  const missing = (): { isError: true; output: { type: 'text'; text: string }[] } =>
    errorResult(
      'This app has no preview running. Ask the user to open the preview (or wait for the dev server), then try again — ' +
        'these tools can only drive a page that is already open; they do not start a browser themselves.',
    )

  const read: ToolRegistration = {
    name: 'preview_read',
    description:
      'Read the visible text of the running preview page (what a user would see). ' +
      'Use it before asserting, so you know the real copy instead of guessing it from source. ' +
      'Pass `selector` to read one region instead of the whole page.',
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: 'CSS selector; omit to read the whole page' })),
      maxChars: Type.Optional(Type.Number({ description: 'Truncate the text (default 3000)' })),
    }),
    replay: 'safe',
    async execute(args) {
      const page = driver()
      if (page === undefined) return missing()
      const input = args as { selector?: string; maxChars?: number }
      const result = await page.run('read', {
        ...(input.selector === undefined ? {} : { selector: input.selector }),
        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
      })
      if (!result.ok) return errorResult(`Could not read the page: ${result.error ?? 'unknown reason'}`)
      const value = (result.value ?? {}) as {
        title?: string
        path?: string
        text?: string
        truncated?: boolean
      }
      const header = `${value.title ?? ''} — ${value.path ?? ''}`
      const body = (value.text ?? '').trim()
      return {
        output: [
          text(
            withErrors(
              `${header}\n\n${body === '' ? '(no visible text on the page)' : body}${value.truncated === true ? '\n… (truncated)' : ''}`,
              result.errors,
            ),
          ),
        ],
      }
    },
  }

  const assert: ToolRegistration = {
    name: 'preview_assert',
    description:
      'Assert against the running preview and get the observed value back. ' +
      'Give `text` (page must contain it), `selector` (element must exist / `count` of them), ' +
      'or `value` (an input must hold it). Retries until `timeoutMs` so a re-render does not fail it. ' +
      'A failed assertion is a normal answer, not an error: read the observed value and fix the code.',
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: 'CSS selector that must exist' })),
      text: Type.Optional(Type.String({ description: 'Text the page (or the selector) must contain' })),
      count: Type.Optional(Type.Number({ description: 'Exact number of elements matching `selector`' })),
      value: Type.Optional(Type.String({ description: 'Exact value an input/textarea must hold (needs `selector`)' })),
      timeoutMs: Type.Optional(Type.Number({ description: `Retry window, default ${DEFAULT_ASSERT_TIMEOUT}ms` })),
    }),
    replay: 'safe',
    async execute(args) {
      const page = driver()
      if (page === undefined) return missing()
      const input = args as {
        selector?: string
        text?: string
        count?: number
        value?: string
        timeoutMs?: number
      }
      const hasSelector = typeof input.selector === 'string' && input.selector !== ''
      if (!hasSelector && typeof input.text !== 'string' && typeof input.count !== 'number') {
        return errorResult('An assertion needs at least one condition: `selector` / `text` / `count` (`value` needs `selector`)')
      }
      if (!hasSelector && (typeof input.value === 'string' || typeof input.count === 'number')) {
        return errorResult('`value` and `count` only make sense together with `selector`')
      }
      const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_ASSERT_TIMEOUT, MAX_ASSERT_TIMEOUT)
      const result = await page.run(
        'assert',
        {
          ...(hasSelector ? { selector: input.selector } : {}),
          ...(typeof input.text === 'string' ? { text: input.text } : {}),
          ...(typeof input.count === 'number' ? { count: input.count } : {}),
          ...(typeof input.value === 'string' ? { value: input.value } : {}),
          timeoutMs,
        },
        // 页面里自己会重试到 timeoutMs，命令超时要比它宽，否则我们先把线掐了
        { timeoutMs: timeoutMs + 4000 },
      )
      if (!result.ok) {
        return errorResult(`The assertion could not run: ${result.error ?? 'unknown reason'}`)
      }
      const value = (result.value ?? {}) as { pass?: boolean; seen?: Record<string, unknown> }
      const expectations: string[] = []
      if (hasSelector && typeof input.count === 'number') expectations.push(`${input.selector} has ${input.count} elements`)
      else if (hasSelector) expectations.push(`${input.selector} exists`)
      if (typeof input.text === 'string') expectations.push(`contains the text "${input.text}"`)
      if (typeof input.value === 'string') expectations.push(`${input.selector ?? ''} has the value "${input.value}"`)
      const expected = expectations.join('; ')
      const seen = describeValue(value.seen ?? {})

      if (value.pass === true) {
        return { output: [text(withErrors(`✓ Assertion passed: ${expected}\nobserved: ${seen}`, result.errors))] }
      }
      return {
        output: [
          text(
            withErrors(
              `✗ Assertion failed: ${expected}\nobserved: ${seen}\n` +
                'This means the page does not match the expectation — the tool itself worked. Go back to the source, fix it, then assert again.',
              result.errors,
            ),
          ),
        ],
      }
    },
  }

  const click: ToolRegistration = {
    name: 'preview_click',
    description:
      'Click an element in the preview by CSS selector (real click, same event path as a user). ' +
      'Returns what was clicked. Use `index` when several elements match.',
    parameters: Type.Object({
      selector: Type.String({ description: 'CSS selector of the element to click' }),
      index: Type.Optional(Type.Number({ description: 'Which match to click (0-based, default 0)' })),
    }),
    replay: 'unsafe',
    async execute(args) {
      const page = driver()
      if (page === undefined) return missing()
      const input = args as { selector?: string; index?: number }
      if (typeof input.selector !== 'string' || input.selector === '') {
        return errorResult('Missing `selector`: tell me which element to click')
      }
      const result = await page.run('click', {
        selector: input.selector,
        ...(input.index === undefined ? {} : { index: input.index }),
      })
      if (!result.ok) return errorResult(`Could not click: ${result.error ?? 'unknown reason'}`)
      const value = (result.value ?? {}) as { clicked?: string }
      return { output: [text(withErrors(`Clicked ${value.clicked ?? input.selector}`, result.errors))] }
    },
  }

  const type: ToolRegistration = {
    name: 'preview_type',
    description:
      'Type into an input/textarea in the preview (works with React controlled inputs: dispatches input+change). ' +
      'Set `submit` to also press Enter and submit the surrounding form.',
    parameters: Type.Object({
      selector: Type.String({ description: 'CSS selector of the input' }),
      value: Type.String({ description: 'Text to put in it' }),
      submit: Type.Optional(Type.Boolean({ description: 'Press Enter / submit the form afterwards' })),
    }),
    replay: 'unsafe',
    async execute(args) {
      const page = driver()
      if (page === undefined) return missing()
      const input = args as { selector?: string; value?: string; submit?: boolean }
      if (typeof input.selector !== 'string' || input.selector === '') {
        return errorResult('Missing `selector`: tell me which input to type into')
      }
      if (typeof input.value !== 'string') return errorResult('Missing `value`')
      const result = await page.run('type', {
        selector: input.selector,
        value: input.value,
        submit: input.submit === true,
      })
      if (!result.ok) return errorResult(`Could not type: ${result.error ?? 'unknown reason'}`)
      const value = (result.value ?? {}) as { value?: string; typed?: string }
      return {
        output: [
          text(
            withErrors(
              `Typed into ${value.typed ?? input.selector}; it now holds "${value.value ?? ''}"` +
                (input.submit === true ? ' (and submitted)' : ''),
              result.errors,
            ),
          ),
        ],
      }
    },
  }

  const open: ToolRegistration = {
    name: 'preview_open',
    description:
      'Navigate the preview to a path (e.g. "/items") and wait until the new page is up. ' +
      'Use it to reach a route before asserting on it.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to open, starting with /' }),
    }),
    replay: 'unsafe',
    async execute(args) {
      const page = driver()
      if (page === undefined) return missing()
      const input = args as { path?: string }
      const path = typeof input.path === 'string' ? input.path.trim() : ''
      if (path === '') return errorResult('Missing `path` (e.g. /items)')
      const info = await page.navigate(path.startsWith('/') ? path : `/${path}`)
      return { output: [text(`Opened ${info.path} (${info.title})`)] }
    },
  }

  return [read, assert, click, type, open]
}

/**
 * 扩展只装工具，**不带 section**。
 *
 * 理由：section 会进**装了这个扩展的**会话的系统提示词，而这个扩展是装在 registry 上的
 * （为了让 e2e 子会话能按名字挑到工具），主角色并没有被授予这些工具。给它一段
 * "你去验页面"的说明，它就会去调一个自己没有的工具。使用说明因此写在角色的
 * `instructions` 里（`roles.ts` 是提示词的唯一事实来源）。
 */
export function previewExtension(options: PreviewToolsOptions): Extension {
  return defineExtension({
    name: PREVIEW_EXTENSION,
    tools: createPreviewTools(options),
  })
}
