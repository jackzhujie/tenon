/**
 * 两份迁移：001 建表，002 加列 + 唯一约束。
 * 目的不是"跑通建表"，而是验证 TypeORM 的迁移事务在 pool.max=1~2 下不会自锁。
 */
import type { MigrationInterface, QueryRunner } from 'typeorm'

export class InitProducts1717000000001 implements MigrationInterface {
  name = 'InitProducts1717000000001'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sku varchar(64) NOT NULL,
        title varchar(200) NOT NULL,
        price numeric(12,2) NOT NULL DEFAULT 0,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products (sku)`)
    await q.query(`CREATE INDEX IF NOT EXISTS idx_products_attrs ON products USING gin (attributes)`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS products`)
  }
}

export class AddStock1717000000002 implements MigrationInterface {
  name = 'AddStock1717000000002'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock integer NOT NULL DEFAULT 0`)
    await q.query(`CREATE INDEX IF NOT EXISTS idx_products_stock ON products (stock)`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE products DROP COLUMN IF EXISTS stock`)
  }
}

export const migrations = [InitProducts1717000000001, AddStock1717000000002]
