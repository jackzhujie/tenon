/**
 * 页面通道（M4 第 4 步）：让 **Agent 驱动真实浏览器里的预览**。
 *
 * 为什么不是"服务端起一个 headless Chromium"：
 * - 装包要带一整个 Chromium（+ 原生依赖），与「安装包零原生依赖」的默认偏好对着干；
 * - Web 模式下**用户自己就开着一个浏览器**，再起一个是把同一件事做两遍；
 * - 更关键的是，E2E 要验的是"用户眼前这个页面"，而不是"另一个环境里长得差不多的页面"。
 *
 * 所以通道反过来：**页面连回来自报**，网关下发命令。谁在渲染不重要（Electron / Chrome 都行）。
 *
 * 三件必须记住的事：
 *
 * 1. **只有 HTTP 长轮询，没有 WebSocket。** 网关的 `upgrade` 是**原样透传**给 Vite 的
 *    （见 proxy.ts 的注释：HMR 握手带自定义 header，代理一改就坏）。在一个函数里
 *    既透传又自己握手，是这类代码最容易出的 bug。长轮询用 fetch 就够了：命令是被
 *    "挂着的请求"推下去的，延迟一样是毫秒级，而且没有帧解析要写。
 *
 * 2. **sessionId 存在 `sessionStorage` 里，跨 reload 不变。** 《刷新》恰好是这条链路
 *    最常见的动作（改完代码 HMR 整页重载）。如果每次加载都是新会话，
 *    "改完再断言一次"就会随机失败 —— 断言发出时页面正在重载，命令直接没人接。
 *    会话延续之后，命令排在那儿，新页面一起来就接走。
 *
 * 3. **页面刷新时，挂在半路的命令要重新排队**（只限幂等的 `read`/`assert`）。
 *    命令已经被旧页面领走、还没回话，页面就卸载了 —— 不重投的话它只会静静等到超时。
 *    `click`/`type` 不重投：重放一次点击可能点出两个东西。
 */
import { randomUUID } from 'node:crypto'

export type PageCommandName = 'read' | 'assert' | 'click' | 'type' | 'navigate'

export interface PageCommand {
  readonly id: string
  readonly name: PageCommandName
  readonly args: Record<string, unknown>
}

export interface PageReply {
  readonly ok: boolean
  /** 命令自己的返回值（`read` 的正文、`assert` 的实测值…） */
  readonly value?: unknown
  readonly error?: string
  /** 页面里的报错（`window.onerror` / `unhandledrejection` / `console.error`） */
  readonly errors?: string[]
}

export interface PageSessionInfo {
  readonly sessionId: string
  readonly path: string
  readonly url: string
  readonly title: string
  readonly at: number
}

export interface PageHello {
  sessionId?: string
  path?: string
  url?: string
  title?: string
  /** 导航票据：`navigate` 命令落地后由新页面带回来 */
  ticket?: string
}

export interface PageBridgeOptions {
  /** 一次长轮询挂多久。比任何"空闲检测"都便宜：没有命令就等到超时 */
  pollMs?: number
  /** 命令默认超时（页面里的 `assert` 自己还会重试，见脚本） */
  commandTimeoutMs?: number
  log?: (line: string) => void
}

/** 命令发不出去 / 没人接 / 接了不回话 —— 三种情况分开报，否则模型没法判断该重试还是该重载 */
export type PageFailure = 'missing' | 'timeout' | 'closed' | 'page-error'

export class PageError extends Error {
  constructor(
    readonly reason: PageFailure,
    message: string,
  ) {
    super(message)
    this.name = 'PageError'
  }
}

interface Waiter {
  sessionId: string | null
  resolve: (command: PageCommand | null) => void
  timer: NodeJS.Timeout
}

interface Pending {
  name: PageCommandName
  handed: boolean
  resolve: (reply: PageReply) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_POLL_MS = 20_000
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000
/** 会话多久没动静算"页面没了"。长轮询一直挂着，正常情况每 20 秒至少刷一次 */
const SESSION_IDLE_MS = 45_000
/** 刷新后可以重投的命令：只限幂等的 */
const REPLAYABLE = new Set<PageCommandName>(['read', 'assert'])

export class PageBridge {
  private session: PageSessionInfo | null = null
  private readonly queue: PageCommand[] = []
  private readonly waiters = new Set<Waiter>()
  private readonly pending = new Map<string, Pending>()
  private readonly helloWaiters = new Map<string, (info: PageSessionInfo) => void>()
  private readonly pageWaiters = new Set<(info: PageSessionInfo) => void>()
  private closed = false

  constructor(private readonly options: PageBridgeOptions = {}) {}

  /** 当前页面（没有就是 null）。**过期会话当作没有** —— 关掉标签页后它不会来告别 */
  get info(): PageSessionInfo | null {
    if (this.session === null) return null
    return Date.now() - this.session.at > SESSION_IDLE_MS ? null : this.session
  }

  // ------------------------------------------------------------------ 页面侧

  /**
   * 页面报到。返回它该用的 sessionId（新页面由网关发一个）。
   *
   * 顺带做两件事：把刷新前挂在半路的幂等命令重新排队；兑现导航票据的等待者。
   */
  hello(input: PageHello): { sessionId: string } {
    const sessionId = input.sessionId ?? randomUUID()
    const previous = this.session
    this.session = {
      sessionId,
      path: input.path ?? '/',
      url: input.url ?? '',
      title: input.title ?? '',
      at: Date.now(),
    }

    // 刷新后重投：旧页面领走但没回话的幂等命令
    if (previous !== null && previous.sessionId === sessionId) {
      for (const [id, entry] of this.pending) {
        if (entry.handed && REPLAYABLE.has(entry.name)) {
          entry.handed = false
          this.queue.push({ id, name: entry.name, args: this.argsOf(id) })
        }
      }
    }

    const ticket = input.ticket
    if (ticket !== undefined) {
      const waiter = this.helloWaiters.get(ticket)
      if (waiter !== undefined) {
        this.helloWaiters.delete(ticket)
        waiter(this.session)
      }
    }
    for (const waiter of this.pageWaiters) waiter(this.session)
    this.pageWaiters.clear()
    this.wake()
    return { sessionId }
  }

  /**
   * 长轮询。没有命令就挂着，最多 `pollMs`；返回 `null` 表示"这次没有"。
   *
   * `'reset'` 是**必须**的一格：页面拿着网关不认识的 sessionId 来问（网关重启过 / 预览
   * 停过又起），这时只回 `idle` 会让它立刻再问一次 —— 一个没有退避的空转循环，
   * 几百毫秒就能把 CPU 打满。回 `reset` 让它把 id 扔掉重新报到。
   *
   * `signal` 是**浏览器断开**的通知（整页导航时 fetch 被取消）。没有它的话，
   * 这个已死的等待者还留在表里，`wake()` 会把下一条命令投给它 —— 命令进了断掉的
   * 连接，没人执行也没人回话，调用方只能等到超时。这个 bug 只在"页面真的重载"
   * 时出现，假客户端永远不会断开，所以单测里看不见（`e2e:e2e` 抓到的）。
   */
  async poll(sessionId: string | undefined, signal?: AbortSignal): Promise<PageCommand | 'reset' | null> {
    if (this.closed) return null
    if (this.session !== null) {
      this.session = { ...this.session, at: Date.now() }
    }
    if (
      sessionId !== undefined &&
      sessionId !== '' &&
      (this.session === null || this.session.sessionId !== sessionId)
    ) {
      return 'reset'
    }
    const command = this.queue.shift()
    if (command !== undefined) {
      const entry = this.pending.get(command.id)
      if (entry !== undefined) entry.handed = true
      return command
    }
    return await new Promise<PageCommand | null>((resolve) => {
      const waiter: Waiter = {
        sessionId: sessionId ?? null,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve(null)
        }, this.options.pollMs ?? DEFAULT_POLL_MS),
      }
      waiter.timer.unref?.()
      const onAbort = (): void => {
        this.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        resolve(null)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(waiter)
    })
  }

  /** 页面回话 */
  reply(input: { id?: string; ok?: boolean; value?: unknown; error?: string; errors?: string[] }): void {
    if (typeof input.id !== 'string') return
    const entry = this.pending.get(input.id)
    if (entry === undefined) return
    this.pending.delete(input.id)
    this.args.delete(input.id)
    clearTimeout(entry.timer)
    entry.resolve({
      ok: input.ok !== false,
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.errors === undefined ? {} : { errors: input.errors }),
    })
  }

  // ------------------------------------------------------------------ Agent 侧

  /** 等到页面连上；等不到返回 null（调用方决定是报错还是继续等） */
  async waitForPage(timeoutMs: number): Promise<PageSessionInfo | null> {
    const current = this.info
    if (current !== null) return current
    if (this.closed || timeoutMs <= 0) return null
    return await new Promise<PageSessionInfo | null>((resolve) => {
      const waiter = (info: PageSessionInfo): void => {
        clearTimeout(timer)
        resolve(info)
      }
      const timer = setTimeout(() => {
        this.pageWaiters.delete(waiter)
        resolve(this.info)
      }, timeoutMs)
      timer.unref?.()
      this.pageWaiters.add(waiter)
    })
  }

  /**
   * 发一条命令并等结果。
   *
   * `waitMs` 是"允许等页面多久"：刚改完代码时页面正在重载，等一两秒是常态，
   * 一上来就报"没有预览"会让 Agent 以为工具是坏的。
   */
  async run(
    name: PageCommandName,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; waitMs?: number } = {},
  ): Promise<PageReply> {
    if (this.closed) throw new PageError('closed', 'The preview has stopped, so the page channel is closed')
    const page = await this.waitForPage(options.waitMs ?? 3000)
    if (page === null) {
      throw new PageError(
        'missing',
        'No preview page is connected. Open the preview first (or wait for the dev server), then try again — this channel can only drive a page that is already open.',
      )
    }
    const id = randomUUID()
    this.args.set(id, args)
    const timeoutMs = options.timeoutMs ?? this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const promise = new Promise<PageReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.args.delete(id)
        /*
         * ★ 队列里的也要摘掉。只删挂账是不够的：命令还在队列里排着，
         * 下一次轮询会把它发给页面，页面**照样执行** —— 一个已经超时的 `click`
         * 在断言失败之后才点下去，用户看到的是"它自己乱点"。
         * 这是在测试里被"超时之后 poll 应该是 null"这一条抓到的。
         */
        this.drop(id)
        reject(new PageError('timeout', `The page did not answer within ${Math.round(timeoutMs / 1000)}s (command: ${name})`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { name, handed: false, resolve, reject, timer })
    })
    this.queue.push({ id, name, args })
    this.wake()
    return await promise
  }

  /**
   * 跳到某个路径，等新页面报到的**确认**。
   *
   * 不能发完就返回：跳转是异步的，紧接着的 `assert` 很可能打在旧页面上，
   * 于是"跳过去了但断言没过"，看起来像应用坏了。
   */
  async navigate(path: string, timeoutMs = 15_000): Promise<PageSessionInfo> {
    const ticket = randomUUID()
    const arrived = new Promise<PageSessionInfo>((resolve) => {
      this.helloWaiters.set(ticket, resolve)
    })
    await this.run('navigate', { path, ticket }, { timeoutMs: 4000 })
    const info = await Promise.race([
      arrived,
      new Promise<PageSessionInfo>((_, reject) =>
        setTimeout(() => reject(new PageError('timeout', `The new page did not check in after navigating to ${path}`)), timeoutMs),
      ),
    ])
    this.helloWaiters.delete(ticket)
    return info
  }

  /** 预览停掉时调用：挂着的命令立刻失败，别让 Agent 干等十几秒 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    this.waiters.clear()
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new PageError('closed', 'The preview stopped; the command did not run'))
      this.pending.delete(id)
    }
    this.args.clear()
    this.queue.length = 0
    this.pageWaiters.clear()
    this.helloWaiters.clear()
  }

  /** 命令参数单独存：重投时要用（`pending` 里只留状态，不放 args 免得两处分叉） */
  private readonly args = new Map<string, Record<string, unknown>>()

  private argsOf(id: string): Record<string, unknown> {
    return this.args.get(id) ?? {}
  }

  /** 把一条命令从队列里摘掉（超时 / 页面换了之后它会变成一条"幽灵命令"） */
  private drop(id: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.id === id) this.queue.splice(index, 1)
    }
  }

  private wake(): void {
    const command = this.queue.shift()
    if (command === undefined) return
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      const entry = this.pending.get(command.id)
      if (entry !== undefined) entry.handed = true
      waiter.resolve(command)
      return
    }
    // 没有等待者：放回队列，下一次轮询取走
    this.queue.unshift(command)
  }
}

/**
 * 注入页面的脚本。
 *
 * 刻意写得像 2010 年的代码：不用模板字符串、不用可选链、不用 `await` —— 它要跑在
 * 用户的应用页面里，那个页面可能配了奇怪的构建目标；一旦语法错，**整段静默不执行**，
 * 表现只是"工具说没连上"，极难查。原生 `fetch` + `Promise` 是底线。
 *
 * `errors` 只记最近几条：一个渲染异常循环能刷出几千条，回给模型的必须是能读的东西。
 */
export const PAGE_SCRIPT = `(function () {
  if (window.__tenonPage) return;
  var POLL = '/__tenon/page/poll';
  var HELLO = '/__tenon/page/hello';
  var REPLY = '/__tenon/page/reply';
  var SID_KEY = 'tenon:page:sid';
  var NAV_KEY = 'tenon:page:nav';
  var MAX_ERRORS = 8;
  var errors = [];
  var sid = null;
  var backoff = 0;

  try { sid = sessionStorage.getItem(SID_KEY); } catch (e) { sid = null; }

  function remember(value) {
    sid = value;
    try { sessionStorage.setItem(SID_KEY, value); } catch (e) {}
  }

  function addError(text) {
    if (!text) return;
    if (errors.indexOf(text) >= 0) return;
    errors.push(text);
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  window.__tenonPage = { errors: errors };

  window.addEventListener('error', function (event) {
    addError('error: ' + ((event && (event.message || (event.error && event.error.message))) || 'script error'));
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    addError('unhandled rejection: ' + ((reason && reason.message) || reason || 'unknown'));
  });
  var consoleError = console.error;
  console.error = function () {
    try {
      addError('console.error: ' + Array.prototype.slice.call(arguments).map(function (item) {
        if (typeof item === 'string') return item;
        try { return JSON.stringify(item); } catch (e) { return String(item); }
      }).join(' '));
    } catch (e) {}
    return consoleError.apply(console, arguments);
  };

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin'
    }).then(function (response) {
      return response.json().catch(function () { return {}; });
    });
  }

  function textOf(element) {
    if (!element) return '';
    return (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function describe(element) {
    if (!element) return 'null';
    var name = element.tagName ? element.tagName.toLowerCase() : 'node';
    var id = element.id ? '#' + element.id : '';
    var text = textOf(element).slice(0, 40);
    return name + id + (text ? '「' + text + '」' : '');
  }

  function findAll(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (e) {
      throw new Error('Bad selector: ' + selector + ' (' + e.message + ')');
    }
  }

  function one(selector, index) {
    var list = findAll(selector);
    var at = typeof index === 'number' ? index : 0;
    if (list.length <= at) {
      throw new Error('No element #' + (at + 1) + ' for "' + selector + '" (found ' + list.length + ')');
    }
    return list[at];
  }

  function setValue(element, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    var areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (element.tagName === 'TEXTAREA' && areaSetter) areaSetter.set.call(element, value);
    else if (setter) setter.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function check(args) {
    var seen = {};
    var pass = true;
    if (typeof args.selector === 'string' && args.selector !== '') {
      var list = findAll(args.selector);
      seen.count = list.length;
      if (typeof args.count === 'number') {
        pass = pass && list.length === args.count;
      } else {
        pass = pass && list.length > 0;
      }
      var first = list[0];
      if (first) {
        seen.text = textOf(first).slice(0, 200);
        if ('value' in first) seen.value = first.value;
      }
    }
    if (typeof args.text === 'string' && args.text !== '') {
      var haystack = textOf(args.selector ? (findAll(args.selector)[0] || document.body) : document.body);
      seen.contains = haystack.toLowerCase().indexOf(args.text.toLowerCase()) >= 0;
      pass = pass && seen.contains;
      if (!seen.contains) seen.text = haystack.slice(0, 300);
    }
    if (typeof args.value === 'string') {
      var target = args.selector ? findAll(args.selector)[0] : null;
      seen.value = target ? target.value : undefined;
      pass = pass && seen.value === args.value;
    }
    return { pass: pass, seen: seen };
  }

  var actions = {
    read: function (args) {
      var scope = document.body;
      if (typeof args.selector === 'string' && args.selector !== '') scope = one(args.selector, args.index);
      var limit = typeof args.maxChars === 'number' ? args.maxChars : 3000;
      var text = textOf(scope);
      return {
        ok: true,
        value: {
          title: document.title,
          path: location.pathname + location.search,
          truncated: text.length > limit,
          text: text.slice(0, limit)
        }
      };
    },

    assert: function (args) {
      var timeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : 3000;
      if (timeout > 15000) timeout = 15000;
      var deadline = Date.now() + timeout;
      function attempt() {
        var result;
        try {
          result = check(args);
        } catch (e) {
          return Promise.resolve({ ok: false, error: String((e && e.message) || e) });
        }
        if (result.pass) return Promise.resolve({ ok: true, value: { pass: true, seen: result.seen } });
        if (Date.now() >= deadline) {
          return Promise.resolve({ ok: true, value: { pass: false, seen: result.seen } });
        }
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(attempt()); }, 120);
        });
      }
      return attempt();
    },

    click: function (args) {
      var element = one(args.selector, args.index);
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { ok: true, value: { clicked: describe(element) } };
    },

    type: function (args) {
      var element = one(args.selector, args.index);
      element.focus();
      setValue(element, String(args.value === undefined ? '' : args.value));
      if (args.submit === true) {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        if (element.form && element.form.requestSubmit) element.form.requestSubmit();
      }
      return { ok: true, value: { value: element.value, typed: describe(element) } };
    },

    navigate: function (args) {
      // 真正的跳转不在这里做：必须**先**把回话发出去，再走 —— 反过来做，
      // 页面已经在卸载，那条 "我跳了" 的 fetch 会被浏览器掐掉，网关只能等到超时。
      return { ok: true, value: {}, navigate: String(args.path || '/'), ticket: String(args.ticket || '') };
    }
  };

  function sendReply(command, result) {
    result = result || {};
    return post(REPLY, {
      sessionId: sid,
      id: command.id,
      ok: result.ok !== false,
      value: result.value,
      error: result.error,
      errors: errors.slice(0, MAX_ERRORS)
    }).then(function (data) {
      if (data && data.sessionId) remember(data.sessionId);
      if (result.navigate) {
        try { sessionStorage.setItem(NAV_KEY, result.ticket || ''); } catch (e) {}
        window.location.assign(result.navigate);
      }
    });
  }

  function handle(command) {
    var action = actions[command.name];
    if (!action) {
      return sendReply(command, { ok: false, error: 'Unknown command: ' + command.name });
    }
    /*
     * 抛异常也必须回话。之前这里是空的 catch 分支 —— 页面里 one() 找不到元素就直接抛，
     * 于是命令**永远没有回音**，工具只能等到 12 秒超时，报的还是"页面没回话"。
     * 一个"没找到 #buy"的明确错误，比一个超时有用得多。
     * （这段在模板字符串里：注释里不要出现反引号，会提前结束字符串。）
     */
    return Promise.resolve()
      .then(function () { return action(command.args || {}); })
      .then(function (result) {
        return sendReply(command, result);
      }, function (error) {
        return sendReply(command, { ok: false, error: String((error && error.message) || error) });
      })
      .catch(function () {});
  }

  function loop() {
    post(POLL, { sessionId: sid }).then(function (data) {
      backoff = 0;
      if (data && data.sessionId) remember(data.sessionId);
      if (!data || data.idle === true) return null;
      if (data.reset === true) { remember(''); return null; }
      return handle(data);
    }).catch(function () {
      backoff = backoff === 0 ? 500 : Math.min(backoff * 2, 3000);
    }).then(function () {
      setTimeout(loop, backoff);
    });
  }

  function start() {
    var ticket = null;
    try {
      ticket = sessionStorage.getItem(NAV_KEY);
      if (ticket) sessionStorage.removeItem(NAV_KEY);
    } catch (e) { ticket = null; }
    post(HELLO, {
      sessionId: sid,
      url: location.href,
      path: location.pathname + location.search,
      title: document.title,
      ticket: ticket
    }).then(function (data) {
      if (data && data.sessionId) remember(data.sessionId);
    }).catch(function () {}).then(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();`

/** 注入标记：重复注入会让页面开两条轮询，命令被两个"自己"抢 */
const INJECT_MARK = 'data-tenon-page'
export const PAGE_SCRIPT_PATH = '/__tenon/page.js'
export const PAGE_HELLO_PATH = '/__tenon/page/hello'
export const PAGE_POLL_PATH = '/__tenon/page/poll'
export const PAGE_REPLY_PATH = '/__tenon/page/reply'

/**
 * 往 HTML 里插一行脚本。
 *
 * 插在 `</body>` 之前而不是 `</head>`：`navigate` 之后要读 `document.title`，
 * head 里执行时标题还是空的（拿到的是上一个页面的标题）。
 * 没有 `</body>`（少见）就退回 `</head>`，再没有就追加到末尾 —— 不抛错，注入失败
 * 只该表现为"工具说页面没连上"，而不是整个预览 500。
 */
export function injectPageScript(html: string): string {
  if (html.includes(INJECT_MARK)) return html
  const tag = `<script ${INJECT_MARK} src="${PAGE_SCRIPT_PATH}"></script>`
  for (const anchor of ['</body>', '</html>']) {
    const at = html.lastIndexOf(anchor)
    if (at >= 0) return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  return `${html}${tag}`
}

/** 哪些路径是**平台的**，不该转发给 Vite/Nest（与 LOG_PATH 同一类） */
export function isPagePath(path: string): boolean {
  return (
    path === PAGE_SCRIPT_PATH ||
    path === PAGE_HELLO_PATH ||
    path === PAGE_POLL_PATH ||
    path === PAGE_REPLY_PATH
  )
}
