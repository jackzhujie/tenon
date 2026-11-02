# SPIKES.md — 实测结论（M1 第一周四个 + M5 前置一个）

> 执行日期：2026-10-31（spike 1–4）、2026-11-02（spike 5）　环境：macOS arm64 / Node v22.22.2 / pnpm 9.15.9
> 代码：`spikes/db`、`spikes/agent`、`spikes/gateway`、`spikes/loc`、`spikes/chord`（可 `pnpm spike:*` 重跑）
> 结论只认实测数字，不认"应该能行"。

## 0. 一句话结论

**五个 spike 全部通过，方案不需要回退；但撞出两条必须改的硬约束 —— `pglite` 档的 `pool.max` 必须是 1（DESIGN 原文写「1~2」会让并发事务互相抹掉），以及 chord 的对象默认 `lifetime: "referenced"`，root 一结束 state 就静默归零（组件必须显式 `linger`）。**

| # | 验证项 | 结果 | 对方案的影响 |
|---|---|---|---|
| 1 | pi-durable 最小闭环（含 `resume` 续跑） | ✅ 10/10 | 无（按预期可用）|
| 2 | App Gateway 代理 Vite HMR WebSocket | ✅ 8/8（HMR 134ms）| 无（按预期可用），补一条"上游换端口只改指向"的实现 |
| 3 | `data-tenon-loc` 定位精度 | ✅ 7/7（9/9 定位可回溯）| 注入改为 `loc` + `callsite` 双属性；生成组件必须透传 props |
| 4 | PGlite + pg-gateway + TypeORM | ⚠️ **有条件通过** | **`pool.max=1` 硬约束**；LISTEN/NOTIFY 不可用 |
| 5 | chord 宿主接入（契约 / 变体 / 跨 host / 热重载 / 打包） | ✅ 10/10 | **组件必须 `linger`**；断链调用会挂住 → 必须自己超时；单文件打包无坑（726KB / 164ms）|

---

## 1. Spike 4（最关键）：PGlite + pg-gateway + TypeORM

### 1.1 结论

- **性能：完全够用。** 并发 20 请求下 P95 ≈ 14ms（读）/ 24ms（写），40 并发压在 pool=10 上 P95 也只有 33ms，**零超时、零失败**。单用户桌面 + 预览场景没有任何压力。
- **正确性：踩到一个致命坑。** `pool.max > 1` 时，两个连接的事务**共用同一个 PGlite backend 会话**，一个连接 `ROLLBACK` 会把另一个连接已写入但未提交的行一起抹掉。实测：A 事务写了两行，B 事务回滚后，**A 的第一行凭空消失**（`[iso-A2]` 而非 `[iso-A,iso-A2]`）。
- **因此 `pool.max` 必须是 1**，`1~2` 里那个 2 不是调优空间，是数据损坏。

### 1.2 延迟实测（每次操作端到端，含排队）

| 阶段 | pool | 并发 | 成功/总数 | p50 | p95 | max |
|---|---|---|---|---|---|---|
| 单连接顺序基线 | 1 | 1 | 50/50 | 0.41ms | 0.82ms | 0.87ms |
| 并发 20 读 | 1 | 20 | 20/20 | 8.06ms | 13.63ms | 14.21ms |
| 并发 20 写 | 1 | 20 | 20/20 | 13.82ms | 23.53ms | 24.54ms |
| 并发 20 读 | 2 | 20 | 20/20 | 7.64ms | 13.72ms | 13.79ms |
| 并发 20 写 | 2 | 20 | 20/20 | 9.13ms | 19.01ms | 19.09ms |
| 10 个事务各写 2 行后回滚 | 1 | 10 | 10/10 | 14.29ms | 27.52ms | 27.52ms |
| 20 并发事务（3 查询/请求）| 1 | 20 | 20/20 | 42.91ms | 74.77ms | 78.26ms |
| **持续 300 次混合读写** | 1 | 10 | 300/300 | 8.11ms | 26.23ms | 63.33ms |
| 200 次顺序查询（连接复用）| 1 | 1 | 200/200 | 0.63ms | 1.35ms | 17.16ms |
| 40 并发读（DESIGN 警告的 pool=10）| 10 | 40 | 40/40 | 24.06ms | 32.56ms | 32.64ms |

> **pool=2 对写的收益只有 ~19%**（p95 23.5→19.0ms），代价是数据可能被回滚掉。这个交易不值得做。
>
> 重跑会有波动（同一台机器两次：读 p95 9.9~14.4ms、写 p95 13.8~23.7ms、混合事务 p95 52~75ms），**量级稳定、失败率恒为 0**，不影响结论。

### 1.3 正确性与功能探针（11 项，10 通过）

| 探针 | 结果 |
|---|---|
| pool=2 并发事务隔离 | ❌ **事务互串，`iso-A` 丢失** |
| pool=1 并发事务隔离（对照）| ✅ `iso-A, iso-A2` 都在，`iso-B` 已回滚 |
| 10 事务各写 2 行后回滚 | ✅ 行数 40 → 40，无泄漏 |
| 2000 行 × 7 列（含 jsonb）大结果集 | ✅ 45.4ms |
| jsonb 查询 / 窗口函数 / 递归 CTE / `gen_random_uuid` / 数组 / timestamptz / `ON CONFLICT` / savepoint | ✅ 8/8 全部可用 |
| LISTEN / NOTIFY | ❌ 通知收不到（见 1.5）|

**方言一致性成立**：`jsonb`、窗口函数、递归 CTE、`gen_random_uuid`、数组、`ON CONFLICT`、savepoint 全部照常——「本地 PGlite → 发布真 PG」不用改一行 SQL，这个选型的核心前提被证实。

### 1.4 生命周期与体积

| 项 | 实测 |
|---|---|
| 冷启动（新建 cluster + 网关监听）| **2403ms** |
| 重启（已有 pgdata）| 428ms |
| 2 个迁移（含 GIN 索引），pool=1 | 74.6ms |
| 运行期迁移（库里有数据）| 4.1ms，列正常生效 |
| `dumpDataDir('gzip')` | **4518KB / 678ms** |
| pgdata 目录体积（160 行种子数据）| **38.2MB** |
| 进程重启后数据 | 完好（160 → 160 行）|

两个要提前记账的成本：**每个应用冷启动 2.4s**（首次创建应用时用户会等）、**每应用固定 ~38MB 磁盘 + 每次快照 ~4.5MB**。

### 1.5 LISTEN/NOTIFY：不可用（`spikes/db/src/notify.ts`）

`LISTEN` / `NOTIFY` 语句本身不报错，但监听端**收不到任何通知（0 条）**。原因清楚：`pg-gateway` 的 `onMessage` 是"一问一答"，PGlite 产生的异步 `NotificationResponse` 没有回推通道。

→ **「后端改动推前端」必须走网关 SSE（DESIGN §9 的结论是对的），不能用 PG 的 LISTEN/NOTIFY。**

### 1.6 落地形态（已写成 `spikes/db/src/pglite-gateway.ts`，可直接演进为 `packages/db-provisioner`）

```text
net.Socket ──pg-gateway(fromNodeSocket)──> 单条全局串行队列 ──> PGlite.execProtocolRaw
```

- 所有连接共享**一条串行队列**（PGlite 只有一个 backend，`execProtocolRaw` 不可重入）
- 队列深度、消息数、socket 数都已埋点，直接接 UI 的 readiness / 状态面板
- `pool.max=1` + 这条队列 = 语义正确；队列本身承担"串行化"职责，不需要再靠连接池

---

## 2. Spike 1：pi-durable 最小闭环

**10/10 通过**，最强的一条是 DoD 第 4 条：子进程在流式输出途中被 `SIGKILL`，重开 storage 后 `resume()` 把同一个 submission 从 `placed` 跑到了 `done`（47ms）。

| 验证项 | 结果 |
|---|---|
| `openNodeSqliteStorage` + `Harness.open` + `root()` | 7ms 打开，会话 id 稳定 |
| `submit` → `wait` → `done` → `tx.entry(AssistantEntry, answer)` 取回文本 | 90ms，答案 59 字正确取回 |
| 流式：`viewState().subscribe` 收到 4 次 revision（0→1→1→2 条 entry）| 增量可见，UI 有东西可渲染 |
| `requestId` 幂等 | 重放同一 `requestId` → 返回**同一个 Submission id**（`8` → `8`）|
| `defineDoc` 自定义文档（`tenon.app`）+ `harness.snapshot` | 3ms，rewindable 文档可读回 |
| `harness.taskGraph()` | 跑动中采样到 `pi.generation/running/request`（静止时节点会回收，UI 不能在静止时断言空图）|
| 关进程 → 重开 → `resume()` → `harness.submission(id)` | 状态 `done`，transcript 4 条，文档跨重启存活 |
| **流式中途 SIGKILL → resume** | `placed` → `done`，47ms |

实现要点（写进 M1 主干时照抄）：
- 进程启动**必须** `harness.resume()`，否则崩溃中断的任务不会继续
- `submit` 的第 2 个参数是 `{ type:'input', content, requestId }`，`requestId` 就是妙搭的 `idempotentKey` 等价物，前端生成 UUID
- 答案文本在 `tx.entry(AssistantEntry, answerId)` 返回的 `{ model: [AssistantMessage] }` 里，不在返回值顶层
- 无 API Key 也能开发：`pi-ai` 自带 `providers/faux`（`fauxProvider()` + `fauxAssistantMessage()`），可脚本化响应、控制 token 速率 → **CI 与本地开发都用它，不要 mock harness**

---

## 3. Spike 2：App Gateway 代理 Vite HMR

**8/8 通过**，改文件到 HMR `update` 送达 **134ms**，iframe 全程只认识网关端口。

| 验证项 | 结果 |
|---|---|
| HTTP 代理 `/` → Vite | 200，HTML 正确 |
| `/api/*` → 后端（不经过 Vite）| 200，命中 mock Nest |
| WS 升级经网关（`Sec-WebSocket-Protocol: vite-hmr`）| 握手成功，协议协商保留 |
| 收到 Vite `connected` 帧 | ✅（**必须在上游 open 之前挂 message 监听**，否则丢帧）|
| 改文件 → `update` 帧 | 134ms，`js-update` + `acceptedPath` 正确 |
| 上游重启换端口 → 网关 URL 不变 | ✅（`updateRoute()` 只改指向，iframe 不用重载）|
| 重启后 HMR 在同一网关端口重连 | ✅ |

实现要点：
- 升级请求用**原样 TCP 透传**（自己重放 `req.rawHeaders`），不用 http-proxy——WS 的 header/压缩协商坑最少
- 路由按前缀长度匹配：`/api` → Nest，`/` → Vite
- Vite 侧仍要配 `server.hmr.clientPort = 网关端口`（页面经网关访问时默认也能连对，但写死更稳）
- 上游（Vite / Nest）重启换端口是常态，网关必须支持 `updateRoute()`，**端口稳定是网关存在的第一理由**

---

## 4. Spike 3：`data-tenon-loc` 定位精度

**7/7 通过**：9 个 DOM 元素全部带定位，9/9 的 `file:line:col` 逐条回溯源码确认指向真实 JSX 开标签。

但单纯 `data-tenon-loc` 在组合组件上会指错地方，所以改成**双属性**：

| 场景 | 结果 |
|---|---|
| 页面里的原生标签 `<h1>` | `src/app.tsx:7:7`（`kind: element`）✅ |
| **shadcn 风格 `<Button>`（透传 props）** | 主定位 = 用户写法 `src/app.tsx:13:9`（`kind: usage`），附带实现位置 `components/ui/button.tsx:9:10` ✅ |
| **不透传 props 的 `<Card>`** | 只能落到实现 `components/ui/card.tsx:6:5`（`kind: component-impl`，UI 需提示"改动影响全局"）✅ |
| 组件 children 里的原生标签 `<li>` | `src/app.tsx:10:10` ✅ |
| 生产构建 | 插件不启用时不注入，产物不含 `data-tenon-*` ✅ |

机制：
- 原生标签（`div`/`button`/…）→ `data-tenon-loc`
- 组合组件（`<Button>`/`<Card>`/…）→ `data-tenon-callsite`，靠组件的 `{...props}` 透传到 DOM
- 点击时 **`callsite` 优先于 `loc`**（用户想改的是"我在这里用了它"）
- 兜底：元素上没有 `callsite` 就向上找；命中的文件在组件库目录（默认 `src/components/ui/`）则标记为 `component-impl`

由此产生一条**写进生成规范的约定**：生成的组合组件**必须透传 `{...props}`**，否则用户点它只会定位到组件实现。`packages/generator` 的模板与质量门禁要卡这条。

---

## 5. 需要改 DESIGN 的地方（已改）

| 位置 | 原文 | 改为 | 原因 |
|---|---|---|---|
| §6.4 | "`pool.max = 1~2`" | **`pool.max = 1`（硬约束）** | pool=2 时并发事务互串，`ROLLBACK` 会抹掉别的连接已写的行 |
| §6.4 | 只说"单写者串行" | 补充"单 backend 会话 → 连接池 >1 无收益且有数据风险" | 实测 p95 只差 19%，不值得 |
| §9.1 | 未提通知通道 | 明确"LISTEN/NOTIFY 在 PGlite 桥下不可用，推送只走 SSE" | 实测收到 0 条通知 |
| §10.1 | 单一 `data-tenon-loc` | `data-tenon-loc`（原生）+ `data-tenon-callsite`（组合组件） | 组合组件会指到实现而非用法 |
| §8.4 | 未要求透传 | 生成组件必须透传 `{...props}` | 否则 callsite 丢失 |
| 附录 B | 四条待验证 | 四条已全部验证（见本文） | — |

---

## 6. 留给后续的坑（M1 主干要注意）

1. **每个应用冷启动 2.4s**：`app.create` 之后要立刻给用户分阶段进度，别白屏；可以预热（首个应用创建时并行起 PGlite）。
2. **每应用 38MB 磁盘**：多应用场景要算总账；空应用也别指望"几十 KB"。
3. **事务 >1 连接 = 数据风险**：`packages/db-provisioner` 里要把 `pool.max` 写死成 1，并在代码注释里写明原因，防止后人"优化"成 2。
4. **`resume()` 不能忘**：server 启动序列里少了这一句，崩溃恢复能力等于没有。
5. **HMR 首帧要早挂监听**：网关/客户端都要在握手前把 `message` 监听挂好，否则丢 `connected`。
6. **taskGraph 静止时为空**：状态面板要在跑动中采样，静止时应展示"上次运行结果"而不是"没有任务"。

---

## 7. Spike 5：chord 宿主接入（M5 前置，2026-11-02）

`pnpm spike:chord`（`spikes/chord/`，10 项，全绿）。chord `1.4.0` + typebox `1.3.27`，锁精确版本（铁律 3）。

### 7.1 结论先说

三条会改变 M5 实现方式的事实，**都不是文档里读到的是踩出来的**：

1. **对象默认 `lifetime: "referenced"` —— 最后一个引用释放，对象连同 state 一起销毁，且不报任何错。**
   实测：一个 root 里把 `rows` 加到 5，root 结束后新 root 再 `get` 同一个 input，读到 **0**（新建的对象）。
   组件的状态要跨请求活着，必须在 `serve(type, factory, { linger })` 上给 linger（实测给 60s 后读到 4，符合预期）。
   **这条如果不知道，写出来的悬浮球/审批流每发一次请求进度就归零，而且测试里很难发现**（每次都"正常返回"）。
2. **断链不会报错，调用会挂住。** `memoryLink.sever()`（frames 双向静默丢弃、不发 close）之后调用方法，
   1.5s 内**既不返回也不抛**（判定 `hanged`）。所以 Web facet 的每一次调用都得自己带超时，
   不能指望"断了会告诉我"。
3. **打包没有坑。** esbuild 打成单文件 **726KB**、构建 **164ms**、`node bundle.mjs` 正常跑出 `BUNDLE_OK 2`。
   这点与 pi-codemode 相反（那边 worker/wasm 打包后静默失效），说明 chord 可以跟 server 一起打成 `server.mjs`，
   不必像 codemode 那样外部化整包。

### 7.2 逐项实测

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 契约 → `serve` → `root`/`get` → 方法 → 状态 | ✅ 一次 `append(2)` 返回 `rows=2`；root 结束时 `rows=5`、`revision=2` |
| 2 | 状态订阅（`state.subscribe`）| ✅ 收到 `[0, 2, 5]`：先 hydrate 当前值，再逐次给变更 |
| 3 | 方法里抛错的语义 | ✅ `invalid('script', …)` 原样回到调用方：`invalid: invalid/script: boom 是故意的` |
| 4 | **默认生命周期** | ⚠️ `rows` 从 5 变 **0** —— 对象被销毁重建（见 7.1 第 1 条）|
| 5 | `serve(…, { linger })` 跨 root 保 state | ✅ 读到 4 |
| 6 | `principal` + `variants` 的权限分流 | ✅ guest 拿到 `viewer`、`rows=0`（另一个对象）；强行调 `append` → `not_in_variant: … append is not a method of variant viewer`；owner 那份仍是 4 |
| 7 | 跨 host（`memoryLinkPair`，模拟浏览器那半边）| ✅ ui 写 7 → ui 重开 root 读 7 → server 自己读 7 |
| 8 | 断链语义 | ⚠️ `sever()` 之后调用 **1.5s 内挂住**（不返回、不抛）|
| 9 | 热重载（`host.reload([facet])`）| ✅ `hits` 仍是 2（state 保住），`stamp` 从 `v1` 变 `v2`，`codeVersion` 1 → 2 |
| 10 | esbuild 单文件 | ✅ 726KB / 164ms / 退出码 0 |

### 7.3 被推翻的假设（写代码前以为是怎样的）

| 以为是 | 实际是 | 后果 |
|---|---|---|
| "一个 `(type, input, principal)` 是同一个对象，state 自然跨调用" | 只在**有引用时**是同一个；引用放手就销毁 | 必须 `linger`，否则状态静默归零 |
| "`'append' in ref` 能判断 guest 有没有这个能力" | 恒为 `true`（Ref 是代理，`in` 不区分变体）| 要验权限得**真调一次**并断言 `not_in_variant` |
| "断了会抛 `unavailable`" | 静默丢帧，调用挂死 | 每个调用自带超时，界面要有"连接丢失"态 |
| "无参方法的实现是 `(args, ctx)`" | 是 `(ctx)`（有入参才是 `(args, ctx)`）| 类型签名写错会编译报错，好在不静默 |
| "`invalid(message)`" | `invalid(reason, message)` | — |

### 7.4 对 DESIGN §21 的影响（已改）

| 位置 | 原文 | 改为 |
|---|---|---|
| §21.3 | 只写"按声明加载 facet" | 补：组件 `serve` 必须显式 `linger`（否则状态随 root 销毁）；`lifetime: "host"` 只适合无 input 的单例 |
| §21.5 | 未提断链 | 补：链路静默丢帧，调用会挂住 → web facet 每个调用自带超时 + 心跳 |
| §21.2 | 未提变体探测 | 补：`in` 判断权限无效，必须试调并认 `not_in_variant` |
| §2 / 附录 | 未提打包 | 补：chord 可与 server 同打包（726KB），不需外部化（与 pi-codemode 相反）|
