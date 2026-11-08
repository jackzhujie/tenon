# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构），作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / 代码地图 / §5 陷阱 170+ 条全表）。
**陷阱细节拆在同目录 `TRAPS.md`**；新坑一律写 STATUS §5。这里只留「不知道就会走错方向」的。

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
收口后补：应用删/改名、静态包导出、Docker 上下文、三平台 CI + tag 自动 Release、打包版 node shim、
错误日志「发给 Agent」、**加后端能力 + 技术栈交给 Agent**。
全绿基线：lint 0e/10w · typecheck 18 · CI 三平台各 **756** 项 · e2e 系列全过（含 e2e:backend 14、e2e:packaged）· build:web ~322KB。
**欠账**：真 Hub 未上线、真远端 push 要凭据、**无签名/公证**（Apple $99/年 + Win 证书）、
Win/Linux 安装包未被真启动过、跨应用用量无总闸、DCO 不在 CI、商业授权无联系入口。

## 已定的架构选择（推翻要重做很多）
- server 与生成应用后端都 Fastify 5 / NestJS 11 + TS；应用库 `pglite`（默认）/ `postgres`，产品库 `node:sqlite`
- Git 一等公民（isomorphic-git）：一轮一 commit，回滚 `revert`，看单条 `git.show`
- 跨档迁移与发布档快照都是纯 JS（用户机器没有 pg_dump/pg_restore）；`@tenon/runtime` 源码分发 + 逐字节漂移测试
- 发布不走 `git.push`（只走 HTTP）；日志走应用自报不走 CDP；组件**注入式**（网关注入 + 宿主 activate）
- **加后端是"功能包"不是"模板"**：只写新文件 + package.json 只补缺 + 就地改几处（`applyApiFeature`）

## 最要命的坑（全表 → `TRAPS.md` / STATUS §5）
- pglite 档 `pool.max` 必须 = 1；`git.statusMatrix` 不能判变更；`writeObject` 一律 Buffer
- 用量只在服务端算；跨应用读账本不能 `acquire()`；删应用用 `chat.detach` 不用 `chat.close`
- 新建工具必须三处都动（tools / extensions / registry.install）
- `tenon.api` 是后端开关；ESM 应用 + CJS 产物要在产物目录放 `{"type":"commonjs"}`（build:api 与网关各钉一次）
- Hub 索引必须签名；付费拦在"下载"之前；打包版配置走文件不走环境变量；打包版无 node（node-shim）
- 杀进程要 detached + 负 pid 杀整组，超时立刻 resolve；"命令没装"看首词在不在 node_modules/.bin
- 路径护栏用 `relative()`；Windows 判断直接运行用 `pathToFileURL`；优雅关停走关 stdin
- README 讲"能做什么"，STATUS 讲"坑在哪"，双写必然过期
- 合并"相邻步骤"先看清相邻在哪一层（工具调用是**每条消息一个**）；任务图只在跑时存在
- **诊断脚本本身会骗人**：模板字符串转义、只看前 N 个元素、在 `.cjs` 里写 TS 类型 ——
  "看起来没生效"先怀疑探针

## 本机环境
Node v22.22.2 / pnpm 10.x。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`。
docker = colima（不自启，先 `colima start`）；别把 `/usr/local/bin` 放 PATH 前面（brew Node 20 顶掉 Node 22）。
本机 bash 的 `grep` 常返回空 → 用 Grep 工具。`docs/PI-CHEATSHEET.md` 写代码前必查。
`docs/reverse/`、`*.har` 仅研究，**clean-room 红线：不得搬代码/文案/提示词**。改完前端必须重启 server 再截图。

## 协作方式（2026-11-08 用户明确要求）
- 新产品类任务必须**分步骤、每步确认**：先出方案 → 用户确认 → 才动手；不要一口气把分析+设计+实现全做完
- 未确认前不写文件、不跑会改状态的命令
- 进行中：AI 电脑管家（桌面 App 带面板）；一期 = 诊断三件套（断网修复/软件分析/存储诊断），先只做只读诊断；Step 1 范围已确认，当前停在 Step 2 闸门前
