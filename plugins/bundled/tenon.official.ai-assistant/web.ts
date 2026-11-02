/**
 * AI 小助手的浏览器半边（chord 的 web facet）。
 *
 * 它是**注入进应用页面的一段独立脚本**，不是应用 React 树里的一棵树 —— 理由：
 * `app.shell.overlay` 是浮层，天生与页面布局无关；而插件要能装进任何模板
 * （React / 将来的 Vue、纯静态页），依赖应用的组件树就等于把插件焊死在一种框架上。
 *
 * 三条从 Spike 5 学来的规矩，这里都落实了：
 * 1. **每个调用自带超时**：链路静默丢帧时调用既不返回也不抛，界面会永远转圈。
 * 2. **断线要能自愈**：socket 关了就把 host 丢掉，下一次提问重新连。
 * 3. **状态以服务端为准**：答案不靠本地拼，`ask` 之后重新读 `messages` ——
 *    否则重连、重复点发送、多标签页会各说各话。
 */
import { createHost, webSocketLink, type Host } from '@earendil-works/chord'
import { Assistant, type Principal } from './contract.js'

/** 与网关约定好的两条路径（见 `packages/gateway/src/components.ts`） */
const WS_PATH = '/__tenon/component'
/** 一次问答最多等多久：模型慢是真慢，但"永远转圈"更糟 */
const ASK_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 10_000

function appIdOf(): string {
  // 网关注入的地址是 `/__tenon/component.js?appId=…`，脚本自己不知道身在哪个应用
  const id = new URL(import.meta.url).searchParams.get('appId')
  if (id === null || id === '') throw new Error('组件脚本缺少 appId 参数')
  return id
}

function socketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${WS_PATH}`
}

type Message = { role: string; text: string }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.setAttribute('style', style)
  if (text !== undefined) node.textContent = text
  return node
}

function mount(appId: string): void {
  // 同一个页面里只装一次（热更新、重复注入都可能发生）
  if (document.querySelector('[data-tenon-component="tenon.official.ai-assistant"]') !== null) return

  let host: Host<Principal> | null = null
  let pending = false

  async function ensureHost(): Promise<Host<Principal>> {
    if (host !== null) return host
    const socket = new WebSocket(socketUrl())
    const created = createHost<Principal>({
      name: 'ui',
      self: { appId },
      principalKey: (principal) => principal.appId,
      // client：不参与 reload、不带 code version —— 它就是"浏览器那半边"
      kind: 'client',
      readyTimeout: READY_TIMEOUT_MS,
      upstream: { link: webSocketLink(socket), principal: { appId } },
      onError: (error) => {
        console.warn('[tenon assistant]', error)
      },
    })
    // 断线就把 host 丢掉，下次提问重连；留着它只会让之后的调用全部超时
    socket.addEventListener('close', () => {
      if (host === created) host = null
      statusLine.textContent = '连接已断开，下次提问会重连'
    })
    host = created
    return created
  }

  /** 读一次服务端的对话（唯一事实来源） */
  async function readMessages(): Promise<Message[]> {
    const active = await ensureHost()
    return withTimeout(
      active.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId })
        return ref.messages.value as Message[]
      }),
    )
  }

  async function ask(text: string): Promise<Message[]> {
    const active = await ensureHost()
    return withTimeout(
      active.root(async (ctx) => {
        const ref = await ctx.get(Assistant, { appId })
        await ref.ask({ text }, ctx)
        return ref.messages.value as Message[]
      }),
    )
  }

  function withTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等太久了，链路可能断了')), ASK_TIMEOUT_MS)
      work.then(
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

  // ── 界面 ──────────────────────────────────────────────
  const root = el(
    'div',
    'position:fixed;right:20px;bottom:20px;z-index:2147483000;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  )
  root.setAttribute('data-tenon-component', 'tenon.official.ai-assistant')

  const ball = el(
    'button',
    'width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:#111;color:#fff;font-size:20px;box-shadow:0 6px 20px rgba(0,0,0,.25)',
    '✦',
  )
  ball.setAttribute('title', 'AI 小助手')
  ball.setAttribute('aria-label', 'AI 小助手')

  const panel = el(
    'div',
    'display:none;flex-direction:column;width:340px;height:440px;margin-bottom:12px;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:hidden',
  )
  const header = el(
    'div',
    'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#111;color:#fff;font-weight:600',
    'AI 小助手',
  )
  const closeButton = el('button', 'border:none;background:none;color:#fff;cursor:pointer;font-size:16px', '×')
  header.append(closeButton)

  const list = el('div', 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px')
  const statusLine = el('div', 'padding:0 12px;color:#888;font-size:12px;min-height:16px')
  const form = el('div', 'display:flex;gap:8px;padding:10px;border-top:1px solid #eee')
  const input = el(
    'textarea',
    'flex:1;resize:none;height:38px;padding:8px;border:1px solid #ddd;border-radius:8px;font:inherit;outline:none',
  )
  input.setAttribute('placeholder', '问点什么…')
  const send = el(
    'button',
    'padding:0 14px;border:none;border-radius:8px;background:#111;color:#fff;cursor:pointer',
    '发送',
  )
  form.append(input, send)
  panel.append(header, list, statusLine, form)
  root.append(panel, ball)
  document.body.append(root)

  function render(messages: readonly Message[]): void {
    list.textContent = ''
    for (const message of messages) {
      const mine = message.role === 'user'
      const bubble = el(
        'div',
        `max-width:86%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;${
          mine ? 'align-self:flex-end;background:#111;color:#fff' : 'align-self:flex-start;background:#f2f2f2;color:#111'
        }`,
        message.text,
      )
      list.append(bubble)
    }
    list.scrollTop = list.scrollHeight
  }

  async function submit(): Promise<void> {
    const text = input.value.trim()
    if (text === '' || pending) return
    pending = true
    input.value = ''
    // 先把自己的话显示出来：等一个往返（还要等模型）会让人以为没发出去
    list.append(
      el('div', 'align-self:flex-end;max-width:86%;padding:8px 10px;border-radius:10px;background:#111;color:#fff', text),
    )
    statusLine.textContent = '思考中…'
    try {
      render(await ask(text))
      statusLine.textContent = ''
    } catch (error) {
      statusLine.textContent = `没成功：${error instanceof Error ? error.message : String(error)}`
    } finally {
      pending = false
      list.scrollTop = list.scrollHeight
    }
  }

  ball.addEventListener('click', () => {
    const opening = panel.style.display !== 'flex'
    panel.style.display = opening ? 'flex' : 'none'
    if (!opening) return
    input.focus()
    // 打开时拉一次历史：注入晚于用户已经聊过的场景（换页、热更新）也能接上
    void readMessages().then(
      (messages) => {
        render(messages)
        statusLine.textContent = ''
      },
      (error: unknown) => {
        statusLine.textContent = `连不上助手：${error instanceof Error ? error.message : String(error)}`
      },
    )
  })
  closeButton.addEventListener('click', () => {
    panel.style.display = 'none'
  })
  send.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  })
}

try {
  mount(appIdOf())
} catch (error) {
  // 注入脚本出错不能连累应用页面（它跑在用户的页面里）
  console.warn('[tenon assistant] 没挂上：', error)
}
