/**
 * 极小的模板渲染：只做 `{{name}}` 替换，不做条件/循环。
 *
 * 为什么不上 Handlebars/EJS：模板是**我们自己维护的固定几份**，需要的是
 * 「可读、可 diff、出错能一眼看出哪一行」。引入一门模板语言之后，模板本身就
 * 不能再用 `tsc` / `vite` 校验，反而更容易写出静默坏掉的东西。
 *
 * 硬约束：
 * - 占位符只有 `{{ident}}` 一种形状（标识符字符集），所以 CSS 的 `{{` 不会误伤
 * - **渲染后必须没有残留占位符**：残留意味着模板加了新变量但调用方没给值，
 *   这种错误如果放进应用里，用户看到的是 `{{appName}}` 出现在界面上
 */
import { TenonError } from '@tenon/protocol'

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export type TemplateVars = Readonly<Record<string, string>>

export function renderTemplate(source: string, vars: TemplateVars, at = '<template>'): string {
  const used = new Set<string>()
  const out = source.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new TenonError('TEMPLATE_VAR_MISSING', `模板 ${at} 需要变量 ${name}，但调用方没有提供`, {
        file: at,
        variable: name,
      })
    }
    used.add(name)
    return value
  })

  const leftover = out.match(PLACEHOLDER)
  if (leftover !== null) {
    throw new TenonError(
      'TEMPLATE_VAR_LEFT',
      `模板 ${at} 渲染后仍有未替换的占位符：${leftover.join(', ')}`,
      { file: at },
    )
  }
  return out
}

/** 模板里出现过的变量名（给 `template.json` 的自检测试用） */
export function placeholdersOf(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return [...names].sort()
}
