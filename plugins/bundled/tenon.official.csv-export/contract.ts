/**
 * 导出 CSV 的契约。
 *
 * 为什么是 CSV 而不是 .xlsx：xlsx 要引一个几 MB 的库（还带许可证问题），而 CSV 是
 * Excel / Numbers / Sheets 都能直接打开的格式。组件清单里写清这件事，比事后解释便宜。
 */
import { Type } from 'typebox'
import { hostNamed, method, remote } from '@earendil-works/chord'

export type Principal = { readonly appId: string }

export const CSV_EXPORT_TYPE = 'tenon.official.csv-export'

export const ExportTable = remote(CSV_EXPORT_TYPE, {
  version: 1,
  input: Type.Object({ appId: Type.String() }),
  host: hostNamed('server'),
  variants: {
    user: {
      state: {
        /** `idle` | `done` —— 界面靠它显示"导出了几个文件" */
        phase: Type.String(),
        /** 最近一次导出的文件名 */
        lastFile: Type.String(),
        /** 最近一次导出的数据行数 */
        rows: Type.Number(),
      },
      methods: {
        /**
         * 生成 CSV。**数据由页面给**（组件不碰数据库：它的 permissions 是空的），
         * 服务端只负责"把二维数组变成一个合法的 CSV 文本"。
         */
        export: method(
          Type.Object({
            filename: Type.String(),
            columns: Type.Array(Type.String()),
            rows: Type.Array(Type.Array(Type.String())),
          }),
          Type.Object({ csv: Type.String(), bytes: Type.Number() }),
        ),
      },
    },
  },
})
