/**
 * 「这次提交动没动数据库结构」—— 决定要不要给库打快照。
 *
 * 为什么要有这个判据：每轮对话都存一份整库归档不现实（PGlite 一份 4~5MB，
 * 一个应用聊五十轮就是两百多兆）。而**只改前端样式的那一轮，库根本没变**，
 * 为它存快照纯属浪费。真正需要快照的只有一种情况：这一版改了表结构，
 * 所以"回到上一版"必须连库一起回去，否则代码在跑旧查询、表却是新的。
 *
 * 判据刻意写成**路径约定**而不是"看这个 commit 里有没有 SQL 关键字"：
 * 后者要读文件内容、要猜方言、还会被字符串里的 `CREATE TABLE` 误伤。
 * 模板的结构是稳定的（见 `packages/generator/templates/nest-api`），
 * 三个位置覆盖了 schema 的所有来源：
 *
 * | 位置 | 是什么 |
 * |---|---|
 * | `api/migrations/**` | TypeORM 迁移 —— schema 的唯一事实来源 |
 * | `**\/*.entity.ts` | 实体定义；TypeORM 的 `synchronize` 关着，但实体注释会进迁移 |
 * | `**\/shared\/schema.ts` | zod 共享层 —— 改字段往往先改这里，前端表单也跟着变 |
 *
 * 宁可**多判**不可漏判：多存一份快照只是几 MB，漏存则意味着"回滚按钮看起来能用，
 * 实际把库留在了新版本"——那是静默的数据/代码不一致，比多占几 MB 糟得多。
 */

/** 单条路径是否属于 schema 变更。入参是 git 里的相对路径（`api/migrations/....ts`） */
export function isSchemaChange(path: string): boolean {
  // 统一分隔符：git 永远给 `/`，但测试与调用方可能传 Windows 风格
  const normalized = path.replace(/\\/g, '/')
  return (
    // api/migrations/1767225600000-InitItems.ts
    /(^|\/)migrations\/[^/]+\.(ts|js|mjs|cjs)$/.test(normalized) ||
    // item.entity.ts / api/src/items/item.entity.ts
    /\.entity\.(ts|js|mjs|cjs)$/.test(normalized) ||
    // shared/schema.ts（模板里前后端共用 zod 定义的那个文件）
    /(^|\/)shared\/schema\.(ts|js|mjs|cjs)$/.test(normalized)
  )
}

/** 一批变更路径里有没有 schema 变更 */
export function hasSchemaChange(paths: readonly string[]): boolean {
  return paths.some((path) => isSchemaChange(path))
}
