/**
 * semver 的一个**严格子集**。
 *
 * 为什么不用 `semver` 包：它不自带类型（要另装 `@types/semver`），而我们需要的只有
 * 「比较」和「区间判断」两件事。但更重要的理由是下面这条：
 *
 * **一个宽松实现的 semver，遇到自己不认识的写法会返回 `false`（插件永远装不上）或
 * `true`（不兼容的插件被装上），两种都不报错。** 组件装配里最怕的就是这个 ——
 * 用户看不出「为什么这个插件不见了」。所以这里的选择是：**不认识就抛**
 * `UnsupportedRangeError`，由 `plan.ts` 转成一条用户看得见的 problem。
 *
 * 支持：`1.2.3`、`1.2.3-beta.1`、`^1.2.3`、`~1.2.3`、`>=`/`>`/`<=`/`<`/`=`、
 * 空格分隔的 AND、`||` 分隔的 OR、`*`（整段）。
 * 不支持（会抛）：`1.2`、`1.x`、`latest`、范围里夹空片段。
 * 预发布版按 npm 语义处理：只有**同一 major.minor.patch 且带预发布**的比较项才放行它。
 */

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const COMPARATOR_RE = /^(\^|~|>=|<=|>|<|=)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

export class InvalidVersionError extends Error {
  constructor(readonly version: string) {
    super(`不是合法版本号「${version}」（要 MAJOR.MINOR.PATCH，例如 1.2.3）`)
    this.name = 'InvalidVersionError'
  }
}

export class UnsupportedRangeError extends Error {
  constructor(
    readonly range: string,
    readonly reason: string,
  ) {
    super(`不认识的版本区间「${range}」：${reason}`)
    this.name = 'UnsupportedRangeError'
  }
}

export function parseVersion(text: string): ParsedVersion {
  const match = VERSION_RE.exec(text.trim())
  if (match === null) throw new InvalidVersionError(text)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new InvalidVersionError(text)
  }
  const pre = match[4]
  return { major, minor, patch, prerelease: pre === undefined ? [] : pre.split('.') }
}

export function formatVersion(v: ParsedVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease.length === 0 ? base : `${base}-${v.prerelease.join('.')}`
}

function make(major: number, minor: number, patch: number, prerelease: readonly string[] = []): ParsedVersion {
  return { major, minor, patch, prerelease }
}

/** 预发布标识的比较（semver §11）：数字段按数值比，且数字段小于字母段 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // 有预发布的是「更小的那个」：1.2.3-beta < 1.2.3
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (xNumeric) return -1
    if (yNumeric) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** 按 semver 排序版本字符串（升序）。解析不了的排在最后 —— 让调用方在别处报错 */
export function compareVersionText(a: string, b: string): number {
  try {
    return compareVersions(parseVersion(a), parseVersion(b))
  } catch {
    return a < b ? -1 : 1
  }
}

type Op = '^' | '~' | '>=' | '>' | '<=' | '<' | '='

interface Comparator {
  readonly op: Op
  readonly version: ParsedVersion
}

interface Branch {
  /** 整段就是 `*`：任何版本（预发布仍然不放行） */
  readonly any: boolean
  readonly comparators: readonly Comparator[]
}

export function parseRange(range: string): Branch[] {
  const text = range.trim()
  if (text === '') throw new UnsupportedRangeError(range, '空区间（要写 `*` 或具体版本）')
  const branches: Branch[] = []
  for (const raw of text.split('||')) {
    const segment = raw.trim()
    if (segment === '') throw new UnsupportedRangeError(range, '`||` 两侧有空片段')
    if (segment === '*') {
      branches.push({ any: true, comparators: [] })
      continue
    }
    const comparators: Comparator[] = []
    for (const token of segment.split(/\s+/)) {
      if (token === '*') throw new UnsupportedRangeError(range, '`*` 只能单独成段，不能和比较项混用')
      const match = COMPARATOR_RE.exec(token)
      if (match === null) throw new UnsupportedRangeError(range, `不认识的片段「${token}」`)
      const op = (match[1] ?? '=') as Op
      comparators.push({ op, version: parseVersion(match[2] ?? '') })
    }
    branches.push({ any: false, comparators })
  }
  return branches
}

/** `^1.2.3` 的上界：`<2.0.0`；`^0.2.3` → `<0.3.0`；`^0.0.3` → `<0.0.4`（npm 语义） */
function caretUpper(v: ParsedVersion): ParsedVersion {
  if (v.major > 0) return make(v.major + 1, 0, 0)
  if (v.minor > 0) return make(0, v.minor + 1, 0)
  return make(0, 0, v.patch + 1)
}

function tildeUpper(v: ParsedVersion): ParsedVersion {
  return make(v.major, v.minor + 1, 0)
}

function sameTuple(a: ParsedVersion, b: ParsedVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}

function testComparator(v: ParsedVersion, c: Comparator): boolean {
  const cmp = compareVersions(v, c.version)
  switch (c.op) {
    case '=':
      return cmp === 0
    case '>=':
      return cmp >= 0
    case '>':
      return cmp > 0
    case '<=':
      return cmp <= 0
    case '<':
      return cmp < 0
    case '^':
      return cmp >= 0 && compareVersions(v, caretUpper(c.version)) < 0
    case '~':
      return cmp >= 0 && compareVersions(v, tildeUpper(c.version)) < 0
  }
}

export function satisfiesRange(version: string, range: string): boolean {
  return satisfiesParsed(parseVersion(version), range)
}

/** 已经解析过的版本（选版时会对同一个版本反复判多个区间，省一次解析） */
export function satisfiesParsed(v: ParsedVersion, range: string): boolean {
  for (const branch of parseRange(range)) {
    if (branch.any) {
      // `*` 不覆盖预发布版：这是 npm 的语义，也是「别把灰度版当正式版装上」的护栏
      if (v.prerelease.length === 0) return true
      continue
    }
    if (!branch.comparators.every((c) => testComparator(v, c))) continue
    /*
     * 预发布版的放行条件：区间里必须有一项**明确写了**同一 major.minor.patch 的预发布。
     * 少了这一步，`^1.2.3` 会把 `1.3.0-beta.1` 判成满足 —— 用户装到的是灰度版。
     */
    if (v.prerelease.length === 0) return true
    const explicit = branch.comparators.some(
      (c) => c.version.prerelease.length > 0 && sameTuple(c.version, v),
    )
    if (explicit) return true
  }
  return false
}

/** 区间是否可解析（装配声明里写错区间时，要给用户一条能看懂的提示） */
export function isRangeValid(range: string): boolean {
  try {
    parseRange(range)
    return true
  } catch {
    return false
  }
}

function isAllZero(v: ParsedVersion): boolean {
  return v.major === 0 && v.minor === 0 && v.patch === 0 && v.prerelease.length === 0
}

/**
 * 宿主版本够不够装这个组件。
 *
 * **`0.0.0` 判为满足**：仓库里的构建就是 `0.0.0`，它代表「还没发版的开发树」——
 * 比任何已发布版本都新。不这么判的话，所有清单都得写成 `minTenonVersion: "0.0.0"`，
 * 这个字段当场失去意义。版本串解析不了时同样放行：这个值来自我们自己的常量，
 * 而「判不了就拦」会让手误改一次版本号就把所有插件挡在门外。
 *
 * 代价要说清楚：**开发构建测不出 `minTenonVersion` 写错**。所以这个判断有单独的测试 +
 * 一个「把 host 当 1.4.0 传进去」的用例覆盖真实分支。
 */
export function meetsMinTenonVersion(hostVersion: string, minVersion: string): boolean {
  let host: ParsedVersion
  try {
    host = parseVersion(hostVersion)
  } catch {
    return true
  }
  if (isAllZero(host)) return true
  return compareVersions(host, parseVersion(minVersion)) >= 0
}
