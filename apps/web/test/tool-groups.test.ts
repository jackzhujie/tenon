/**
 * 合并只读探索动作的测试。
 *
 * 命令样例直接取自真实截图（那次"排查 lint 为什么失败"的探索就是这几条），
 * 不写成教科书里的 `ls -la` —— 要防的是"实际会遇到的命令被判断错"。
 */
import { describe, expect, it } from 'vitest'
import { makeT } from '../src/lib/i18n.js'
import {
  describeExploration,
  groupActivities,
  isReadOnlyCommand,
  isExploration,
  type Activity,
} from '../src/lib/tool-groups.js'

function bash(command: string, status: Activity['status'] = 'ok'): Activity {
  return { toolCallId: `c-${command}`, name: 'bash', args: { command }, status }
}

function read(path: string): Activity {
  return { toolCallId: `r-${path}`, name: 'read', args: { path }, status: 'ok' }
}

function write(path: string): Activity {
  return { toolCallId: `w-${path}`, name: 'write', args: { path }, status: 'ok' }
}

const zh = makeT('zh')

describe('只读命令判定', () => {
  it('截图里那几条探索命令都是只读', () => {
    expect(isReadOnlyCommand("cat package.json 2>/dev/null; echo '---'; ls -la")).toBe(true)
    expect(isReadOnlyCommand('find src api shared -type f | head -100')).toBe(true)
    expect(isReadOnlyCommand("sed -n '80,160p' src/styles.css; echo '### docs'; ls docs")).toBe(true)
    expect(isReadOnlyCommand('cat vite.config.ts tsconfig.json tsconfig.server.json')).toBe(true)
    expect(isReadOnlyCommand('cd /Users/mac/x 2>/dev/null || cd /Users/mac/y; ls')).toBe(true)
  })

  it('会写盘的一律不算', () => {
    expect(isReadOnlyCommand('rm -rf dist')).toBe(false)
    expect(isReadOnlyCommand('echo hi > out.txt')).toBe(false)
    expect(isReadOnlyCommand('sed -i "" "s/a/b/" src/App.tsx')).toBe(false)
    expect(isReadOnlyCommand('find . -name "*.ts" -delete')).toBe(false)
    expect(isReadOnlyCommand('pnpm add zod')).toBe(false)
    expect(isReadOnlyCommand('pnpm run build')).toBe(false)
    expect(isReadOnlyCommand('git commit -m "x"')).toBe(false)
    expect(isReadOnlyCommand('git add -A')).toBe(false)
    expect(isReadOnlyCommand('node -e "require(\'fs\').writeFileSync(\'x\',\'\')"')).toBe(false)
  })

  it('复合命令里混进一条写操作就不算只读', () => {
    expect(isReadOnlyCommand('cat a && rm b')).toBe(false)
    expect(isReadOnlyCommand('ls; git checkout main')).toBe(false)
  })

  it('重定向：/dev/null 与 2>&1 不算写盘，其它算', () => {
    expect(isReadOnlyCommand('cat package.json 2>/dev/null')).toBe(true)
    expect(isReadOnlyCommand('ls >/dev/null')).toBe(true)
    expect(isReadOnlyCommand('cat a 2>&1 | head -5')).toBe(true)
    expect(isReadOnlyCommand('ls > files.txt')).toBe(false)
  })

  it('git 只看子命令', () => {
    expect(isReadOnlyCommand('git log --oneline -5')).toBe(true)
    expect(isReadOnlyCommand('git status --short')).toBe(true)
    expect(isReadOnlyCommand('git diff HEAD~1')).toBe(true)
    expect(isReadOnlyCommand('git reset --hard')).toBe(false)
  })
})

describe('编组', () => {
  it('连续三条探索并成一组，且保留顺序', () => {
    const entries = groupActivities([bash('ls -la'), read('README.md'), bash('find src -type f')])
    expect(entries).toHaveLength(1)
    const group = entries[0]
    if (group?.kind !== 'explore') throw new Error('没并成一组')
    expect(group.items).toHaveLength(3)
    expect(group.items[1]?.args?.['path']).toBe('README.md')
  })

  it('写操作切分探索组（用户要看见"改了什么"）', () => {
    const entries = groupActivities([
      bash('cat package.json'),
      read('src/App.tsx'),
      write('src/App.tsx'),
      bash('cat tsconfig.json'),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['explore', 'single', 'single'])
  })

  it('只有一条探索时保持独立（"探索 1 项"是噪声）', () => {
    const entries = groupActivities([bash('cat package.json')])
    expect(entries[0]?.kind).toBe('single')
  })

  it('出错的探索不并进去（失败必须独立可见）', () => {
    const failed: Activity = { ...bash('cat nope.txt'), status: 'error' }
    const entries = groupActivities([bash('ls'), failed, bash('cat a')])
    expect(entries.map((entry) => entry.kind)).toEqual(['single', 'single', 'single'])
  })

  it('running 中的探索也照样合并（它正是最该收起来的那一批）', () => {
    const running: Activity = { ...bash('find src -type f'), status: 'running' }
    const entries = groupActivities([running, read('src/App.tsx')])
    expect(entries[0]?.kind).toBe('explore')
  })

  it('subagent / 组件工具不并进探索', () => {
    expect(isExploration({ toolCallId: 'x', name: 'subagent', args: { role: 'explore' }, status: 'ok' })).toBe(false)
    expect(isExploration({ toolCallId: 'y', name: 'install_component', args: { id: 'csv' }, status: 'ok' })).toBe(false)
  })
})

describe('摘要文案', () => {
  it('文件与命令分开数', () => {
    expect(describeExploration([read('a'), read('b'), bash('ls'), bash('find .')], zh)).toBe(
      '读取 2 个文件 · 执行 2 条命令',
    )
  })

  it('只有命令时不说"读取 0 个文件"', () => {
    expect(describeExploration([bash('ls'), bash('pwd')], zh)).toBe('执行 2 条命令')
  })
})
