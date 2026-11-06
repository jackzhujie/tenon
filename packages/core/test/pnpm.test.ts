/**
 * 「哪个 pnpm、怎么 spawn」的单元测试。
 *
 * 这些断言在 macOS 上也有意义 —— 因为**平台是参数**（`resolvePnpm(env, platform)`）。
 * 三平台 CI 第一次跑时，Windows 一列全挂在 `spawn pnpm ENOENT` 上：那边 `pnpm` 实际是
 * `pnpm.cmd`，Node 的 spawn 不做 PATHEXT 补全，而且从 18.20/20.12 起 `.cmd` 必须过 shell。
 * 把平台做成参数之后，这条判断就能在任意一台机器上锁住。
 */
import { describe, expect, it } from 'vitest'
import { invokePnpm, resolvePnpm } from '../src/pnpm.js'

describe('resolvePnpm', () => {
  it('TENON_PNPM 指向 .cjs → 用 node 跑，且不过 shell（Windows 上也一样）', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const pm = resolvePnpm({ TENON_PNPM: '/opt/pnpm/bin/pnpm.cjs' }, platform)
      expect(pm).toMatchObject({ command: '/opt/pnpm/bin/pnpm.cjs', isScript: true, shell: false })
    }
  })

  it('TENON_PNPM 指向可执行文件 → 只有 Windows 需要 shell', () => {
    expect(resolvePnpm({ TENON_PNPM: 'C:\\tools\\pnpm.exe' }, 'win32').shell).toBe(true)
    expect(resolvePnpm({ TENON_PNPM: '/usr/local/bin/pnpm' }, 'darwin').shell).toBe(false)
    expect(resolvePnpm({ TENON_PNPM: '/usr/local/bin/pnpm' }, 'linux').shell).toBe(false)
  })

  it('兜底时 Windows 用 pnpm.cmd 且开 shell', () => {
    const pm = resolvePnpm({}, 'win32')
    /*
     * 打包/某些开发机上会命中"随包的 pnpm.cjs"（那就不走兜底了）。
     * 判据分两种形态，别把"没命中兜底"当成失败。
     */
    if (pm.isScript) {
      expect(pm.shell).toBe(false)
    } else {
      expect(pm.command.endsWith('pnpm.cmd')).toBe(true)
      expect(pm.shell).toBe(true)
    }
  })

  it('兜底时 POSIX 不开 shell（开了反而会多一层 sh，退出码与信号都变味）', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolvePnpm({}, platform).shell).toBe(false)
    }
  })

  it('空字符串的 TENON_PNPM 当没设（否则会 spawn 一个空命令）', () => {
    expect(resolvePnpm({ TENON_PNPM: '' }, 'linux').command).not.toBe('')
  })
})

describe('invokePnpm', () => {
  it('脚本形态 → node + [cjs, ...args]，shell 必须关掉', () => {
    const call = invokePnpm({ command: '/x/pnpm.cjs', isScript: true, shell: false }, ['run', 'lint'])
    expect(call.command).toBe(process.execPath)
    expect(call.args).toEqual(['/x/pnpm.cjs', 'run', 'lint'])
    // 已经是 node + 真实文件，再过一层 shell 只会让退出码失真
    expect(call.shell).toBe(false)
  })

  it('可执行形态 → 原样透传，shell 跟随包管理器', () => {
    const call = invokePnpm({ command: 'pnpm.cmd', isScript: false, shell: true }, ['run', 'test'])
    expect(call).toEqual({ command: 'pnpm.cmd', args: ['run', 'test'], shell: true })
  })

  it('参数是副本：调用方改了原数组，已经构造好的调用不受影响', () => {
    const args = ['run', 'lint']
    const call = invokePnpm({ command: 'pnpm', isScript: false, shell: false }, args)
    args.push('--fix')
    expect(call.args).toEqual(['run', 'lint'])
  })
})
