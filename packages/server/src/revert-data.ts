/**
 * 回滚数据侧里最容易被算错的那一步：**到底该用哪一份快照**。
 *
 * 背景：快照只在"这次提交动了表结构"时才存，所以**不是每个提交都有**。
 * 回滚第 N 版时，正确的数据状态是第 N 版**之前**（也就是父提交 N-1）的样子；
 * 但如果 N-1 没改 schema 就没快照，只能继续往前退，退到最近一份有的。
 *
 * 这带来一个必须**如实告知**的后果：退得比目标更早，就意味着中间那几轮写入的
 * 数据会被一起丢掉。`skipped` 就是用来量这个距离的，不是可以省略的装饰。
 *
 * 抽成纯函数的原因：这段逻辑的正确性靠的是"索引偏移恰好是一"这种细节，
 * 而它埋在 RPC handler 里就没法单独测 —— 要测就得起真库、真 git、真预览。
 */
import type { DbSnapshot } from '@tenon/db-provisioner'

export interface PickedSnapshot {
  readonly snapshot: DbSnapshot
  /** 快照属于哪个提交 —— 可能早于目标，UI 要据此说清"退到了哪一版" */
  readonly sha: string
  /**
   * 从「目标的父提交」到「实际用的快照」之间隔了几个提交。
   * `0` 表示正好命中父提交那一份；`2` 表示中间两轮的写入会被丢弃。
   */
  readonly skipped: number
}

/**
 * @param ancestors 从**目标的父提交**起往前的提交链（新 → 旧），由 `planRevert` 给出
 * @param find 查某个提交有没有快照
 */
export async function pickSnapshot(
  ancestors: readonly string[],
  find: (sha: string) => Promise<DbSnapshot | null>,
): Promise<PickedSnapshot | null> {
  for (const [offset, sha] of ancestors.entries()) {
    const snapshot = await find(sha)
    // `offset` 天然就是"跳过几个"：第一个祖先就是父提交，offset=0
    if (snapshot !== null) return { snapshot, sha, skipped: offset }
  }
  return null
}
