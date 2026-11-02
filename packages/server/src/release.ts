/**
 * 发布（DESIGN §13）：把一个 commit 冻结成版本，推到备份库，并留下发布记录。
 *
 * 这个文件只做**编排**，四件事分别落在别处：
 * - 版本号怎么算 → `@tenon/core` 的 `nextVersion`（纯函数，有单测）
 * - tag 怎么打、对象怎么搬 → `@tenon/core` 的 `gitops.createReleaseTag / mirrorTo`
 * - 能不能发 → `@tenon/agent` 的 `runQualityGate`（M4 第 7 步）
 * - 记录存哪 → `ReleaseStore`
 *
 * 顺序刻意是「**检查 → 门禁 → 打 tag → 推备份 → 记账**」：
 * 推送失败时把 tag 删掉，让仓库回到干净状态 —— 留下一个没有发布记录的 tag，
 * 下次发布会算出一个 -2，用户会以为"我是不是少发了一版"。
 *
 * 门禁排在版本号之前：检查没过就不该消耗一个版本号。否则用户会看到版本号一路
 * 往上跳（-3、-4、-5），却一版都没发出去。
 */
import type { App, GateOutcome, Release, ReleaseGateStatus } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
import { appPaths, gitops, nextVersion, type CoreServices } from '@tenon/core'
import { checkLabel, formatGateSummary, runQualityGate } from '@tenon/agent'

export interface PublishOptions {
  core: CoreServices
  app: App
  notes?: string | undefined
  /** 测试用：把"今天"钉住 */
  now?: Date
  /**
   * 检查没过也发。
   *
   * **仍然会跑检查** —— `force` 只影响"拦不拦"，不影响"跑不跑"。用户有权坚持，
   * 但没权不知道自己在放过什么；结果会写进发布记录（`gateStatus: 'forced'`）。
   */
  force?: boolean
}

export interface PublishResult {
  release: Release
  version: string
  commitSha: string
  /** 备份库绝对路径（`git clone <它>` 得到的就是这一版） */
  backupPath: string
  branch: string
  /** 这次真正写进备份库的对象数；0 表示备份库已经是最新的 */
  objects: number
  /** 这次跑过的检查。发成功之后界面也要显示"它是怎么过的" */
  gate: GateOutcome
}

const BRANCH = 'main'

export async function publishRelease(options: PublishOptions): Promise<PublishResult> {
  const { core, app } = options
  const now = options.now ?? new Date()
  const paths = appPaths(core.home, app.id)

  if (app.status === 'running') {
    // 生成中途发布 = 发一份写了一半的代码。等这一轮跑完（一轮结束就会自动 commit）
    throw new TenonError('APP_BUSY', '正在生成中，等这一轮跑完再发布')
  }

  const head = await gitops.headSha(paths.repoDir)
  if (head === undefined) {
    throw new TenonError('RELEASE_NO_COMMITS', '这个应用还没有任何提交，没有可以发布的内容')
  }

  const dirty = await gitops.uncommittedChanges(paths.repoDir)
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).join('、')
    throw new TenonError(
      'GIT_DIRTY_WORKTREE',
      `工作区还有 ${dirty.length} 个文件没提交（${shown}${dirty.length > 5 ? ' 等' : ''}），先让这一轮跑完再发布`,
      { paths: dirty.slice(0, 50) },
    )
  }

  // 质量门禁：typecheck / test 不过不许发（M4 第 7 步）
  const gate = await runQualityGate(paths.repoDir)
  if (!gate.ok && options.force !== true) {
    const failed = gate.checks.filter((check) => check.status === 'fail')
    throw new TenonError(
      'RELEASE_CHECKS_FAILED',
      // summary 里不带检查名（界面有独立的列），拼消息时补上
      `发布前检查没通过：${failed.map((check) => `${checkLabel(check.id)}${check.summary}`).join('；')}。` +
        '修好再发；确认要发就显式选「仍然发布」。',
      { checks: gate.checks },
    )
  }

  // 版本号同时参考「发布记录」与「仓库里的 tag」：任一边单独用都会撞号
  // （记录被删过 / 备份库是从别的机器拷来的）
  const recorded = core.releases.list(app.id, 500).map((release) => release.version)
  const tags = await gitops.listTags(paths.repoDir)
  const version = nextVersion([...recorded, ...tags], now)

  const notes = options.notes?.trim() ?? ''
  const tag = await gitops.createReleaseTag(paths.repoDir, {
    tag: version,
    sha: head,
    message: notes === '' ? `Tenon 发布 ${version}` : `Tenon 发布 ${version}\n\n${notes}`,
    when: now,
  })

  let mirrored: gitops.MirrorResult
  try {
    mirrored = await gitops.mirrorTo(paths.repoDir, paths.backupRepo, {
      branch: BRANCH,
      tags: [version],
    })
  } catch (err) {
    // 推不出去就别留下"有 tag、没记录"的半成品
    await gitops.deleteTag(paths.repoDir, version)
    const reason = err instanceof Error ? err.message : String(err)
    throw new TenonError('RELEASE_FAILED', `推送到备份库失败：${reason}`, { version, tag })
  }

  // `pass` 包含"全部 skip"：那是"这个应用没有可检查的东西"，不是"偷偷发的"。
  // 真正被放过的情况才叫 forced —— 差一版记录，半年后没人说得清。
  const gateStatus: ReleaseGateStatus = gate.ok ? 'pass' : 'forced'
  const release = core.releases.add({
    appId: app.id,
    version,
    commitSha: head,
    kind: 'push',
    artifactPath: paths.backupRepo,
    imageRef: null,
    notes: notes === '' ? null : notes,
    gateStatus,
    gateSummary: formatGateSummary(gate),
  })

  return {
    release,
    version,
    commitSha: head,
    backupPath: paths.backupRepo,
    branch: mirrored.branch,
    objects: mirrored.objects,
    gate,
  }
}
