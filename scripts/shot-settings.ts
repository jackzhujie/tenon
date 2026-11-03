/**
 * 设置页的**人眼验收**：真 Chromium 里点开顶栏的模型标签，看面板长得对不对。
 *
 * 为什么单独做（而不是只跑单测）：这一页的难点全在"看得见的东西"上 ——
 * 未配置时那行黄字有没有出来、表单挤不挤、按钮点得动点不动。
 * 上一轮我自己批评过"界面只过了类型检查，没在浏览器里看过"，这次先看再交。
 *
 * 用法：`pnpm shot:settings`（会先 build:web，然后截图到 /tmp/tenon-settings/*.png）
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startServer } from '../packages/server/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const require = createRequire(import.meta.url)
const electronPath = require(join(repo, 'apps', 'desktop', 'node_modules', 'electron')) as unknown as string

const TOKEN = 'shot-token'
const outDir = '/tmp/tenon-settings'
await mkdir(outDir, { recursive: true })

/** 一个只会说 ok 的 OpenAI 兼容端点 —— 让"点保存"这一步真的能通 */
const fake = createServer((req, res) => {
  if (req.method === 'POST' && (req.url ?? '').includes('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`

const home = await mkdtemp(join(tmpdir(), 'tenon-shot-'))
const server = await startServer({
  port: 0,
  token: TOKEN,
  env: { TENON_HOME: home, TENON_FAUX: '' },
  webDir: join(repo, 'apps', 'web', 'dist'),
})
console.log(`服务 ${server.url}`)

function electronMain(): string {
  return `const { app, BrowserWindow } = require('electron')
const url = ${JSON.stringify(server.url)}
const out = ${JSON.stringify(outDir)}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })
  const frame = win.webContents.mainFrame
  await win.loadURL(url)
  await sleep(2500)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/1-未配置.png', img.toPNG()))

  // 顶栏那个按钮：未配置时它的文案是「未配置模型」
  const clicked = await frame.executeJavaScript(\`(() => {
    const btn = [...document.querySelectorAll('button')].find((node) => /未配置模型|配置模型|deepseek|gpt|mock/.test(node.textContent || ''))
    if (!btn) return false
    btn.click()
    return true
  })()\`)
  await sleep(900)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/2-面板.png', img.toPNG()))

  // 点「添加提供商」，填一个假的，看表单
  const form = await frame.executeJavaScript(\`(() => {
    const add = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '添加提供商')
    if (!add) return false
    add.click()
    return true
  })()\`)
  await sleep(600)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/3-表单.png', img.toPNG()))

  /*
   * 填表并保存 —— 这一步才是"设置页真的能用"的证据。
   * 受控输入必须走**原型上的原生 setter**：直接赋值 React 收不到变更（value tracker），
   * 现象是输入框看着有字、点保存说"名称和模型 id 都得填"。
   */
  const saved = await frame.executeJavaScript(\`(() => {
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const panel = document.querySelector('.absolute.right-0.top-9') || document.body
    const inputs = [...panel.querySelectorAll('input')]
    if (inputs.length < 4) return { ok: false, reason: 'inputs=' + inputs.length }
    setValue(inputs[0], '截图用假端点')
    setValue(inputs[1], 'shot-model')
    setValue(inputs[2], ${JSON.stringify(fakeUrl)})
    setValue(inputs[3], 'sk-shot')
    const save = [...panel.querySelectorAll('button')].find((node) => /保存并启用/.test(node.textContent || ''))
    if (!save) return { ok: false, reason: '没有保存按钮' }
    save.click()
    return { ok: true }
  })()\`)

  await sleep(1800)
  await win.capturePage().then((img) => require('node:fs').writeFileSync(out + '/4-已保存.png', img.toPNG()))
  const header = await frame.executeJavaScript(
    \`(() => { const b = [...document.querySelectorAll('button')].find((n) => /shot-model|未配置模型|假模型/.test(n.textContent || '')); return b ? b.textContent : null })()\`,
  )

  await win.close()
  return { clicked, form, saved, header }
}

app.whenReady().then(async () => {
  try {
    process.stdout.write('SHOT ' + JSON.stringify(await run()) + '\\n')
  } catch (error) {
    process.stdout.write('SHOT_ERR ' + String((error && error.message) || error) + '\\n')
  } finally {
    app.exit(0)
  }
})
`
}

try {
  const mainFile = join(home, 'shot-main.cjs')
  await writeFile(mainFile, electronMain(), 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['--no-sandbox', mainFile], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString()
    if (!line.includes('DevTools')) process.stderr.write(`  [electron] ${line}`)
  })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 120_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const line = stdout.split('\n').find((item) => item.startsWith('SHOT ') || item.startsWith('SHOT_ERR '))
  console.log(line ?? stdout.slice(-500))
  console.log(`截图在 ${outDir}`)
} finally {
  await server.close()
  await new Promise<void>((resolve) => fake.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
}
