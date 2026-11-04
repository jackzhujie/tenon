/**
 * 顶栏「发布」旁边的那个数字：**上次发布之后又改了几版**（M6 收口后补）。
 *
 * 为什么不是"这个应用现在能不能发"：那要跑 typecheck + 测试，一次几十秒，常驻跑不现实；
 * 而"改了几版没发"是**免费**的信息（commits 与 releases 本来就在内存里）。
 * 两者关系是：这个数字告诉你"值不值得点开对话框去跑一次预检"。
 *
 * 三个边界都真的会发生：
 * 1. **从没发布过**：`releases` 空。数字仍然是未发布版本数，但语义是"一次都没发过"，
 *    文案必须区分开 —— 否则新应用会一直显示一个数字，用户以为哪里出错了。
 * 2. **发布点比列表还早**：commits 只取最近 30 条，若最近一次发布在 30 版之前，
 *    怎么数都碰不到它 —— 这时只能说"30+"，不能编一个精确数字。
 * 3. **HEAD 就是发布点**：数字为 0，界面上什么都不显示（显示一个 0 只是噪音）。
 */

export interface CommitLike {
  readonly sha: string
}

export interface ReleaseLike {
  readonly commitSha: string
}

export interface ReleaseHint {
  /** 未发布的版本数（`saturated` 时是下限） */
  readonly count: number
  /** `true` = 数到了列表尽头还没碰到发布点，真实数量可能更多 */
  readonly saturated: boolean
  /** 这个应用发布过吗 */
  readonly ever: boolean
}

/** `null` = 不显示（没有任何提交，或者 HEAD 就是发布点） */
export function releaseHint(
  commits: readonly CommitLike[],
  releases: readonly ReleaseLike[],
  /**
   * 调用方一次拉多少条提交（`git.log` 的 `limit`）。
   *
   * 这个参数决定"数到尽头"是**精确**还是**下限**：列表没被截断时数字是准的，
   * 截断了才需要 `+`。写死一个 30 会在别人改 limit 的那天悄悄开始说谎。
   */
  windowLimit = 20,
): ReleaseHint | null {
  if (commits.length === 0) return null
  const truncated = commits.length >= windowLimit

  if (releases.length === 0) {
    return { count: commits.length, saturated: truncated, ever: false }
  }

  const published = new Set(releases.map((release) => release.commitSha))
  let count = 0
  for (const commit of commits) {
    if (published.has(commit.sha)) break
    count += 1
  }
  if (count === 0) return null
  // 一直数到末尾都没遇到发布点，且列表确实被截断过 → 真实数量未知，只能说下限
  return { count, saturated: truncated && count >= commits.length, ever: true }
}

/** 按钮上那个小徽标的文字（`saturated` 时带 `+`） */
export function releaseBadge(hint: ReleaseHint): string {
  return hint.saturated ? `${hint.count}+` : `${hint.count}`
}

/** 鼠标悬停时的一句话：说清"这些是什么"与"点进去能干什么" */
export function releaseTooltip(hint: ReleaseHint): string {
  if (!hint.ever) {
    return `还没发布过（最近 ${hint.saturated ? `${hint.count}+` : hint.count} 个版本都没发）。点「发布」跑一次预检，通过了就把这一版冻结下来。`
  }
  return `上次发布之后又改了 ${hint.saturated ? `至少 ${hint.count}` : hint.count} 个版本。点「发布」跑一次预检。`
}
