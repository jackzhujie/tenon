/**
 * semver 子集的边界。
 *
 * 这些用例的存在理由只有一个：**版本判断错了不会报错**，只会表现成"插件不见了"或
 * "装了个不兼容的版本"。所以 `^0.x`（和 `^1.x` 规则不同）、预发布、认不出的写法
 * 这三类最容易错的地方各钉一条。
 */
import { describe, expect, it } from 'vitest'
import {
  InvalidVersionError,
  UnsupportedRangeError,
  compareVersionText,
  meetsMinTenonVersion,
  parseVersion,
  satisfiesRange,
} from '../src/version.js'

describe('版本号解析', () => {
  it('解析 MAJOR.MINOR.PATCH 与预发布', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2.3-beta.1').prerelease).toEqual(['beta', '1'])
  })

  it('忽略构建元数据', () => {
    expect(parseVersion('1.2.3+build.7').prerelease).toEqual([])
  })

  it('缺位数的版本号直接抛（`1.2` 不是 semver）', () => {
    expect(() => parseVersion('1.2')).toThrow(InvalidVersionError)
    expect(() => parseVersion('latest')).toThrow(InvalidVersionError)
  })
})

describe('版本比较', () => {
  it('按数值比，不是按字典序', () => {
    expect(compareVersionText('1.2.3', '1.10.0')).toBeLessThan(0)
  })

  it('预发布版小于对应的正式版', () => {
    expect(compareVersionText('1.2.3-beta.1', '1.2.3')).toBeLessThan(0)
    expect(compareVersionText('1.2.3-alpha', '1.2.3-beta')).toBeLessThan(0)
    expect(compareVersionText('1.2.3-alpha.1', '1.2.3-alpha.2')).toBeLessThan(0)
    expect(compareVersionText('1.2.3-alpha', '1.2.3-alpha.1')).toBeLessThan(0)
  })
})

describe('区间判断', () => {
  it('^ 在大版本上放开次版本（1.2.3 → <2.0.0）', () => {
    expect(satisfiesRange('1.9.9', '^1.2.3')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false)
  })

  it('^ 在 0.x 上只放开补丁（这是最容易写错的一条）', () => {
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false)
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
  })

  it('~ 只放开补丁', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
  })

  it('空格是 AND，|| 是 OR', () => {
    expect(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.1.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfiesRange('3.1.0', '^1.0.0 || ^3.0.0')).toBe(true)
    expect(satisfiesRange('2.1.0', '^1.0.0 || ^3.0.0')).toBe(false)
  })

  it('`*` 匹配正式版，但**不**匹配预发布版', () => {
    expect(satisfiesRange('1.2.3', '*')).toBe(true)
    // npm 语义：不写预发布就永远不装灰度版。少了这条，`*` 会把 beta 当正式版装上
    expect(satisfiesRange('1.2.3-beta.1', '*')).toBe(false)
  })

  it('预发布版需要区间里明确写出来', () => {
    expect(satisfiesRange('1.3.0-beta.1', '^1.2.3')).toBe(false)
    expect(satisfiesRange('1.2.3-beta.2', '>=1.2.3-beta.1')).toBe(true)
  })

  it('不认识的写法抛错，而不是悄悄返回 false', () => {
    for (const range of ['latest', '1.2', '>= 1.2.3', '* >=1.0.0', '', '^1.0.0 || ']) {
      expect(() => satisfiesRange('1.2.3', range), range).toThrow(UnsupportedRangeError)
    }
  })
})

describe('宿主最低版本', () => {
  it('0.0.0 是开发构建，视为满足一切（否则所有清单都得写 0.0.0）', () => {
    expect(meetsMinTenonVersion('0.0.0', '1.4.0')).toBe(true)
  })

  it('真实版本按数值比', () => {
    expect(meetsMinTenonVersion('1.4.0', '1.4.0')).toBe(true)
    expect(meetsMinTenonVersion('1.4.1', '1.4.0')).toBe(true)
    expect(meetsMinTenonVersion('1.2.0', '1.4.0')).toBe(false)
  })

  it('版本串读不出来时放行（这值来自我们自己的常量，判不了就当开发构建）', () => {
    expect(meetsMinTenonVersion('not-a-version', '1.4.0')).toBe(true)
  })
})
