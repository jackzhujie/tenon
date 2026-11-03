/**
 * 把「已装组件」写进应用的 `docs/AGENTS.md`（DESIGN §21.6）。
 *
 * 为什么必须写：组件是**平台注入**的（web facet 由网关插一行脚本、server facet 由宿主激活），
 * 应用代码里根本没有它的引用。Agent 看不到任何痕迹，于是下一次改页面时它很可能
 * 自己再写一个悬浮球 —— 那不是"重复劳动"，是两套 UI 打架。
 *
 * 三条做法：
 * 1. **只用一段带标记的区域**（`<!-- tenon:components:begin/end -->`）。整份 AGENTS.md 是
 *    应用自己的长期记忆，Agent 会往里写架构与坑，我们不能覆盖它。
 * 2. **幂等**：同样的组件写两遍，文件字节不变（否则每次安装都产生一个无意义的 commit）。
 * 3. **没有组件也留一段**（"（无）"）：卸载之后把那一段清空，比整段消失更好 ——
 *    否则下次读的人会以为"这个项目从来没装过组件"。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstalledComponent } from '@tenon/protocol'

export const AGENTS_DOC = join('docs', 'AGENTS.md')
const BEGIN = '<!-- tenon:components:begin -->'
const END = '<!-- tenon:components:end -->'

export function agentsDocPath(repoDir: string): string {
  return join(repoDir, AGENTS_DOC)
}

const HEADER = `# 项目说明（给 Agent 读）

> 这份文件是这个项目的长期记忆：架构、约定、坑、运行方式。
> 下面「已装组件」那一节由 Tenon 维护，**不要手改**；其余小节随便写。
`

/** 一段"已装组件"的正文（不含标记） */
export function renderComponentsSection(components: readonly InstalledComponent[]): string {
  if (components.length === 0) {
    return '## 已装组件\n\n（无）\n'
  }
  const lines: string[] = ['## 已装组件', '', '> 这些组件由平台注入，**应用代码里不需要 import 它们**，也不要去改它们的实现。']
  for (const component of components) {
    lines.push('', `### ${component.name}（\`${component.id}\` ${component.version}）`)
    lines.push('', component.description)
    if (component.mounts.length > 0) {
      const where = component.mounts
        .map((mount) => (mount.prefix === null ? mount.slot : `${mount.slot}（前缀 ${mount.prefix}）`))
        .join('、')
      lines.push('', `- 挂载点：${where}`)
    }
    if (component.permissions.length > 0) {
      lines.push(`- 权限：${component.permissions.join('、')}`)
    } else {
      lines.push('- 权限：无（不碰文件、网络、数据库）')
    }
    lines.push('', component.agentHints)
  }
  return `${lines.join('\n')}\n`
}

/** 把一段正文塞进标记之间；没有标记就追加到文末 */
export function spliceSection(text: string, body: string): string {
  const block = `${BEGIN}\n${body}${END}`
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start !== -1 && end > start) {
    return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`
  }
  const base = text.trimEnd()
  return `${base === '' ? HEADER.trimEnd() : base}\n\n${block}\n`
}

export interface AgentsDocSync {
  readonly file: string
  /** 内容有没有真的变（没变就不写，避免每装一次多一个 commit） */
  readonly changed: boolean
}

export async function syncAgentsDoc(
  repoDir: string,
  components: readonly InstalledComponent[],
): Promise<AgentsDocSync> {
  const file = agentsDocPath(repoDir)
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch {
    existing = ''
  }
  const next = spliceSection(existing, renderComponentsSection(components))
  if (next === existing) return { file, changed: false }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, next, 'utf8')
  return { file, changed: true }
}
