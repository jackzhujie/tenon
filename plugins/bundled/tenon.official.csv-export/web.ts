/**
 * 导出 CSV 的浏览器半边。
 *
 * 抓表在**页面里**做：只有它能看见用户真正在看的那张表（组件拿不到应用的数据库，
 * 这是 `permissions: []` 的直接后果 —— 也是它为什么不需要任何权限）。
 *
 * 三条实现细节：
 * 1. 优先抓 `table[data-tenon-export]`（Agent 想导指定表时加这个属性即可），否则第一张表；
 * 2. 输出**以服务端返回的 csv 为准**，前端只负责把 Blob 点下去 —— 两处各拼一遍迟早不一致；
 * 3. 每个调用自带超时（断链时调用会挂住，Spike 5 的硬约束）。
 */
import { createHost, webSocketLink, type Host } from '@earendil-works/chord'
import { ExportTable, type Principal } from './contract.js'

const WS_PATH = '/__tenon/component'
const TIMEOUT_MS = 30_000

/*
 * ── 语言 ────────────────────────────────────────────────
 *
 * 与另外两个组件同一套约定：网关注入时写 `window.__tenonLocale`，切语言时
 * 平台派发 `tenon:locale` 事件。组件只读一次、听一次。
 */
type Locale = 'en' | 'zh'

interface Copy {
  idle: string
  noTable: string
  busy: string
  /** `{rows}` 会被替换成行数 */
  done: string
  failed: string
}

const TEXT: Record<Locale, Copy> = {
  en: {
    idle: 'Export CSV',
    noTable: 'No table on this page',
    busy: 'Exporting…',
    done: 'Exported {rows} rows',
    failed: 'Export failed',
  },
  zh: {
    idle: '导出 CSV',
    noTable: '页面上没有表格',
    busy: '导出中…',
    done: '已导出 {rows} 行',
    failed: '导出失败',
  },
}

function currentLocale(): Locale {
  return (window as unknown as { __tenonLocale?: unknown }).__tenonLocale === 'zh' ? 'zh' : 'en'
}

let copy: Copy = TEXT[currentLocale()]

function appIdOf(): string {
  const id = new URL(import.meta.url).searchParams.get('appId')
  if (id === null || id === '') throw new Error('component script is missing the appId parameter')
  return id
}

function readTable(): { filename: string; columns: string[]; rows: string[][] } | null {
  const table =
    document.querySelector<HTMLTableElement>('table[data-tenon-export]') ??
    document.querySelector<HTMLTableElement>('table')
  if (table === null) return null
  const filename = table.dataset['tenonExport'] ?? document.title ?? 'export'

  const headerCells = [
    ...table.querySelectorAll<HTMLTableCellElement>('thead tr:last-child th, thead tr:last-child td'),
  ]
  const firstRow = table.querySelector<HTMLTableRowElement>('tbody tr')
  const columns =
    headerCells.length > 0
      ? headerCells.map((cell) => cell.textContent?.trim() ?? '')
      : firstRow === null
        ? []
        : [...firstRow.cells].map((cell) => cell.textContent?.trim() ?? '')

  const bodyRows =
    headerCells.length > 0
      ? [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')]
      : [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')].slice(1)

  const rows = bodyRows.map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? ''))
  return { filename, columns, rows }
}

function download(csv: string, filename: string): void {
  // BOM 已经在服务端加好了；这里用 text/csv + charset，避免某些浏览器再猜一次编码
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function mount(appId: string): void {
  if (document.querySelector('[data-tenon-component="tenon.official.csv-export"]') !== null) return

  let host: Host<Principal> | null = null
  let pending = false

  function connect(): Host<Principal> {
    if (host !== null) return host
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}`)
    const created = createHost<Principal>({
      name: 'ui',
      self: { appId },
      principalKey: (principal) => principal.appId,
      kind: 'client',
      readyTimeout: 10_000,
      upstream: { link: webSocketLink(socket), principal: { appId } },
      onError: (error) => console.warn('[csv-export]', error),
    })
    socket.addEventListener('close', () => {
      if (host === created) host = null
    })
    host = created
    return created
  }

  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('data-tenon-component', 'tenon.official.csv-export')
  button.setAttribute(
    'style',
    'position:fixed;right:20px;top:64px;z-index:2147482000;padding:6px 12px;border:1px solid #ddd;border-radius:8px;background:#fff;color:#111;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.08)',
  )

  /*
   * 按钮上的字有五种（待命 / 没表格 / 导出中 / 导出行数 / 失败）。切语言要按
   * **当前那一态**重画：只换 idle 那一句，正在导出的人切完语言会看到一个
   * 英文界面上写着「已导出 12 行」。
   */
  type ButtonState =
    | { kind: 'idle' }
    | { kind: 'noTable' }
    | { kind: 'busy' }
    | { kind: 'done'; rows: number }
    | { kind: 'failed'; detail: string }
  let buttonState: ButtonState = { kind: 'idle' }

  function paintButton(): void {
    if (buttonState.kind === 'idle') {
      button.textContent = copy.idle
      button.title = ''
    } else if (buttonState.kind === 'noTable') {
      button.textContent = copy.noTable
      button.title = ''
    } else if (buttonState.kind === 'busy') {
      button.textContent = copy.busy
      button.title = ''
    } else if (buttonState.kind === 'done') {
      button.textContent = copy.done.replace('{rows}', String(buttonState.rows))
      button.title = ''
    } else {
      button.textContent = copy.failed
      button.title = buttonState.detail
    }
  }

  function setButton(next: ButtonState): void {
    buttonState = next
    paintButton()
  }

  async function run(): Promise<void> {
    if (pending) return
    const table = readTable()
    if (table === null || table.columns.length === 0) {
      setButton({ kind: 'noTable' })
      setTimeout(() => {
        if (!pending) setButton({ kind: 'idle' })
      }, 2500)
      return
    }
    pending = true
    setButton({ kind: 'busy' })
    try {
      const result = await new Promise<{ csv: string; bytes: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS)
        void connect()
          .root(async (ctx) => {
            const ref = await ctx.get(ExportTable, { appId })
            return ref.export({ filename: table.filename, columns: table.columns, rows: table.rows }, ctx)
          })
          .then(
            (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            (error: unknown) => {
              clearTimeout(timer)
              reject(error instanceof Error ? error : new Error(String(error)))
            },
          )
      })
      download(result.csv, table.filename)
      setButton({ kind: 'done', rows: table.rows.length })
    } catch (error) {
      setButton({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
    } finally {
      pending = false
      setTimeout(() => {
        if (!pending) setButton({ kind: 'idle' })
      }, 3000)
    }
  }

  function applyCopy(): void {
    copy = TEXT[currentLocale()]
    paintButton()
  }

  applyCopy()
  window.addEventListener('tenon:locale', applyCopy)

  button.addEventListener('click', () => void run())
  document.body.append(button)
}

try {
  mount(appIdOf())
} catch (error) {
  console.warn('[csv-export] failed to mount:', error)
}
