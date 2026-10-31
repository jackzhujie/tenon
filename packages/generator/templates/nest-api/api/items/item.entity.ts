import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

/** 一张最小但完整的表：自增主键 + 文本 + 布尔 + 时区时间戳 */
@Entity({ name: 'items' })
export class ItemEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'text' })
  title!: string

  @Column({ type: 'boolean', default: false })
  done!: boolean

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date
}
