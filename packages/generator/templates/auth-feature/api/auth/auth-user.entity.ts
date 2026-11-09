/**
 * 账号表。
 *
 * 表名带 `auth_` 前缀：这个应用可能已经有一张自己的 `users` 表（十有八九会有）。
 * 撞名不会在编译期暴露，而是迁移时 `relation already exists` 或更糟 —— 悄悄写到
 * 别人的表上，报错位置离真正的原因很远。
 *
 * 主键用自增整数而不是 uuid：Postgres 上的 uuid 生成要么依赖 `uuid-ossp` / `pgcrypto`
 * 扩展（PGlite 里装不出来 = 预览直接起不来），要么在 JS 里生成（那还不如 serial 简单）。
 * 一个内部系统的账号表不需要"客户端可预测 id"的能力。
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'auth_users' })
export class AuthUser {
  @PrimaryGeneratedColumn()
  id!: number

  /** 一进来就 `trim().toLowerCase()`，唯一性由迁移里的 unique 约束保证（不做大小写双份） */
  @Column({ type: 'text' })
  email!: string

  @Column({ type: 'text', name: 'password_hash' })
  passwordHash!: string

  /** `admin` / `member`。用 text 而不是 PG enum：加角色时不用写迁移 */
  @Column({ type: 'text', default: 'member' })
  role!: string

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date
}
