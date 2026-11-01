/**
 * 发布版本号（DESIGN §12.1）：`v<yyyy.MM.dd>-<n>`。
 *
 * 为什么是这个形状而不是 `v1.2.3`：
 * - **日期在前**：用户记得住"哪天发的"，记不住"第几个版本"；自托管场景里"回滚到 10 月 28 号那版"
 *   比"回滚到 v1.4.2"更好找
 * - **同日序号**：一天可能发好几次（改完就发），没有序号就会撞号
 * - **不递增主版本**：Tenon 不知道用户的版本语义，替用户拍 1.0.0 只会误导
 *
 * 这里只有纯函数 —— 不碰文件、不碰 git，所以可以拿一堆边界用例钉住。
 */

/** `v2026.11.01-3` → `{ date: '2026.11.01', n: 3 }`；不合法返回 `undefined` */
const VERSION_PATTERN = /^v(\d{4}\.\d{2}\.\d{2})-(\d+)$/

export interface ParsedVersion {
  readonly date: string
  readonly n: number
}

export function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return undefined
  return { date: match[1] as string, n: Number.parseInt(match[2] as string, 10) }
}

/**
 * 当天前缀。用**本地时间**：用户说的"今天"是自己时区里的今天，
 * 不是 UTC 的今天 —— 晚上 8 点发版却写成明天，会让人以为记录错了。
 */
export function versionPrefix(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `v${year}.${month}.${day}`
}

/**
 * 下一个版本号。
 *
 * `existing` 要同时包含**发布记录里的版本**与**仓库里已有的 tag**：
 * 只信其中一边都会撞号 —— 记录被删过（或备份库从别处拷来）时那边是空的，
 * 但 tag 还在，`git tag` 会直接失败。
 *
 * 只解析**同一天**的号：跨天的 `-7` 不影响今天从 `-1` 开始。
 */
export function nextVersion(existing: Iterable<string>, now: Date): string {
  const prefix = versionPrefix(now)
  let max = 0
  for (const version of existing) {
    const parsed = parseVersion(version)
    if (parsed === undefined || parsed.date !== prefix.slice(1)) continue
    if (parsed.n > max) max = parsed.n
  }
  return `${prefix}-${max + 1}`
}
