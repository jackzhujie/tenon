/**
 * 导出 CSV 的服务端半边。
 *
 * 它只做一件事：把「表头 + 二维数组」变成一段合法的 CSV。**不碰数据库、不碰文件系统** ——
 * 组件清单里 `permissions` 是空的，这是它拿不到那些能力的唯一原因（不是靠自觉）。
 *
 * 三个必须做对的细节（CSV 的坑全在转义上，错了 Excel 会显示成一片错位）：
 * 1. 含逗号 / 引号 / 换行的字段要包双引号，内部的双引号写成两个；
 * 2. 行内字段数与表头不一致 → 拒绝（`invalid`），而不是硬拼一份对不齐的表；
 * 3. 开头写 UTF-8 BOM：不写的话 Excel 打开中文是乱码，而用户会以为是"导出功能坏了"。
 */
import { Type } from 'typebox'
import { invalid, type Host } from '@earendil-works/chord'
import { ExportTable, type Principal } from './contract.js'

export interface ActivateInput {
  readonly host: Host<Principal>
  readonly appId: string
  readonly brain: { complete(input: { appId: string; text: string }): Promise<string> }
  readonly log?: (line: string) => void
}

const LINGER_MS = 10 * 60_000

/** RFC 4180 的转义：只在需要时加引号，内部引号翻倍 */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** BOM + 表头 + 行。BOM 不是装饰：没有它 Excel 会把 UTF-8 中文读成乱码 */
export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.map(csvField).join(',')]
  for (const row of rows) lines.push(row.map(csvField).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

function safeName(raw: string): string {
  const base = raw.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.csv$/i, '')
  return `${base === '' ? 'export' : base}.csv`
}

export function activate(input: ActivateInput): void {
  const { host, appId, log } = input

  host.serve(
    ExportTable,
    ({ appId: inputAppId }, principal, self) => {
      if (inputAppId !== appId || principal.appId !== appId) {
        throw invalid('principal', `这个组件属于应用 ${appId}，不是 ${inputAppId}`)
      }
      const phase = self.state('phase', Type.String(), 'idle')
      const lastFile = self.state('lastFile', Type.String(), '')
      const rowsState = self.state('rows', Type.Number(), 0)

      return {
        variant: 'user',
        phase,
        lastFile,
        rows: rowsState,

        export: async ({ filename, columns, rows }, ctx) => {
          if (columns.length === 0) throw invalid('empty', '这张表没有表头，导不出 CSV')
          const wrong = rows.findIndex((row) => row.length !== columns.length)
          if (wrong !== -1) {
            throw invalid(
              'shape',
              `第 ${wrong + 1} 行有 ${rows[wrong]?.length ?? 0} 列，表头是 ${columns.length} 列 —— 导出会错位`,
            )
          }
          const file = safeName(filename)
          const csv = toCsv(columns, rows)
          phase.replace(ctx, 'done')
          lastFile.replace(ctx, file)
          rowsState.replace(ctx, rows.length)
          log?.(`[csv-export] ${appId} 导出 ${file}（${rows.length} 行）`)
          return { csv, bytes: Buffer.byteLength(csv, 'utf8') }
        },
      }
    },
    { linger: LINGER_MS },
  )
}
