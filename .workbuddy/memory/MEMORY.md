# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。产品名 Tenon，作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，全局改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / 代码地图 / **§5 陷阱 136 条**）；方案 `docs/DESIGN.md`（v1.2.22）。
这里只留「不知道就会走错方向」的，细节查 STATUS §5，别重复。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`DATABASE_POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-02）
M1 九步 + M2 七步（第 8 步 Docker 产物按用户决定跳过）+ M3 九步 + **M4 第 1–7 步** → DESIGN **v1.2.21**。
八个包 + `apps/web`（渲染器）+ `apps/desktop`（壳）。
全绿基线：typecheck 15 project / test **435** / smoke 9 / e2e:preview **16** / e2e:inspector **13** /
e2e:diff **36** / e2e:release **44** / **e2e:e2e 9** / e2e:fullstack / smoke:desktop:packaged 8 / build:web 299KB。
M3 已通：定位注入 → 反查 → Alt+Click → 跨源回传 → 逐行差异 → 代码回滚 → 数据回滚 → 发布（tag + 本地裸库）。
M4 第 1 步：**子 Agent 能派活**（`roles.ts` 是 1 主 + 5 子的唯一事实来源；`subagent` 建真子会话、
只读白名单、递归从工具集上断；`explore`/`librarian` 可用，其余三角色待接工具）。
M4 第 2 步：**任务图面板**（`watchTaskGraph` 逐帧 → 归一化 → SSE 推全量 → 预览下方任务条，DoD ②）。
M4 第 3 步：**用量与预算熔断**（`harness.usage()` 会话账本 → `usage.update` 推全量快照 + `budget.set`
按应用设额度 → `submit` 402 拦 / 跑到一半超线 `budget.exceeded` + abort，DoD ③）。
M4 第 4 步：**e2e 子 Agent 自己去点页面**（`PageBridge` 让页面反连长轮询领命令 →
`preview_read/assert/click/type/open` 五个工具 → `pnpm e2e:e2e` 注入 `+2` bug、断言失败、修好、
同一条断言通过，DoD ①）。**DoD ①②③ 已满足**。
M4 第 5 步：**Reviewer 出风险清单**（`worktreeDiff` 工作区 vs HEAD → `git_diff`；`tsc` 解析 +
`typecheck` 跑应用自己的多 tsconfig；reviewer 转 `ready`，无任何写工具）。
M4 第 6 步：**CodeAct 的脚本沙箱**（`codeact.ts`：CodemodeSandbox 60s/128MB + 上游 codemode 扩展；
`roles.ts` 新增 `modelTools` / `extensions`；`build.mjs` 外部化 pi-codemode + quickjs-wasi 并自检）。
M4 第 7 步：**发布前质量门禁**（`checks.ts` 的 `runTypecheck`/`runTestScript`/`runQualityGate`；
三态判据、`force` 仍跑检查并留痕、迁移 2 给 `releases` 加两列、对话框摊开清单 + 二次确认）。
**发布预检 `release.check`**（只读地回答"能不能发"，与 publish 共用 `inspectRelease`；
`stale` 用前后两次 HEAD 判、不缓存、同 appId 并发合并；对话框打开即查）。
**五个子角色全部 `ready`；M4 七步收口 + 预检补完。**
**下一步：M5 或欠账里的高优项**，先看 §4.2 的 M4 表与 §4.17 的「还没做的」。
欠账：Docker compose 产物、真远端 push、真模型下的"改样式自验"、额度无跨应用总闸、
用量答不了"哪个角色花了多少"、`lint` 未接（模板没 eslint 配置）、
脚本能用 `// @options: timeout_ms` 放大沙箱默认超时、主界面没有"当前能不能发"的指示。

## 已定的架构选择（推翻要重做很多）
- 两边都 **Fastify 5 + TS ESM**（server 与生成应用后端是 NestJS 11 + TypeORM + PG 方言）
- 应用库两档 `pglite`（默认，零安装）/ `postgres`（发布）；产品库 `node:sqlite`
- **「安装包零原生模块」v1.2.13 起不再是硬约束**：预编译分发，`build.mjs` 只审计不拦。
  **仍守的边界：生成应用模板不引入需编译的包**（用户自己 `pnpm install`）
- Git 一等公民（isomorphic-git **纯 JS**，打进 `server.mjs`）：一轮一 commit；回滚用 `revert`；
  看单条改动用 `git.show`（`diff(sha)` 是累积语义）
- 跨档迁移**纯 JS 逻辑拷贝**，不用 `pg_dump`（用户机器上没有二进制）
- `@tenon/runtime` **源码分发**进模板（不发布 npm）+ 逐字节漂移测试
- **发布不用 `git.push`**（只走 HTTP 传输）：自己搬对象 + 写 ref 到裸库。真远端是"再加一个 transport"
- 日志采集走**应用自报**不走 CDP（只覆盖浏览器侧 / F12 就抢走 / 首屏全丢）
- **只读检索 `ls`/`glob`/`grep` 是自己的实现**：`pi-coding-agent` 的 grep/find 会下载 rg/fd 二进制
- **档位（fast/comprehensive/thinking）目前只是声明**：设置只能存一个 provider，按档换模型是后续步骤

## 会静默坏数据/静默失效的（忘了看不出来）
- **pglite 档 `pool.max` 必须 = 1**：事务串到同一 backend，一条 ROLLBACK 抹掉另一条已写入的行（实测丢行）
- **不能用 `git.statusMatrix` 判变更**：同长度同毫秒的改动被判"没变" → 自算 blob oid + `add({force:true})`
- **迁移必须 `setval` 对齐序列**：否则全绿、行数一致，用户第一次新建就主键冲突 500
- **回滚顺序必须是「检查 → 还原数据 → 回滚代码」**：覆盖库不可逆。快照按 commit sha 归档，沿祖先链找
- **`dumpDataDir()` ≠ `cp -r` 数据目录**：前者运行中调用安全，后者才必须先 stop
- **`git.writeObject` 传 string 写坏对象**（fsck 报 could not be parsed 还不报错）→ 一律 Buffer；
  裸库 API 必须传 `gitdir` 不是 `dir`
- **`api.conversation(id)` 的句柄没有 `configure()`** → 子会话的模型/工具/指令只能在
  `harness.createConversation({ agent })` 那一刻定；`ConversationRecord` 的字段叫 `owner` 不是 `ownership`
- **faux 的响应工厂只服务一次**（内部 `shift()`）→ 必须把自己 `appendResponses` 塞回队尾；
  父子会话**必须分道**，否则子 Agent 吃掉父轮的台词（表现：派了活没干活）
- **pi 的 `owner` 是任务树不是会话树**：子会话的 generation 没有 owner，"谁派了谁"看 `conversations`；
  角色只在 `getTask().state.checkpoint.arguments` 里，且 `phase:'execute'` 之后才写进去
- **任务图静止即空**（节点被回收）：不能当派活历史，要历史看 `ConversationRecord.owner`
- **用量绝不在前端累加**：子 Agent 的消耗不经过父会话事件流、压缩摘要连 entry 都没有 → 只认
  `harness.usage()` 的全量快照（`usage.update` 推全量，逐条增量必然少一半）。熔断判 `>=` 不是 `>`
  （否则"上限设 0"等于"不设限"）；pi 没有 pre-request 钩子，所以是"花超了就停"不是"预测着不发"
- **`chat.close()` 是全局开关**：删一个应用会掐掉**所有**应用的 `app.status` → 删应用用 `chat.detach(appId)`；
  且 `close()` 之后再读 `harness.usage()` 会拽住 sqlite（症状：测试清理临时目录 `ENOTEMPTY`）
- **`content-length` 与 `transfer-encoding` 不能并存**：注入脚本后只重算长度、留着上游的 chunked，
  客户端**永远等不到响应结束**（预览一直 `failed`，日志一个字都没有）→ 两个都删
- **扩展只 `registry.install()` 不够，必须进会话的 `extensions`**：否则子会话里工具"不存在"，
  模型若无其事继续讲，`execute` 一次都不进（表现：派了活但没调工具）
- **整页导航会掐断挂着长轮询的请求**：网关那个 `await poll()` 还活着 → 命令投进死连接，只能等超时。
  要 `poll(id, signal)` + `res.on('close')` abort；`poll` 遇到旧 sessionId 要回 `'reset'` 不是 `null`（否则空转）
- **页内抛异常也必须回话**，否则调用方只等到超时、真实信息（"没找到第 1 个…"）根本没送出去
- **断言失败要 `isError: false`**（那是"页面与预期不一致"，模型该改代码而不是重试工具）；
  参数不合法才在发命令之前拦
- **React Fast Refresh 保留 state**：改完代码计数不回 0，干净起点必须整页重载（`preview_open`）；
  而 `sessionId` 存 `sessionStorage` 才能跨 reload 延续同一条通道
- **`.gitignore` 的 `release/` 会让 Tailwind 跳过 `features/release/`**（v4 不扫 gitignore 命中路径）
- **评审要看工作区不是提交**：`commitAll` 在一轮收尾才跑 → Reviewer 动手时改动未提交，
  `diff()/showCommit()` 比的是两棵树。要 `worktreeDiff`（HEAD ↔ 工作盘），且同样**自算 blob oid**
  （`statusMatrix` 漏同长度同毫秒改动 → "说没问题、其实没看到"是最坏的绿）
- **`typecheck` 判据是「跑完了 + 没诊断」**：只看出错会把 `tsc` 崩了/超时/tsconfig 写错报成通过；
  缺 `node_modules`、缺 tsconfig、超时三种都必须说"没跑成"且不出现 `✓`
- **`scrubEnv` 会删 `ELECTRON_RUN_AS_NODE`**：`.app` 里 `process.execPath` 是 Tenon 自己 →
  跑 `tsc` 这类自有子进程时要**显式补回**，否则会弹出一个窗口而 `tsc` 一行不跑
- **"工具在会话里"≠"工具递给模型"**：`AgentChange.tools` 是可用集，`modelTools` 才是递给模型那份；
  不写 `modelTools` = 全给。CodeAct 的 `read/ls/glob/grep` 必须只进可用集，否则模型绕过脚本直读
- **沙箱能力由注入决定**：脚本里 `tools.write` 调不动是因为没注进去，不是提示词拦的；
  且 `tools` 是**抛异常的代理**（`typeof tools.write` 会抛）→ 脚本里要 `try/catch`
- **`CodemodeSandbox` 的两条 `import.meta.url`（worker + wasm）在打包后全失效，而构建照样成功** →
  `build.mjs` 里 external + 整包拷 `pi-codemode` 与 `quickjs-wasi`（含 `dist/`，不含 `extensions/*.so`），
  并留了 `assertCodemodeLayout()` 自检。`require.resolve` 那个包会报 `No "exports" main defined` → 用 `realpath`

- **发布门禁的判据是三态**：`skip`（这个应用没这项检查）放行、`fail`（该检查的没检查成功）必拦。
  合成布尔会让"没配测试"和"测试挂了"同罪 —— 前者永远发不出去、后者红了照发，两种都会让功能被关掉
- **「没跑成」是 `fail` 不是 `skip`**：有 tsconfig 却没装 typescript 归到 skip，等于删掉 node_modules 就能绕过门禁
- **`force` 只改「拦不拦」不改「跑不跑」**：用户有权坚持发，但没权不知道自己在放过什么；
  结果照样写进 `releases.gate_status = 'forced'`（老记录的这两列必须是 `null`，给默认值就是伪造历史）
- **`vitest` 默认 watch**：`pnpm run test` 不加 `CI=1` 会一直挂着，最后被报成"测试超时"（不是测试的问题）
- **测试里别写死 `schemaVersion`**：加一条迁移就红，而那种断言最后一定会被改成 `toBe(当前版本号)` 然后失去意义

- **预检的结论只对那个 sha 有效**：用户看清单、写说明、点发布之间代码随时会变 →
  `publish` 必须自己再跑一遍（不复用预检结果），返回里必须带 `commitSha` + `stale`。
  拿 A 版的「通过」给 B 版背书，比不检查更糟
- **`ready` 不是按钮的 disabled 依据**：`ready=false` 有两种 —— 前提不满足（真不能发）
  和门禁没过（能发，要 force）。接上去等于把「仍然发布」焊死
- **别在 JSX 里写 markdown 的 `**加粗**`**（原样渲染星号且不报错）；JSX 换行会变成空格

## 本机环境
Node v22.22.2 / pnpm 9.15.9。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`
（注入的 node-language-shim 让 PGlite 慢 10 倍 → 撞 30s 超时；Electron 也要去掉）。
无 `docker`/`podman`/`colima`、无 `pg_dump`。Electron 需 `--no-sandbox`（否则 ERR_FAILED）。
**`npx electron` 不可用**（`.bin/electron` 是断链 → SIGTERM 137 且无任何输出），要直接用
`node_modules/.pnpm/electron@<ver>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`。
**本机 bash 的 `grep` 常返回空**（shell 注入了 shim）→ 查文件一律用 Grep 工具，别信 `grep` 的空输出。
`docs/PI-CHEATSHEET.md` 是 pi 全生态真实 API，写代码前必查。`docs/reverse/`、`*.har` 仅内部研究，
**clean-room 红线：不得搬运其代码 / 文案 / 提示词**。
**改完前端必须重启 server 再截图**：它启动时把 `apps/web/dist` 读进内存，否则截到的是旧 UI
（诊断法：量 `getComputedStyle(el).right`，别靠看截图猜）。临时截图脚本要从仓库根跑
（`pnpm --filter <pkg> exec` 会把 `process.cwd()` 变成包目录，`webDir` 就解析错）。
