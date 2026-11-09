/**
 * 口令哈希：Node 自带的 `scrypt`。
 *
 * 为什么不用 argon2 / bcrypt：这两个都是**原生模块**，要按平台编译。生成应用的依赖
 * 不许引入这类包（STATUS §5 的边界：用户在本地 `pnpm install`，Windows 上没装
 * Visual Studio 就卡在 node-gyp，而报错看起来像网络问题）。`node:crypto` 里就有
 * scrypt —— 内存硬、OWASP 认可，零依赖、零编译。
 *
 * 哈希串自带算法与参数（`scrypt$keylen$salt$hash`）。这不是多余的仪式：
 * 以后想调强度（keylen 或 N/r/p），老口令仍然验得过，不需要"强制所有人改密码"。
 * 参数一旦写死在校验逻辑里，调强度就等于让所有人重置。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/** 派生长度（字节）。会写进哈希串，所以改它不会破坏老口令 */
const KEY_LENGTH = 64
const SALT_LENGTH = 16

function derive(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (error, key) => {
      if (error !== null) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, KEY_LENGTH)
  return ['scrypt', String(KEY_LENGTH), salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, keyLengthText, saltText, keyText] = stored.split('$')
  if (
    algorithm !== 'scrypt' ||
    keyLengthText === undefined ||
    saltText === undefined ||
    keyText === undefined
  ) {
    return false
  }
  const keyLength = Number(keyLengthText)
  if (!Number.isInteger(keyLength) || keyLength < 16) return false
  const salt = Buffer.from(saltText, 'base64')
  const expected = Buffer.from(keyText, 'base64')
  if (salt.length === 0 || expected.length !== keyLength) return false
  const actual = await derive(password, salt, keyLength)
  /* 长度不等时 `timingSafeEqual` 会抛（不是返回 false），所以先比长度再比内容 */
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
