/**
 * 极简文本渲染：段落 + ``` 围栏代码块。
 *
 * 为什么不上 Markdown 库：M1 的回答几乎全是「说明 + 代码块」两件东西，
 * 上一个 full Markdown 渲染器要多 40KB 依赖、还要处理 XSS（不能 `dangerouslySetInnerHTML`）。
 * 这里用正则切分，剩下的都是 React 的纯文本节点 —— 天然不存在注入问题。
 * 等 M2 真要渲染表格/列表时再换，那时渲染器还得支持 diff 视图，是另一件事。
 */
import { splitFences } from '../lib/fences.js'

export { splitFences }

export function TextBlock({ text }: { text: string }) {
  const segments = splitFences(text)
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <div
            key={index}
            className="my-2 overflow-hidden rounded-lg border border-line-soft bg-[#0a0908]"
          >
            {segment.lang !== '' && (
              <div className="border-b border-line-soft px-3 py-1 font-mono text-[10px] tracking-wide text-faint uppercase">
                {segment.lang}
              </div>
            )}
            <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-[1.7] text-[#d6cfc8]">
              <code>{segment.value}</code>
            </pre>
          </div>
        ) : (
          <p key={index} className="whitespace-pre-wrap break-words">
            {segment.value}
          </p>
        ),
      )}
    </>
  )
}
