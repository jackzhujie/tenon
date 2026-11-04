/**
 * Hub 配置的解析优先级（M6 第 5 步）。
 *
 * 这一组用例守的是**一个静默失败**：打包版双击打开时没有环境变量，如果配置只能
 * 来自环境变量，组件商店会永远显示"未配置"—— 界面上不报错、日志里没痕迹，
 * 只有用户心里一句"这商店怎么是空的"。
 *
 * 所以真正的断言不是"能读到配置"，而是三种状态被分清楚了：
 * - 就是没配（`config`/`origin`/`note` 全 null）→ 界面显示「筹备中」
 * - 配了但不对（`note` 有话说）→ 界面显示原因
 * - 配好了（`origin` 说明来源）→ 界面显示地址、指纹、来源
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HUB_CONFIG_FILE_ENV,
  HUB_PUBLIC_KEY_ENV,
  HUB_URL_ENV,
  hubConfigFromEnv,
  resolveHubConfig,
} from '../src/hub.js'

const { publicKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** 只有两行的假读取器：不碰磁盘的用例用它，断言的是"读到了哪个分支" */
function reader(files: Record<string, string>) {
  return (path: string): string => {
    const value = files[path]
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  }
}

const FILE = '/fake/resources/hub.json'
const good = JSON.stringify({ hubUrl: 'https://hub.tenon.dev', publicKey: PUBLIC_PEM })

describe('resolveHubConfig', () => {
  it('环境变量两个都有 → 用它，来源是 env，URL 去掉尾斜杠', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_URL_ENV]: 'https://hub.example.com//', [HUB_PUBLIC_KEY_ENV]: PUBLIC_PEM },
    })
    expect(resolved.origin).toBe('env')
    expect(resolved.config?.hubUrl).toBe('https://hub.example.com')
    // 两处入口都 trim：PEM 的尾换行不该参与指纹（否则"同一把 key"会有两个指纹）
    expect(resolved.config?.publicKey).toBe(PUBLIC_PEM.trim())
    expect(resolved.note).toBeNull()
  })

  it('环境变量优先于随包配置（换源调试时不该被包里的旧地址盖住）', () => {
    const resolved = resolveHubConfig({
      env: {
        [HUB_URL_ENV]: 'http://127.0.0.1:9000',
        [HUB_PUBLIC_KEY_ENV]: PUBLIC_PEM,
        [HUB_CONFIG_FILE_ENV]: FILE,
      },
      readFile: reader({ [FILE]: good }),
    })
    expect(resolved.origin).toBe('env')
    expect(resolved.config?.hubUrl).toBe('http://127.0.0.1:9000')
  })

  it('环境变量只给了 URL → 按"配错了"处理，且**不**回落到文件', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_URL_ENV]: 'https://a.example.com', [HUB_CONFIG_FILE_ENV]: FILE },
      readFile: reader({ [FILE]: good }),
    })
    expect(resolved.config).toBeNull()
    expect(resolved.origin).toBeNull()
    // 回落会让"我改了地址"看起来生效了，而它一定验不过签（公钥还是旧的）
    expect(resolved.note).toContain('公钥')
  })

  it('没有环境变量、有随包配置 → 来源是 file', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_CONFIG_FILE_ENV]: FILE },
      readFile: reader({ [FILE]: good }),
    })
    expect(resolved.origin).toBe('file')
    expect(resolved.config?.hubUrl).toBe('https://hub.tenon.dev')
  })

  it('什么都没给 → 三个字段全 null（这是"没配"，不是错误）', () => {
    const resolved = resolveHubConfig({ env: {} })
    expect(resolved).toEqual({ config: null, origin: null, note: null })
  })

  it('随包配置文件不存在 → 说出来（壳指错路径是打包漏了东西）', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_CONFIG_FILE_ENV]: FILE },
      readFile: reader({}),
    })
    expect(resolved.config).toBeNull()
    expect(resolved.note).toContain('读不到')
  })

  it('打包时没配 Hub（build.mjs 写的空值占位）→ 当"没配"，不报配置错误', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_CONFIG_FILE_ENV]: FILE },
      readFile: reader({ [FILE]: JSON.stringify({ hubUrl: '', publicKey: '' }) }),
    })
    expect(resolved).toEqual({ config: null, origin: null, note: null })
  })

  it('字段名拼错 → 说出来（否则又是一个"商店为什么是空的"）', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_CONFIG_FILE_ENV]: FILE },
      readFile: reader({ [FILE]: JSON.stringify({ hubURL: 'https://x.dev', key: PUBLIC_PEM }) }),
    })
    expect(resolved.config).toBeNull()
    expect(resolved.note).toContain('hubUrl')
  })

  it('坏 JSON → 说出来，不抛', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_CONFIG_FILE_ENV]: FILE },
      readFile: reader({ [FILE]: '{ hubUrl: ' }),
    })
    expect(resolved.config).toBeNull()
    expect(resolved.note).toContain('JSON')
  })

  it('地址不是 http(s) → 拒（`file://` 会让"下载"变成"读本机任意文件"）', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_URL_ENV]: 'file:///etc', [HUB_PUBLIC_KEY_ENV]: PUBLIC_PEM },
    })
    expect(resolved.config).toBeNull()
    expect(resolved.note).toContain('http')
  })

  it('公钥不是 PEM 形状 → 拒（否则报错要到第一次安装才出现）', () => {
    const resolved = resolveHubConfig({
      env: { [HUB_URL_ENV]: 'https://a.example.com', [HUB_PUBLIC_KEY_ENV]: 'not-a-key' },
    })
    expect(resolved.config).toBeNull()
    expect(resolved.note).toContain('PEM')
  })

  it('PEM 里的字面量 \\n 会还原（systemd / docker compose 都这么写）', () => {
    const oneLine = PUBLIC_PEM.replaceAll('\n', '\\n')
    const resolved = resolveHubConfig({
      env: { [HUB_URL_ENV]: 'https://a.example.com', [HUB_PUBLIC_KEY_ENV]: oneLine },
    })
    expect(resolved.config?.publicKey).toBe(PUBLIC_PEM.trim())
  })
})

describe('resolveHubConfig 读真文件', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tenon-hub-config-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('默认用 readFileSync 读，构建产物那份能被原样吃下', async () => {
    const file = join(dir, 'hub.json')
    // 与 build.mjs 写出来的形状一致（两空格缩进 + 结尾换行）
    await writeFile(file, `${JSON.stringify({ hubUrl: 'https://hub.tenon.dev', publicKey: PUBLIC_PEM }, null, 2)}\n`)
    const resolved = resolveHubConfig({ env: { [HUB_CONFIG_FILE_ENV]: file } })
    expect(resolved.origin).toBe('file')
    expect(resolved.config?.hubUrl).toBe('https://hub.tenon.dev')
  })
})

describe('hubConfigFromEnv', () => {
  it('只看环境变量：文件配好了也返回 null（`startServer` 之外的调用方不该被磁盘影响）', () => {
    expect(hubConfigFromEnv({ [HUB_CONFIG_FILE_ENV]: FILE })).toBeNull()
  })

  it('两个都给才算配置', () => {
    expect(hubConfigFromEnv({ [HUB_URL_ENV]: 'https://a.example.com' })).toBeNull()
    expect(
      hubConfigFromEnv({ [HUB_URL_ENV]: 'https://a.example.com', [HUB_PUBLIC_KEY_ENV]: PUBLIC_PEM })?.hubUrl,
    ).toBe('https://a.example.com')
  })
})
