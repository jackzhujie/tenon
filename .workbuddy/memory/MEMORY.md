# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构），作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / 代码地图 / **§5 陷阱表 170+ 条**）。
方案 `docs/DESIGN.md`。**这里只留「不知道就会走错方向」的**；细节与新坑一律写 STATUS §5。

## 协议（按目录分区，别搞反）
`apps/*` + `packages/*`（除下列两项）= **AGPL-3.0-only**；
`packages/runtime-sdk`、`packages/generator/templates`、`plugins/` = **Apache-2.0**（生成应用不传染）；
`docs/` = **CC BY 4.0**。版权行 `Copyright (c) 2026 jackzhujie and contributors`。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-07）
M1–M6 全部收口（九个包 + `apps/web` + `apps/desktop`；Hub 客户端/签名索引/组件商店/持久化/随包分发）。
收口后补的：应用能删/改名、未发布版本数、静态包导出、Docker 上下文、三平台 CI、四个平台安装包
（GH Actions + tag 自动 Release）、打包版 node shim、错误日志「发给 Agent」、**加后端能力 + 技术栈交给 Agent**。

**全绿基线**：lint 0 error / 10 warn · typecheck 18 project · CI 三平台矩阵（各 **756** 项）·
e2e:preview 16 · inspector 13 · diff 36 · release 44 · e2e 9 · component 5 · hub 32 · apps 18 ·
export 22 · docker 21 · postgres 31 · **e2e:backend 14** · e2e:packaged · smoke 9 · shot:* · build:web ~322KB。

**欠账**（都是卡外部或明确不做）：真 Hub 未上线（静态托管/域名/缓存）、真远端 push 要凭据、
**无签名/公证**（要 Apple $99/年 + Windows 证书）、Windows/Linux 安装包未被真启动过、
跨应用用量无总闸、DCO 不在 CI、商业授权无联系入口。

## 已定的架构选择（推翻要重做很多）
- server 与生成应用后端都 Fastify 5 / NestJS 11 + TS；应用库 `pglite`（默认）/ `postgres`，产品库 `node:sqlite`
- Git 一等公民（isomorphic-git 纯 JS）：一轮一 commit，回滚用 `revert`，看单条用 `git.show`
- 跨档迁移与发布档快照都是纯 JS（用户机器没有 `pg_dump`/`pg_restore`）；`@tenon/runtime` 源码分发 + 逐字节漂移测试
- 发布不走 `git.push`（只走 HTTP）；日志走应用自报不走 CDP；只读检索 `ls/glob/grep` 自己实现
- 组件是**注入式**（网关注入 + 宿主 activate），应用代码零参与 → 不生成 `components.generated.ts`
- **加后端是"功能包"不是"模板"**：只写新文件 + package.json 只补缺 + 就地改几处（`applyApiFeature`）

## 最容易静默坏掉的（全表见 STATUS §5，这里只放最要命的）
- **pglite 档 `pool.max` 必须 = 1**（>1 时一条 ROLLBACK 抹掉另一条已写入的行）；迁移必须 `setval`
- **不能用 `git.statusMatrix` 判变更**（同长度同毫秒被判"没变"）→ 自算 blob oid + `add({force:true})`；
  `git.writeObject` 传 string 写坏对象 → 一律 Buffer
- 回滚顺序必须是「检查 → 还原数据 → 回滚代码」；`dumpDataDir()` ≠ `cp -r`
- **用量只在服务端算**（`harness.usage()` 全量快照），前端累加必少一半；熔断判 `>=`；
  汇总缺 `known`/`failed`/`priced` 三格会骗人。跨应用读账本**不能 `acquire()`**（会跑起别人的任务）
- **`chat.close()` 是全局开关** → 删应用用 `chat.detach(appId)`
- **新建工具必须三处都动**：`tools` 数组、`extensions`、`registry.install()`。少一处 = 模型一调就
  "工具不存在"，而界面还显示 ✓
- **`content-length` 与 `transfer-encoding` 不能并存**（注入脚本后只重算长度 → 客户端永等不到结束）
- **`tenon.api` 是"有没有后端"的唯一开关**；漏写 = 前端正常、`/api` 永远 502
- **ESM 应用（`"type": "module"`）+ CJS 后端产物 = `require is not defined`**：Node 只看最近
  package.json 的 `type`。产物目录要放 `{"type":"commonjs"}` —— `build:api` 与网关各钉一次
  （预览走 `tsc --watch`，不经过 build 脚本）
- **发布门禁三态**（skip/fail）；「没跑成」是 `fail`；预检结论只对那个 sha 有效（publish 自己再跑）
- **chord**：对象默认 `referenced` → state 会静默归零（组件必须 `linger`）；断链调用挂住不抛；
  状态字段不能叫 `status/error/variant/ready/...`；链路要在 socket 建出来那一刻挂上
- **Hub 索引必须签名**（包签名拦不住降级到旧版）；索引里 URL 是绝对的 → 换域名必须重发布；
  **付费要拦在"下载"之前**（`hub.install` 会把包落到 `~/.tenon/plugins`）
- **打包版配置不能只靠环境变量**（双击的 `.app` 里没有 `TENON_*`）→ 固定「壳指路径 + 业务读内容 + 界面报来源」
- **打包版没有 `node`**，而应用自己的 `.bin/*` 是 `exec node` 的 shim → `core/node-shim.ts` 给 PATH
  塞假 node；**单测测不出来**（vitest 里没有 electron），要 `pnpm e2e:packaged`
- **建应用"不等地"装依赖 + 删应用 = 赛跑** → 删前必须 `await preview.cancelDeps(id)`（杀整棵树 + 等 task）
- **杀 pnpm 不等于杀掉孙进程**（eslint/vitest 握着 stdout → `close` 永不来）→ `detached` + 负 pid，
  且**超时立刻 resolve 不等 close**
- **"命令没装"不能靠退出码或文案判断**（pnpm 把 127 折成 1；dash/sh 文案不同）→ 看脚本首个词在不在
  `node_modules/.bin`。而且必须与"代码有问题"分成两句话
- **路径护栏别硬拼正斜杠**（Windows 永远为假 → 删应用永远失败）→ `relative()`；
  **别用 `file://` + argv[1] 判断"是否直接运行"**（Windows 永远为假 → 静默空跑、退出码 0）→ `pathToFileURL`
- **Windows 上 `spawn('pnpm')` ENOENT**（`.cmd` 还要 `shell: true`）；**没有可捕获的 SIGTERM**（优雅关停走关 stdin）
- **"单文件自包含"是 Hub 硬约束** → 跨组件共享依赖做不到；组件体积不是 React 占的（是 typebox），
  盘体积先跑 `esbuild --metafile`
- **模板的 lint 只留三条是设计**；"lint 报几万个"先查 ignore；`no-useless-assignment` 对 TS 是噪声
- **`electronMain()` 模板字符串里不能出现反引号**；**注释里不能出现"星号+斜杠"**（会结束块注释）
- **JSX 文本里的 `**xx**` 不会加粗**；React 受控输入直接赋 `value` 无效（要原生 setter + `input` 事件）
- **README 与 STATUS 双写必然长出过期句子**：README 讲"能做什么"，STATUS 讲"怎么做的、坑在哪"

## 本机环境
Node v22.22.2 / pnpm 10.x。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`
（node-language-shim 让 PGlite 慢 10 倍；Electron 被误当 node）。无 `pg_dump`。
docker 可用：colima（vz）+ 官方二进制；colima 不自启，重启后先 `colima start`；
**不要把 `/usr/local/bin` 放到 PATH 前面**（brew 的 Node 20 会顶掉项目 Node 22 → `node:sqlite` 找不到）。
Electron 需 `--no-sandbox`；`npx electron` 是断链 → 用 `.pnpm/electron@<ver>/.../MacOS/Electron`。
**本机 bash 的 `grep` 常返回空** → 查文件用 Grep 工具。`docs/PI-CHEATSHEET.md` 写代码前必查。
`docs/reverse/`、`*.har` 仅研究，**clean-room 红线：不得搬代码/文案/提示词**。
**改完前端必须重启 server 再截图**（启动时把 `apps/web/dist` 读进内存）。
