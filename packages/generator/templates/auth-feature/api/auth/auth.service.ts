/**
 * 登录用户。
 *
 * 对外只暴露 id / email / role —— `passwordHash` 绝不能进响应，哪怕前端"用不到"。
 * 这不是洁癖：一个 `return user` 的手滑会把哈希写进浏览器缓存、日志面板和截图里。
 */
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { createHash, randomBytes } from 'node:crypto'
import type { SessionUser } from '../../shared/auth-schema'
import { AuthSession } from './auth-session.entity'
import { AuthUser } from './auth-user.entity'
import { hashPassword, verifyPassword } from './password'

/** 用户的形状只有一份定义（`shared/auth-schema.ts`），这里只是转出去给同目录的文件用 */
export type { SessionUser }

export type Role = SessionUser['role']

export interface IssuedSession {
  token: string
  expiresAt: Date
}

/**
 * 会话有效期 7 天。
 *
 * 内部系统里"三天没登录就被踢出来"是被投诉最多的设计，而真正的风险由
 * "能吊销"兜住（删账号 / 退出登录即时生效），不靠缩短时间窗口。
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 库里只存令牌的哈希：库被拖走时，里面的值不能直接当 cookie 用 */
function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function toSessionUser(user: AuthUser): SessionUser {
  return { id: user.id, email: user.email, role: user.role === 'admin' ? 'admin' : 'member' }
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(AuthUser) private readonly users: Repository<AuthUser>,
    @InjectRepository(AuthSession) private readonly sessions: Repository<AuthSession>,
  ) {}

  /** 库里一个账号都没有 ⇒ 前端该显示"创建第一个管理员"而不是登录框 */
  async needsSetup(): Promise<boolean> {
    return (await this.users.count()) === 0
  }

  /**
   * 初始化：只有零账号时才能加第一个管理员。
   *
   * 这个口子必须自己关自己。留着"任何人在任何时候都能把自己的账号加成管理员"，
   * 等于没有鉴权 —— 而这个漏洞不会在开发时暴露，只在部署之后暴露。
   */
  async setup(email: string, password: string): Promise<SessionUser> {
    if (!(await this.needsSetup())) {
      throw new ConflictException('this app already has an account; sign in with your email')
    }
    return this.createUser(email, password, 'admin')
  }

  async createUser(email: string, password: string, role: Role): Promise<SessionUser> {
    const normalized = email.trim().toLowerCase()
    const existing = await this.users.findOne({ where: { email: normalized } })
    if (existing !== null) throw new ConflictException('that email is already taken')
    const user = this.users.create({
      email: normalized,
      passwordHash: await hashPassword(password),
      role,
    })
    return toSessionUser(await this.users.save(user))
  }

  /**
   * 校验口令。
   *
   * 账号不存在时也跑一次哈希：否则"不存在的邮箱"会比"密码错"明显更快，
   * 用它就能枚举出谁在这个系统里有账号。这是登录接口最常被忽略的一处信息泄漏。
   */
  async verify(email: string, password: string): Promise<SessionUser | null> {
    const user = await this.users.findOne({ where: { email: email.trim().toLowerCase() } })
    if (user === null) {
      await hashPassword(password)
      return null
    }
    return (await verifyPassword(password, user.passwordHash)) ? toSessionUser(user) : null
  }

  async issueSession(userId: number): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    /*
     * 顺手清掉过期会话：登录的频率远低于请求，放在这里比开定时任务简单。
     * 用 query builder 而不是 `delete({ expiresAt: LessThan() })` —— `delete()` 的
     * 条件只吃等值，操作符会被静默忽略，于是"清理"变成全表删除。
     */
    await this.sessions
      .createQueryBuilder()
      .delete()
      .where('expires_at < now()')
      .execute()
    await this.sessions.save(this.sessions.create({ id: tokenId(token), userId, expiresAt }))
    return { token, expiresAt }
  }

  /** 令牌 → 用户。过期即删（不删的话表只会越长越慢，且永远查得到"有效"记录） */
  async resolve(token: string): Promise<SessionUser | null> {
    const session = await this.sessions.findOne({ where: { id: tokenId(token) } })
    if (session === null) return null
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.sessions.delete({ id: session.id })
      return null
    }
    const user = await this.users.findOne({ where: { id: session.userId } })
    return user === null ? null : toSessionUser(user)
  }

  async revoke(token: string): Promise<void> {
    await this.sessions.delete({ id: tokenId(token) })
  }

  async list(): Promise<SessionUser[]> {
    const users = await this.users.find({ order: { id: 'ASC' } })
    return users.map(toSessionUser)
  }

  /** 删账号：不能删自己、不能删掉最后一个管理员（后者等于把系统锁死） */
  async remove(actor: SessionUser, id: number): Promise<void> {
    if (actor.id === id) throw new BadRequestException('you cannot delete yourself')
    const target = await this.users.findOne({ where: { id } })
    if (target === null) return
    if (target.role === 'admin') {
      const admins = await this.users.count({ where: { role: 'admin' } })
      if (admins <= 1) throw new BadRequestException('at least one admin must remain')
    }
    await this.users.delete({ id })
  }

  /** 改口令（自己改自己）。当前口令不对就不给改 —— 拿到别人没锁屏的电脑改密码是最常见的接管方式 */
  async changePassword(actor: SessionUser, current: string, next: string): Promise<void> {
    const user = await this.users.findOne({ where: { id: actor.id } })
    if (user === null) throw new UnauthorizedException('the account no longer exists')
    if (!(await verifyPassword(current, user.passwordHash))) {
      throw new UnauthorizedException('the current password is wrong')
    }
    user.passwordHash = await hashPassword(next)
    await this.users.save(user)
  }
}

/** 秒数：cookie 的 Max-Age 用它，免得两处各算一遍 */
export function secondsUntil(date: Date): number {
  return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000))
}
