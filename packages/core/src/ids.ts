import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 定长 base36 随机串。不用 uuid：目录名/分支名里出现 uuid 很难看，也不好差分数。 */
function randomBase36(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length]
  }
  return out
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBase36(16)}`
}

/**
 * 名称 → slug（用于目录与默认仓库名）。
 * 中文名会全部被吃掉，所以兜底 `app-<随机>`，保证 slug 永不为空且唯一性由调用方补后缀。
 */
export function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return ascii === '' ? `app-${randomBase36(6)}` : ascii
}
