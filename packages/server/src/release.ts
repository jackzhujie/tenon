/**
 * 发布（DESIGN §13）：把一个 commit 冻结成版本，推到备份库，并留下发布记录。
 *
 * 这个文件只做**编排**，四件事分别落在别处：
 * - 版本号怎么算 → `@tenon/core` 的 `nextVersion`（纯函数，有单测）
 * - tag 怎么打、对象怎么搬 → `@tenon/core` 的 `gitops.createReleaseTag / mirrorTo`
 * - 能不能发 → `@tenon/agent` 的 `runQualityGate`（M4 第 7 步）
 * - 记录存哪 → `ReleaseStore`
 *
 * 顺序刻意是「**预检 → 打 tag → 推备份 → 记账**」：
 * 推送失败时把 tag 删掉，让仓库回到干净状态 —— 留下一个没有发布记录的 tag，
 * 下次发布会算出一个 -2，用户会以为"我是不是少发了一版"。
 *
 * **预检（`inspectRelease`）与发布共用同一份判断。** `release.check` 只读地回答
 * "现在能不能发"，`release.publish` 拿同一个函数的结果决定发不发。两份实现的话，
 * 必然出现"预检说能发、点下去却被拦"，而门禁一旦开始说两套话，用户就会绕过它。
 */
import type { App, GateOutcome, Release, ReleaseGateStatus, RemotePushOutcome } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'
import { appPaths, gitops, nextVersion, pushToRemote, type CoreServices, type PushToRemoteOptions } from '@tenon/core'
import { checkLabel, formatGateSummary, runQualityGate } from '@tenon/agent'

/** 拦在发布之前、**与代码质量无关**的事。它们不跑门禁，因为跑也没用 */
export interface ReleaseBlock {
  code: 'APP_BUSY' | 'RELEASE_NO_COMMITS' | 'GIT_DIRTY_WORKTREE'
  message: string
  details?: Record<string, unknown>
}

/**
 * 预检结果。
 *
 * 刻意做成判别联合而不是"每个字段都可空"：调用方 `if (inspection.blocked !== null) throw`
 * 之后，`gate` 与 `commitSha` 就自动是非空的 —— 类型系统替我们记住"有 blocked 就没门禁"
 * 这条不变式，比在每处写 `gate!` 强。
 */
export type ReleaseInspection =
  | {
      ready: false
      blocked: ReleaseBlock
      commitSha: string | null
      gate: null
      stale: false
      elapsedMs: number
    }
  | {
      ready: boolean
      blocked: null
      commitSha: string
      gate: GateOutcome
      stale: boolean
      elapsedMs: number
    }

export interface InspectOptions {
  core: CoreServices
  app: App
}

/**
 * 前置闸门：应用在生成中 / 没有提交 / 工作区脏。
 *
 * 这三种情况**不跑门禁**。工作区脏却去跑一遍 `tsc` 和测试，既白等几十秒，又会让人
 * 以为"测试通过就快能发了"——真正该做的是把这一轮跑完。代价是返回值里带不出门禁，
 * 而那正是这个分支想说的：现在的问题不在代码质量上。
 */
async function releaseBlockers(core: CoreServices, app: App): Promise<{
  blocked: ReleaseBlock | null
  headSha: string | null
}> {
  const paths = appPaths(core.home, app.id)
  const headSha = (await gitops.headSha(paths.repoDir)) ?? null

  // 先判"在跑"：新应用第一轮生成中时 head 也常常是空的，那时候该说的是"等这一轮"，
  // 而不是"还没有提交"——后者会让人以为要自己手动做点什么
  if (app.status === 'running') {
    return { blocked: { code: 'APP_BUSY', message: '正在生成中，等这一轮跑完再发布' }, headSha }
  }
  if (headSha === null) {
    return {
      blocked: { code: 'RELEASE_NO_COMMITS', message: '这个应用还没有任何提交，没有可以发布的内容' },
      headSha: null,
    }
  }

  const dirty = await gitops.uncommittedChanges(paths.repoDir)
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).join('、')
    return {
      blocked: {
        code: 'GIT_DIRTY_WORKTREE',
        message: `工作区还有 ${dirty.length} 个文件没提交（${shown}${dirty.length > 5 ? ' 等' : ''}），先让这一轮跑完再发布`,
        details: { paths: dirty.slice(0, 50) },
      },
      headSha,
    }
  }
  return { blocked: null, headSha }
}

/**
 * 同一个应用同时只跑一份预检。
 *
 * 两次预检 = 同一个目录里两个 `tsc` 加两个 `vitest`。后者会往 `node_modules/.vite` 写缓存，
 * 两个进程抢同一个目录是真实的故障源；多标签页、多窗口时很容易撞上。撞上时后到的那次
 * **等前一次的结果**：它问的是同一个问题（"现在这一版能不能发"），而前一份正在回答它。
 *
 * 这不叫缓存 —— 结果一出来就从表里删掉，下一次问一定重新跑。缓存会让门禁看到过期的
 * 答案，而这个功能的全部价值就在于"答案是现在的"。
 */
const inflight = new Map<string, Promise<ReleaseInspection>>()

export function inspectRelease(options: InspectOptions): Promise<ReleaseInspection> {
  const existing = inflight.get(options.app.id)
  if (existing !== undefined) return existing
  const run = inspectReleaseOnce(options).finally(() => {
    inflight.delete(options.app.id)
  })
  inflight.set(options.app.id, run)
  return run
}

/**
 * 发布预检：只读，不打 tag、不写记录、不消耗版本号。
 *
 * 它是**真跑**（`tsc` + `pnpm run test`），所以慢是正常的 —— 界面必须显示"正在检查"，
 * 否则用户会以为界面卡死了。
 *
 * `stale` 是关键的一格：检查前后各读一次 HEAD，不一致就说明这份结果讲的是上一版代码。
 * 一份针对 A 的"通过"拿去给 B 用，比不检查更糟 —— 它给的是虚假的安心。
 */
async function inspectReleaseOnce(options: InspectOptions): Promise<ReleaseInspection> {
  const started = Date.now()
  const { blocked, headSha } = await releaseBlockers(options.core, options.app)
  if (blocked !== null) {
    return { ready: false, blocked, commitSha: headSha, gate: null, stale: false, elapsedMs: Date.now() - started }
  }
  // 上面这条分支保证 headSha 非空（没有提交时一定 return 了）
  const commitSha = headSha as string

  const paths = appPaths(options.core.home, options.app.id)
  const gate = await runQualityGate(paths.repoDir)

  const afterSha = await gitops.headSha(paths.repoDir)
  const stale = afterSha !== commitSha

  return {
    ready: gate.ok && !stale,
    blocked: null,
    commitSha,
    gate,
    stale,
    elapsedMs: Date.now() - started,
  }
}

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
  /** 测试注入：远端推送用假的 `git.push`（真推要连 GitHub，单测里不连网） */
  pushImpl?: PushToRemoteOptions['pushImpl']
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
  /**
   * 远端推送的结果。**没配远端时是 null**。
   *
   * 与本地那一步的区别是刻意的：本地失败 → 抛错、删 tag、不算发布；
   * 远端失败 → 只是这一格里的 `ok=false`。理由在 `pushReleaseToRemote` 的注释里。
   */
  remote: RemotePushOutcome | null
  /** 这次跑过的检查。发成功之后界面也要显示"它是怎么过的" */
  gate: GateOutcome
}

const BRANCH = 'main'

export async function publishRelease(options: PublishOptions): Promise<PublishResult> {
  const { core, app } = options
  const now = options.now ?? new Date()

  // 预检：前置闸门 + 质量门禁（与 `release.check` 是同一个函数，见文件头）
  const inspection = await inspectRelease({ core, app })
  if (inspection.blocked !== null) {
    throw new TenonError(inspection.blocked.code, inspection.blocked.message, inspection.blocked.details)
  }
  if (inspection.stale) {
    // 检查的几十秒里 HEAD 又变了 —— 前端点发布时按钮是禁用的，正常不该发生；
    // 真发生了说明有别的写入方，这时候挑哪一份结果去打 tag 都是错的
    throw new TenonError('APP_BUSY', '检查期间仓库又有新提交，等这一轮跑完再发布')
  }

  const { gate, commitSha: head } = inspection
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

  const paths = appPaths(core.home, app.id)
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

  /*
   * 远端放在**记账之后**：它失败不该把这一版变成"没发出去"。
   *
   * 顺序在这里是有意义的 —— 如果先推远端、再写记录，一次网络抖动就会留下
   * "tag 在、远端有、记录没有"的半成品，而界面依据记录画历史，用户会以为丢了。
   * 现在的语义一句话：**本地备份库成功 = 发布成功**，远端是分发，可以补推。
   */
  const remote = core.remotes.get(app.id) === null ? null : await pushReleaseToRemote({ core, app, version, pushImpl: options.pushImpl })

  return {
    release,
    version,
    commitSha: head,
    backupPath: paths.backupRepo,
    branch: mirrored.branch,
    objects: mirrored.objects,
    remote,
    gate,
  }
}

export interface PushReleaseOptions {
  core: CoreServices
  app: App
  version: string
  /** 测试注入：替换真正的 `git.push`（真推要连 GitHub，单测里不连网） */
  pushImpl?: PushToRemoteOptions['pushImpl']
}

/**
 * 把某一版推到配置好的远端。**不抛错**：所有失败都变成 `ok=false` 的那一格。
 *
 * 为什么不抛：调用它的人（`publishRelease` 与 `release.push`）都要把失败**显示**给
 * 用户，而不是让整个 RPC 变成错误 —— 那会让界面上"发布成功"的绿框直接消失，
 * 用户会以为版本没发出去（其实本地备份库是完整的）。
 *
 * 唯一的例外是"根本没配远端"：那在 `release.push` 里是个明确的用户操作错误。
 */
export async function pushReleaseToRemote(options: PushReleaseOptions): Promise<RemotePushOutcome> {
  const { core, app, version } = options
  const remote = core.remotes.reveal(app.id)
  if (remote === null) {
    return {
      ok: false,
      code: 'NO_REMOTE',
      message: '这个应用还没有配置远端仓库',
      hint: '在发布对话框的「远端仓库」里填一次地址和令牌。',
      refs: 0,
    }
  }

  const paths = appPaths(core.home, app.id)
  const tags = await gitops.listTags(paths.repoDir)
  if (!tags.includes(version)) {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: `仓库里没有 ${version} 这个标签，可能这一版已经被清理掉了`,
      hint: '重新发布一版即可；已经推到远端的旧版本不受影响。',
      refs: 0,
    }
  }

  try {
    const result = await pushToRemote({
      dir: paths.repoDir,
      url: remote.url,
      username: remote.username,
      token: remote.token,
      branch: remote.branch,
      tags: [version],
      pushImpl: options.pushImpl,
    })
    if (result.ok) return { ok: true, code: null, message: null, hint: null, refs: result.refs }
    return {
      ok: false,
      code: result.failure.code,
      message: result.failure.message,
      hint: result.failure.hint,
      refs: result.refs,
    }
  } catch (error) {
    // pushToRemote 已经把 git 的错误都收进 failure 了；能到这里的是更外层的意外
    // （比如令牌解密炸了）。同样不能让它把"发布成功"顶掉
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: 'UNKNOWN',
      message: `推送时出了意外：${reason.slice(0, 300)}`,
      hint: '先看远端地址是否还能打开；再看本机网络。',
      refs: 0,
    }
  }
}
