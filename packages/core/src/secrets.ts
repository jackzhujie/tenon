/**
 * 本地密钥盒：AES-256-GCM + 一个 0600 的密钥文件。
 *
 * ⚠️ 定位说明（别自欺）：这是**防"随手看到"的静态加密**，不是 OS 密钥链。
 * - 桌面版接入 Electron 后换 `safeStorage`（DESIGN §6.1 的 `models.json.enc`）
 * - Web/自托管模式应换成环境变量或外部 KMS
 * 之所以现在就这么写：M1 不能因为「还没有 safeStorage」就把 API Key 明文落库。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { msg, TenonError } from '@tenon/protocol'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

export class SecretBox {
  private readonly key: Buffer

  private constructor(key: Buffer) {
    this.key = key
  }

  static open(keyFile: string): SecretBox {
    if (!existsSync(keyFile)) {
      mkdirSync(dirname(keyFile), { recursive: true })
      writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 })
      chmodSync(keyFile, 0o600)
    }
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64')
    if (key.byteLength !== 32) {
      throw new TenonError('INTERNAL', msg('error.secret.corrupt', { file: keyFile }))
    }
    return new SecretBox(key)
  }

  /** 输出 `iv | tag | ciphertext`，直接存 BLOB */
  seal(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  }

  unseal(blob: Buffer | Uint8Array): string {
    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
    if (buffer.byteLength <= IV_BYTES + TAG_BYTES) {
      throw new TenonError('INTERNAL', msg('error.secret.badLength'))
    }
    const iv = buffer.subarray(0, IV_BYTES)
    const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = buffer.subarray(IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv(ALGORITHM, this.key, iv)
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      // 换机器 / 删密钥文件后旧密文必然解不开，不要把 GCM 校验失败说成「密码错误」
      throw new TenonError('INTERNAL', msg('error.secret.mismatch'))
    }
  }
}
