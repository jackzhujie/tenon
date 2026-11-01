/**
 * 「这次提交动没动表结构」—— 快照触发判据。
 *
 * 这个判据错了**不会有任何报错**：要么每一轮都存几 MB 的快照把盘塞满，
 * 要么该存的时候没存，于是回滚按钮看着能用、实际把库留在了新版本。
 * 所以正例和反例都要钉住，尤其是那些"看着像但不是"的路径。
 */
import { describe, expect, it } from 'vitest'
import { hasSchemaChange, isSchemaChange } from '../src/schema-change.js'

describe('isSchemaChange', () => {
  it('算：迁移文件', () => {
    expect(isSchemaChange('api/migrations/1767225600000-InitItems.ts')).toBe(true)
    expect(isSchemaChange('migrations/001-init.js')).toBe(true)
    // 迁移文件也可能放在更深一层
    expect(isSchemaChange('api/src/db/migrations/1767225600000-x.ts')).toBe(true)
  })

  it('算：实体定义', () => {
    expect(isSchemaChange('api/src/items/item.entity.ts')).toBe(true)
    expect(isSchemaChange('item.entity.ts')).toBe(true)
    expect(isSchemaChange('api/src/items/item.entity.js')).toBe(true)
  })

  it('算：前后端共享的 zod schema', () => {
    expect(isSchemaChange('shared/schema.ts')).toBe(true)
    expect(isSchemaChange('api/src/shared/schema.ts')).toBe(true)
  })

  it('不算：普通源码（改样式、改文案都不该触发快照）', () => {
    expect(isSchemaChange('src/App.tsx')).toBe(false)
    expect(isSchemaChange('src/index.css')).toBe(false)
    expect(isSchemaChange('api/src/items/items.service.ts')).toBe(false)
    expect(isSchemaChange('api/src/items/item.controller.ts')).toBe(false)
    expect(isSchemaChange('README.md')).toBe(false)
    expect(isSchemaChange('package.json')).toBe(false)
  })

  it('不算：名字里带 migration / entity / schema 但不是那三个位置', () => {
    // 目录名对了但扩展名不对：文档里写"下一版要加这张表"不该触发
    expect(isSchemaChange('migrations/README.md')).toBe(false)
    // 只是名字里有 migration
    expect(isSchemaChange('src/migration-helper.ts')).toBe(false)
    // schema 但不在 shared/ 下（比如页面级的表单校验）
    expect(isSchemaChange('src/pages/user/schema.ts')).toBe(false)
    // 实体的测试文件：改了它不影响表结构
    expect(isSchemaChange('api/src/items/item.entity.spec.ts')).toBe(false)
  })

  it('Windows 风格分隔符也认', () => {
    expect(isSchemaChange('api\\migrations\\001-init.ts')).toBe(true)
    expect(isSchemaChange('api\\src\\item.entity.ts')).toBe(true)
  })
})

describe('hasSchemaChange', () => {
  it('一批里只要有一条命中就算', () => {
    expect(hasSchemaChange(['src/App.tsx', 'api/migrations/001.ts'])).toBe(true)
    expect(hasSchemaChange(['src/App.tsx', 'src/index.css'])).toBe(false)
    expect(hasSchemaChange([])).toBe(false)
  })
})
