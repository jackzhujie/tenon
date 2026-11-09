import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 账号两张表。
 *
 * ★ 这份迁移**同时**跑在 PGlite（WASM 版 PG）和真的 PostgreSQL 上，所以只用标准 PG 语法。
 *   一处特意的让步：主键用 `serial` 而不是 uuid —— PG 生成 uuid 要靠 `uuid-ossp` / `pgcrypto`
 *   扩展，PGlite 里没有，`create extension` 会直接让整个启动流程失败（表现为"后端起不来"，
 *   而报错在扩展那一行）。
 *
 * `email` 的唯一性是**大小写敏感**的普通 unique —— 因为写入前统一 `toLowerCase()` 了
 * （见 `AuthService.createUser`）。用 `unique (lower(email))` 需要表达式索引，而实体那边
 * 表达不了，两边会漂。
 */
export class CreateAuth1770000000000 implements MigrationInterface {
  name = 'CreateAuth1770000000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists auth_users (
        id serial primary key,
        email text not null unique,
        password_hash text not null,
        role text not null default 'member',
        created_at timestamptz not null default now()
      )
    `)
    await queryRunner.query(`
      create table if not exists auth_sessions (
        id text primary key,
        user_id integer not null references auth_users (id) on delete cascade,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      )
    `)
    /* 退出登录/删账号要按 user_id 删；过期清理要按 expires_at 扫 */
    await queryRunner.query(
      'create index if not exists auth_sessions_user_idx on auth_sessions (user_id)',
    )
    await queryRunner.query(
      'create index if not exists auth_sessions_expires_idx on auth_sessions (expires_at)',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table if exists auth_sessions')
    await queryRunner.query('drop table if exists auth_users')
  }
}
