import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 第一张表。
 *
 * ★ 这份迁移**同时**跑在 PGlite（WASM 版 PG）和真的 PostgreSQL 上 ——
 * 方言一致是选 PGlite 的全部意义。所以这里只许用标准 PG 语法，
 * 不要出现 SQLite 式的类型（`integer` 自增、`datetime`、无时区时间戳）。
 */
export class InitItems1767225600000 implements MigrationInterface {
  name = 'InitItems1767225600000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists items (
        id serial primary key,
        title text not null,
        done boolean not null default false,
        created_at timestamptz not null default now()
      )
    `)
    await queryRunner.query(
      'create index if not exists items_created_at_idx on items (created_at desc)',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table if exists items')
  }
}
