/**
 * 审批流的浏览器半边：右下角一个徽标（待审数量），点开是清单 + 通过/驳回。
 *
 * 界面**不自己维护状态**：每次操作后重新读服务端对象（`items` / `pending`），
 * 这样两个标签页同时开着也不会各说各话 —— 组件状态只有一份。
 */
import { createHost, webSocketLink, type Host } from '@earendil-works/chord'
import { Approval, type Principal } from './contract.js'

const WS_PATH = '/__tenon/component'
const TIMEOUT_MS = 20_000

type Item = { id: string; title: string; state: string }

/*
 * ── 语言 ────────────────────────────────────────────────
 *
 * 与另外两个组件同一套约定：网关注入时写 `window.__tenonLocale`，切语言时
 * 平台派发 `tenon:locale` 事件。组件只读一次、听一次，不自己加 message 监听。
 */
type Locale = 'en' | 'zh'

interface Copy {
  badge: string
  noItems: string
  approved: string
  rejected: string
  failed: string
  offline: string
}

const TEXT: Record<Locale, Copy> = {
  en: {
    badge: 'Approvals',
    noItems: 'Nothing waiting',
    approved: 'Approved',
    rejected: 'Rejected',
    failed: 'Action failed',
    offline: 'Offline',
  },
  zh: {
    badge: '审批',
    noItems: '还没有单子',
    approved: '已通过',
    rejected: '已驳回',
    failed: '操作失败',
    offline: '连不上',
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

function mount(appId: string): void {
  if (document.querySelector('[data-tenon-component="tenon.official.approval"]') !== null) return

  let host: Host<Principal> | null = null

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
      onError: (error) => console.warn('[approval]', error),
    })
    socket.addEventListener('close', () => {
      if (host === created) host = null
    })
    host = created
    return created
  }

  /** 每个调用自带超时：断链时调用会挂住（Spike 5） */
  async function call<T>(work: (ctx: Parameters<Parameters<Host<Principal>['root']>[0]>[0]) => Promise<T>): Promise<T> {
    const active = connect()
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out — the link may be down')), TIMEOUT_MS)
      void active.root(work).then(
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
  }

  const root = document.createElement('div')
  root.setAttribute('data-tenon-component', 'tenon.official.approval')
  root.setAttribute(
    'style',
    'position:fixed;right:20px;bottom:88px;z-index:2147482900;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  )

  const badge = document.createElement('button')
  badge.type = 'button'
  badge.setAttribute(
    'style',
    'padding:6px 10px;border:1px solid #ddd;border-radius:999px;background:#fff;color:#111;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.08);font:12px/1.4 inherit',
  )

  const panel = document.createElement('div')
  panel.setAttribute(
    'style',
    'display:none;flex-direction:column;width:300px;max-height:360px;overflow:auto;margin-bottom:10px;padding:10px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18)',
  )

  /*
   * 徽标上的字有三态（数量 / 操作失败 / 连不上）。切语言时要按**当前那一态**
   * 重画，否则"操作失败"会永远停在切之前的那种语言上 —— 它是最少被看见、
   * 也最容易漏掉的一条路径。
   */
  type BadgeState =
    | { kind: 'count'; pending: number }
    | { kind: 'failed'; detail: string }
    | { kind: 'offline'; detail: string }
  let badgeState: BadgeState = { kind: 'count', pending: 0 }

  function paintBadge(): void {
    if (badgeState.kind === 'count') {
      badge.textContent = badgeState.pending > 0 ? `${copy.badge} ${badgeState.pending}` : copy.badge
      badge.title = ''
      return
    }
    badge.textContent = badgeState.kind === 'failed' ? copy.failed : copy.offline
    badge.title = badgeState.detail
  }

  function setBadge(next: BadgeState): void {
    badgeState = next
    paintBadge()
  }

  /** 最近一次读到的数据：切语言用它重画面板，不再为了一句文案多发一次请求 */
  let last: { items: Item[]; pending: number } | null = null

  function paintPanel(): void {
    panel.textContent = ''
    if (last === null) return
    if (last.items.length === 0) {
      const empty = document.createElement('div')
      empty.setAttribute('style', 'color:#888;font-size:12px')
      empty.textContent = copy.noItems
      panel.append(empty)
      return
    }
    for (const item of last.items) {
      const row = document.createElement('div')
      row.setAttribute('style', 'display:flex;align-items:center;gap:6px;padding:6px 0;border-top:1px solid #f0f0f0')
      const label = document.createElement('span')
      label.setAttribute('style', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')
      label.textContent = `${item.id} ${item.title}`
      label.title = `${item.id} · ${item.state}`
      row.append(label)
      if (item.state === 'submitted') {
        for (const [text, approve] of [
          ['✓', true],
          ['✕', false],
        ] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = text
          button.setAttribute(
            'style',
            'border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;padding:2px 8px',
          )
          button.addEventListener('click', () => {
            void call(async (ctx) => {
              const ref = await ctx.get(Approval, { appId })
              await ref.decide({ id: item.id, approve }, ctx)
            }).then(refresh, (error: unknown) => {
              setBadge({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
            })
          })
          row.append(button)
        }
      } else {
        const state = document.createElement('span')
        state.setAttribute('style', 'color:#888;font-size:11px')
        state.textContent = item.state === 'approved' ? copy.approved : copy.rejected
        row.append(state)
      }
      panel.append(row)
    }
  }

  async function refresh(): Promise<void> {
    last = await call(async (ctx) => {
      const ref = await ctx.get(Approval, { appId })
      return { items: ref.items.value as Item[], pending: ref.pending.value }
    })
    setBadge({ kind: 'count', pending: last.pending })
    paintPanel()
  }

  function applyCopy(): void {
    copy = TEXT[currentLocale()]
    paintBadge()
    paintPanel()
  }

  applyCopy()
  window.addEventListener('tenon:locale', applyCopy)

  badge.addEventListener('click', () => {
    const opening = panel.style.display !== 'flex'
    panel.style.display = opening ? 'flex' : 'none'
    if (opening) {
      void refresh().catch((error: unknown) => {
        setBadge({ kind: 'offline', detail: error instanceof Error ? error.message : String(error) })
      })
    }
  })

  root.append(panel, badge)
  document.body.append(root)
}

try {
  mount(appIdOf())
} catch (error) {
  console.warn('[approval] failed to mount:', error)
}
