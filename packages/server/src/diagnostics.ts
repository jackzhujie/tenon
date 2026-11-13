/**
 * 诊断报告 —— 用户点「诊断信息」时给他看的那份东西。
 *
 * ## 它存在的理由
 *
 * 用户装了应用、用不起来，然后**不吭声地卸掉**。这是桌面软件最贵的失败形态，
 * 而开发者手里什么都没有：没有请求日志、没有崩溃计数、没有系统版本。
 *
 * 自动遥测能解，但这个产品的承诺是"本地优先、可自托管" —— 一个默认就往外发东西的
 * 版本，把那句话打了个折。所以走另一条路：**出问题时，用户按一下，看着原文决定发不发**。
 *
 * ## 三条边界
 *
 * 1. **不发应用名与业务内容**：应用叫什么（"客户合同管理"）本身就是生意。
 *    报告里只有环境 + 脱敏后的错误行，没有 `appId`、没有仓库内容。
 * 2. **脱敏只有一份实现**（`@tenon/core` 的 `redactDiagnostic`）——
 *    让界面各处自己拼，迟早有一处忘了脱。
 * 3. **报告是纯文本**：界面原样摊开给人看。结构化再渲染的话，人看到的就不是
 *    真正要发出去的东西。
 *
 * ## 为什么 `text` 里带 `format`
 *
 * 这份东西会通过 Issue、聊天、邮件到人手里，中间可能被转发好几次。带一个格式版本号，
 * 半年后收到一份报告时能知道怎么读它，而不是去猜"那时候有哪些字段"。
 */
import { homedir } from 'node:os'
import { appPaths, redactDiagnostic, type CoreServices } from '@tenon/core'
import { getLocale, type LogEntry } from '@tenon/protocol'

export const DIAGNOSTICS_FORMAT = '1'

/** 单行上限：一行几百字符之外的堆栈没人读，只会把报告撑爆 */
const MAX_LINE = 400
/** 每条错误最多带几行 detail（堆栈前几行就够定位，后面全是框架内部） */
const MAX_DETAIL_LINES = 12
/** 整份报告的上限：Issue 的输入框、聊天窗口都吃不下更多 */
const MAX_CHARS = 20_000

export interface BuildDiagnosticsOptions {
  readonly version: string
  readonly core: CoreServices
  /** 只用来算应用目录（好在脱敏时整段换成 `<app>`），不会写进报告 */
  readonly appId: string | undefined
  /** 已经筛过的错误日志（调用方决定取多少、什么级别） */
  readonly entries: readonly LogEntry[]
}

export interface DiagnosticsReport {
  readonly text: string
  /** 替换了几处：界面显示「已脱敏 N 处」 */
  readonly redactions: number
  readonly format: string
}

function oneLine(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, ' / ').trim()
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE)}…` : flat
}

export function buildDiagnostics(options: BuildDiagnosticsOptions): DiagnosticsReport {
  const { version, core, appId, entries } = options
  const home = homedir()
  const appDir = appId === undefined ? undefined : appPaths(core.home, appId).repoDir

  let redactions = 0
  const redact = (value: string): string => {
    const result = redactDiagnostic(value, {
      home,
      ...(appDir === undefined ? {} : { appDir }),
    })
    redactions += result.count
    return result.text
  }

  const lines: string[] = [
    `Tenon diagnostics (format ${DIAGNOSTICS_FORMAT})`,
    '',
    `version:  ${version}`,
    `platform: ${process.platform} ${process.arch}`,
    `node:     ${process.versions.node}`,
    `electron: ${(process.versions as Record<string, string | undefined>)['electron'] ?? '-'}`,
    `locale:   ${getLocale()}`,
    // UTC：本地时区能反推出所在地区，而排错只需要"一条时间线"
    `time:     ${new Date().toISOString()}`,
    '',
    '--- recent warnings and errors (oldest first) ---',
  ]

  if (entries.length === 0) {
    lines.push('(nothing logged)')
  }

  let truncated = false
  /** 边拼边数：每轮再 `join` 一次去量长度，报告越长越慢，而且没必要 */
  let size = lines.reduce((sum, line) => sum + line.length + 1, 0)

  for (const entry of entries) {
    if (size > MAX_CHARS) {
      truncated = true
      break
    }
    const head = `[${new Date(entry.at).toISOString()}] ${entry.source}/${entry.level}: ${oneLine(redact(entry.message))}`
    lines.push(head)
    size += head.length + 1
    if (entry.detail !== null && entry.detail.trim() !== '') {
      const detail = entry.detail.split('\n').slice(0, MAX_DETAIL_LINES)
      for (const row of detail) {
        const line = `    ${oneLine(redact(row))}`
        lines.push(line)
        size += line.length + 1
      }
    }
  }

  if (truncated) lines.push('… truncated (report size limit)')

  return { text: `${lines.join('\n')}\n`, redactions, format: DIAGNOSTICS_FORMAT }
}
