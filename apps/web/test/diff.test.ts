import { describe, expect, it } from 'vitest'
import type { DiffFile, DiffLine } from '@tenon/protocol'
import { collapseContext, diffTotals, shortPath } from '../src/lib/diff.js'

const ctx = (text: string, oldLine: number, newLine: number): DiffLine => ({
  kind: 'ctx',
  text,
  oldLine,
  newLine,
})
const add = (text: string, newLine: number): DiffLine => ({
  kind: 'add',
  text,
  oldLine: null,
  newLine,
})
const del = (text: string, oldLine: number): DiffLine => ({
  kind: 'del',
  text,
  oldLine,
  newLine: null,
})

function file(patch: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/App.tsx',
    status: 'modified',
    insertions: 1,
    deletions: 1,
    lines: [],
    patch: '',
    ...patch,
  }
}

describe('折叠上下文', () => {
  it('改动上下各留 3 行，中间折成一条跳过', () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => ctx(`line ${String(i + 1)}`, i + 1, i + 1)),
      add('new', 11),
      ...Array.from({ length: 20 }, (_, i) => ctx(`tail ${String(i + 1)}`, i + 11, i + 12)),
    ]
    const rows = collapseContext(lines)

    // 前面 10 行里，只有最后 3 行（7、8、9）该留下
    expect(rows[0]).toEqual({ kind: 'skip', count: 7 })
    expect(rows[1]).toMatchObject({ kind: 'ctx', text: 'line 8' })
    expect(rows.filter((row) => row.kind === 'add')).toHaveLength(1)
    // 末尾也要折
    expect(rows[rows.length - 1]).toEqual({ kind: 'skip', count: 17 })
  })

  it('文件开头就是改动时不插「跳过 0 行」', () => {
    const rows = collapseContext([add('a', 1), ctx('b', 1, 2), ctx('c', 2, 3)])
    expect(rows.map((row) => row.kind)).toEqual(['add', 'ctx', 'ctx'])
  })

  it('两处改动隔得很近时合成一段，而不是切两个 hunk', () => {
    // 两个改动中间只隔 2 行 → 都在 ±3 的窗口里，全都保留
    const lines = [
      ctx('1', 1, 1),
      del('2', 2),
      ctx('3', 3, 2),
      ctx('4', 4, 3),
      add('5', 4),
      ctx('6', 5, 5),
    ]
    const rows = collapseContext(lines)
    expect(rows.some((row) => row.kind === 'skip')).toBe(false)
    expect(rows).toHaveLength(6)
  })

  it('context 给 0 时只留改动行本身', () => {
    const lines = [ctx('1', 1, 1), add('2', 2), ctx('3', 2, 3)]
    const rows = collapseContext(lines, 0)
    expect(rows.map((row) => row.kind)).toEqual(['skip', 'add', 'skip'])
  })

  it('全是 context 时整份折成一条（不该出现的输入，但不能崩）', () => {
    const rows = collapseContext([ctx('a', 1, 1), ctx('b', 2, 2)])
    expect(rows).toEqual([{ kind: 'skip', count: 2 }])
  })
})

describe('总量统计', () => {
  it('按状态分类计数', () => {
    const totals = diffTotals([
      file({ status: 'added', insertions: 10, deletions: 0 }),
      file({ status: 'modified', insertions: 3, deletions: 2 }),
      file({ status: 'deleted', insertions: 0, deletions: 7 }),
    ])
    expect(totals).toEqual({
      files: 3,
      insertions: 13,
      deletions: 9,
      added: 1,
      modified: 1,
      deleted: 1,
    })
  })

  it('空输入全零', () => {
    expect(diffTotals([])).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
      added: 0,
      modified: 0,
      deleted: 0,
    })
  })
})

describe('路径显示', () => {
  it('只保留最后两段，避免同名文件看混', () => {
    expect(shortPath('src/components/ui/Button.tsx')).toBe('ui/Button.tsx')
    expect(shortPath('package.json')).toBe('package.json')
    expect(shortPath('src/App.tsx')).toBe('src/App.tsx')
  })
})
