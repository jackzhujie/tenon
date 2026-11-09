/**
 * 会话表。
 *
 * 主键存的是令牌的 **sha256**，不是令牌本身。理由是那张库最可能被人拿到的地方
 * （备份、导出、截图贴群）都在应用之外：库里只有哈希，搬走了也换不出可用的 cookie。
 *
 * 为什么用"库里的会话"而不是 JWT：内部系统最常见的操作是"这人走了，立刻断掉"。
 * JWT 签发之后无法撤回，只能等它过期，或者去维护一份黑名单（那就又回到查库了）。
 */
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity({ name: 'auth_sessions' })
export class AuthSession {
  /** `sha256(令牌)` 的十六进制 */
  @PrimaryColumn({ type: 'text' })
  id!: string

  /** 外键在迁移里声明 `on delete cascade`：删账号时会话一起走，不用记得手动清 */
  @Column({ type: 'integer', name: 'user_id' })
  userId!: number

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date
}
