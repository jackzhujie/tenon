/**
 * 装配声明 `app.components.json` 的读写。
 *
 * 两条要害：
 * - **文件不存在 ≠ 坏了**。新应用本来就没有这份文件，读成"空装配"是正常的；
 *   读成"错误"会让每个新应用的插件页一打开就红。
 * - **写必须是原子的**。写到一半被杀，剩下的半截 JSON 会被读成"声明坏了"，
 *   表现是所有组件一起消失 —— 而这种坏法只在断电/强杀时出现，最难复现。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TenonError } from '@tenon/protocol'
import {
  ASSEMBLY_FILE,
  emptyAssembly,
  readAssembly,
  removeComponent,
  upsertComponent,
  writeAssembly,
} from '../src/assembly.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenon-assembly-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('读', () => {
  it('文件不存在时是空装配，不是错误', async () => {
    const read = await readAssembly(dir)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.exists).toBe(false)
    expect(read.assembly.components).toEqual([])
  })

  it('坏 JSON 是 invalid，并带上文件名', async () => {
    await writeFile(join(dir, ASSEMBLY_FILE), '{"components": [', 'utf8')
    const read = await readAssembly(dir)
    expect(read.kind).toBe('invalid')
    if (read.kind === 'invalid') expect(read.issues.join()).toContain(ASSEMBLY_FILE)
  })

  it('声明格式版本对不上就拒（不猜怎么迁移）', async () => {
    await writeFile(join(dir, ASSEMBLY_FILE), JSON.stringify({ version: 2, components: [] }), 'utf8')
    expect((await readAssembly(dir)).kind).toBe('invalid')
  })

  it('prefix 不以 / 开头被拒', async () => {
    await writeFile(
      join(dir, ASSEMBLY_FILE),
      JSON.stringify({ components: [{ id: 'tenon.official.a', mount: [{ slot: 'app.api', prefix: 'c/a' }] }] }),
      'utf8',
    )
    const read = await readAssembly(dir)
    expect(read.kind).toBe('invalid')
    if (read.kind === 'invalid') expect(read.issues.join()).toContain('prefix')
  })
})

describe('写', () => {
  it('写进去再读回来，默认值都补齐了', async () => {
    await writeAssembly(dir, {
      version: 1,
      components: [{ id: 'tenon.official.ai-assistant', version: '^1.0.0', license: 'free', enabled: true, mount: [{ slot: 'app.shell.overlay', order: 100 }] }],
    })
    const read = await readAssembly(dir)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.exists).toBe(true)
    expect(read.assembly.components[0]).toEqual({
      id: 'tenon.official.ai-assistant',
      version: '^1.0.0',
      license: 'free',
      enabled: true,
      mount: [{ slot: 'app.shell.overlay', order: 100 }],
    })
  })

  it('文件以换行结尾、缩进两格（进 git 之后 diff 好看）', async () => {
    await writeAssembly(dir, emptyAssembly())
    const text = await readFile(join(dir, ASSEMBLY_FILE), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "components"')
  })

  it('不留下临时文件（原子写的副作用必须清掉）', async () => {
    await writeAssembly(dir, emptyAssembly())
    const names = await readdir(dir)
    expect(names.filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('不合法的装配拒绝写入（宁可报错，也不落一份坏文件）', async () => {
    await expect(
      writeAssembly(dir, { version: 2, components: [] } as never),
    ).rejects.toBeInstanceOf(TenonError)
  })
})

describe('增删', () => {
  it('同 id 整条替换，不是字段合并', () => {
    const base = emptyAssembly()
    const first = upsertComponent(base, { id: 'a.b', version: '^1.0.0', license: 'free', enabled: true, mount: [] })
    const second = upsertComponent(first, { id: 'a.b', version: '^2.0.0', license: 'free', enabled: false, mount: [] })
    expect(second.components).toHaveLength(1)
    expect(second.components[0]?.version).toBe('^2.0.0')
    expect(second.components[0]?.enabled).toBe(false)
  })

  it('删不存在的 id 不报错（幂等）', () => {
    const base = emptyAssembly()
    expect(removeComponent(base, 'a.b').components).toEqual([])
  })
})
