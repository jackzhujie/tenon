/**
 * 提示词与工具描述**不许出现中文**。
 *
 * 为什么值得一条测试：这些字唯一的读者是模型，而模型的输入混了两种语言时行为会变 ——
 * 一部分模型会开始用中文思考、把工具名也写成中文（`读取` 而不是 `read`），
 * 另一部分会把中文当成"用户说的话"去回应。这两种都不是崩溃，只是安静地变差，
 * 靠人眼在几十段提示词里发现不了。
 *
 * 唯一允许的中文是**引用检查项结论**时点名的那句 `没跑成`：`checks` 的摘要按界面
 * 语言输出，Reviewer 必须中英两版都认得（否则中文界面上它会把"没通过"读成"通过了"）。
 * 这条豁免写在下面，不是散落在各处的白名单。
 */
import { describe, expect, it } from 'vitest'
import { ROLES, plannedRejection, subagentPrompt } from '../src/roles.js'
import { createCodingTools } from '../src/tools/coding.js'
import { createSearchTools } from '../src/tools/search.js'
import { createPreviewTools } from '../src/tools/preview.js'
import { createReviewTools } from '../src/tools/review.js'
import { createSubagentTool } from '../src/tools/subagent.js'
import { createComponentsTools } from '../src/tools/components.js'
import { createBackendTools } from '../src/tools/backend.js'
import { createAuthTools } from '../src/tools/auth.js'

/** 允许出现的中文片段：引用检查项结论时给中文界面的那一版 */
const ALLOWED = ['没跑成']

function cjkOf(text: string): string[] {
  const stripped = ALLOWED.reduce((whole, allowed) => whole.split(allowed).join(''), text)
  return (stripped.match(/[\u4e00-\u9fff]+/g) ?? []).slice(0, 3)
}

describe('给模型看的字一律英文', () => {
  it.each(Object.values(ROLES).map((role) => [role.id, role] as const))(
    '%s 的 instructions',
    (_id, role) => {
      expect(cjkOf(role.instructions)).toEqual([])
    },
  )

  it('role=planned 时回给模型的那句话', () => {
    const planned = { ...ROLES.explore, readiness: 'planned' as const }
    expect(cjkOf(plannedRejection(planned) ?? '')).toEqual([])
  })

  it('派活时塞进子会话的第一行', () => {
    expect(cjkOf(subagentPrompt('explore', 'where is the login page'))).toEqual([])
  })

  /*
   * 工具描述是模型"什么时候该用哪个工具"的唯一线索。逐个工厂取一遍 —— 只构造不执行，
   * 所以不需要真仓库、真预览、真 harness。
   */
  const tools = [
    ...createCodingTools({ repoDir: '/tmp/x' }),
    ...createSearchTools({ repoDir: '/tmp/x' }),
    ...createPreviewTools({ repoDir: '/tmp/x', appId: 'app_x', getDriver: () => undefined }),
    ...createReviewTools({ repoDir: '/tmp/x' }),
    ...createComponentsTools({ repoDir: '/tmp/x', appId: 'app_x', roots: [], tenonVersion: '0.0.0' }),
    ...createBackendTools({ repoDir: '/tmp/x', appId: 'app_x' }),
    ...createAuthTools({ repoDir: '/tmp/x', appId: 'app_x' }),
    createSubagentTool({ getHarness: () => undefined, getTools: () => [] }),
  ]

  it.each(tools.map((tool) => [tool.name, tool] as const))('%s 的 description', (_name, tool) => {
    expect(cjkOf(tool.description)).toEqual([])
  })

  it('参数说明也是给模型看的（占位符写中文，模型就会照着中文填）', () => {
    for (const tool of tools) {
      expect(cjkOf(JSON.stringify(tool.parameters))).toEqual([])
    }
  })
})
