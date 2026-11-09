/**
 * `@tenon/generator` —— 模板渲染。
 *
 * 依赖方向：`server → generator`；generator 只依赖 `protocol`（拿 `TenonError`）。
 * **不认识 Fastify，也不认识数据库**：给它一个目录，它把文件写进去。
 *
 * M1 只做"铺骨架"。DESIGN §5 里说的 AST 级补丁（改已有组件而不是重写整文件）是 M3 的事；
 * 现在 Agent 有 write/edit 工具，直接在骨架上改就行，比模板引擎灵活得多。
 */
export {
  scaffoldApp,
  DEFAULT_TEMPLATE,
  type ScaffoldInput,
  type ScaffoldResult,
} from './scaffold.js'
export {
  applyApiFeature,
  API_FEATURE,
  applyAuthFeature,
  AUTH_FEATURE,
  type ApplyApiFeatureInput,
  type ApplyApiFeatureResult,
  type ApplyAuthFeatureInput,
  type ApplyAuthFeatureResult,
} from './features.js'
export {
  collectFiles,
  listTemplates,
  loadTemplate,
  templatesRoot,
  type TemplateManifest,
  type TemplateSummary,
} from './registry.js'
export { placeholdersOf, renderTemplate, type TemplateVars } from './render.js'
