/**
 * 消息正文的 Markdown 渲染。
 *
 * 为什么自己写而不上 `react-markdown`：见 `lib/markdown.ts` 的头注释（体积、XSS 面、
 * 以及"未闭合围栏要当代码块"这条流式要求）。这里只负责把解析结果画成 React 节点。
 *
 * 三条渲染上的取舍：
 * 1. **标题不按网页比例**。聊天里 `##` 用 14.5px，`###` 用 13.5px —— 按 h1/h2 的
 *    默认尺寸来，一句"真正的原因"会把整屏撑开。
 * 2. **单换行保留**（`whitespace-pre-wrap`）。CommonMark 里单换行是空格，但模型写答案时
 *    是按"换行=换行"来的；按标准渲染会把它的分点挤成一坨。
 * 3. **链接只放行 http(s)**。`[x](javascript:...)` 这类在 React 里是 `href` 直通，
 *    必须在这里挡掉 —— 解析器不管协议，渲染器管。
 */
import type { ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from '../lib/markdown.js'
import { cn } from '../lib/cn.js'

const SAFE_HREF = /^https?:\/\//i

function Inlines({ parts }: { parts: Inline[] }): ReactNode {
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case 'text':
            return <span key={index}>{part.value}</span>
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-[#171310] px-1 py-px font-mono text-[0.92em] text-[#e6c9a8] ring-1 ring-line-soft/60"
              >
                {part.value}
              </code>
            )
          case 'strong':
            return (
              <strong key={index} className="font-semibold text-ink">
                <Inlines parts={part.value} />
              </strong>
            )
          case 'em':
            return (
              <em key={index} className="italic">
                <Inlines parts={part.value} />
              </em>
            )
          case 'del':
            return (
              <del key={index} className="text-faint line-through">
                <Inlines parts={part.value} />
              </del>
            )
          case 'link':
            return SAFE_HREF.test(part.href) ? (
              <a
                key={index}
                href={part.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand-soft underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
              >
                <Inlines parts={part.value} />
              </a>
            ) : (
              <span key={index}>
                <Inlines parts={part.value} />
              </span>
            )
        }
      })}
    </>
  )
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-semibold text-ink mt-1',
  2: 'text-[14.5px] font-semibold text-ink mt-1',
  3: 'text-[13.5px] font-semibold text-ink/90 mt-1',
}

function Table({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const alignClass = (index: number): string => {
    const align = block.align[index] ?? 'left'
    return align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left'
  }
  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-line-soft">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-panel-2/70">
          <tr>
            {block.head.map((cell, index) => (
              <th
                key={index}
                className={cn(
                  'border-b border-line-soft px-2.5 py-1.5 font-medium text-muted',
                  alignClass(index),
                )}
              >
                <Inlines parts={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line-soft/50 last:border-0">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn('px-2.5 py-1.5 align-top text-ink/90', alignClass(cellIndex))}
                >
                  <Inlines parts={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return (
        <p
          className={cn(
            'leading-[1.5]',
            HEADING_CLASS[block.level] ?? 'text-[13.5px] font-semibold text-ink/90 mt-1',
          )}
        >
          <Inlines parts={block.inlines} />
        </p>
      )
    case 'paragraph':
      return (
        <p className="whitespace-pre-wrap break-words">
          <Inlines parts={block.inlines} />
        </p>
      )
    case 'code':
      return (
        <div className="my-2 overflow-hidden rounded-lg border border-line-soft bg-[#0a0908]">
          {block.lang !== '' && (
            <div className="border-b border-line-soft px-3 py-1 font-mono text-[10px] tracking-wide text-faint uppercase">
              {block.lang}
            </div>
          )}
          <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-[1.7] text-[#d6cfc8]">
            <code>{block.value}</code>
          </pre>
        </div>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag
          className={cn(
            'my-1.5 space-y-0.5 pl-4',
            block.ordered ? 'list-decimal' : 'list-disc',
            'marker:text-faint',
          )}
        >
          {block.items.map((item, index) => (
            <li
              key={index}
              className={cn('pl-0.5', item.checked === undefined ? '' : 'flex list-none items-start gap-1.5')}
              style={item.depth === 0 ? undefined : { marginLeft: item.depth * 14 }}
            >
              {item.checked !== undefined && (
                <span
                  aria-hidden
                  className={cn('mt-0.5 shrink-0 text-[12px]', item.checked ? 'text-ok' : 'text-faint')}
                >
                  {item.checked ? '☑' : '☐'}
                </span>
              )}
              <span className="min-w-0 whitespace-pre-wrap break-words">
                <Inlines parts={item.inlines} />
              </span>
            </li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return <Table block={block} />
    case 'quote':
      return (
        <blockquote className="my-1.5 border-l-2 border-brand/40 pl-3 text-muted">
          <div className="space-y-1">
            {block.blocks.map((inner, index) => (
              <BlockView key={index} block={inner} />
            ))}
          </div>
        </blockquote>
      )
    case 'hr':
      return <hr className="my-3 border-line-soft" />
  }
}

export function TextBlock({ text }: { text: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className="space-y-1">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  )
}
