/**
 * 生成应用里的典型实体：故意全用 PG 专有类型（uuid / jsonb / timestamptz / numeric），
 * 因为「方言一致」才是 PGlite 选型的核心理由 —— 换到真 PG 不需要改一行。
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

@Entity({ name: 'products' })
@Index('idx_products_sku', ['sku'], { unique: true })
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'varchar', length: 64 })
  sku!: string

  @Column({ type: 'varchar', length: 200 })
  title!: string

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  price!: string

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  attributes!: Record<string, unknown>

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date
}
