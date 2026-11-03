# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / 代码地图 / **§5 陷阱 153 条，细节都在那里**）；
方案 `docs/DESIGN.md`（v1.2.25）。这里只留「不知道就会走错方向」的。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-03）
M1 九步 + M2 七步（Docker 产物按用户决定跳过）+ M3 九步 + M4 七步 + **M5 八步全部收口**
（DoD ①②③④ 满足）→ DESIGN v1.2.25。九个包 + `apps/web` + `apps/desktop`。
全绿基线：typecheck 18 project / test **540** / smoke 9 / e2e:preview 16 / e2e:inspector 13 /
e2e:diff 36 / e2e:release 44 / e2e:e2e 9 / **e2e:component 5** / spike:chord 10 /
smoke:desktop:packaged 8 / build:web 299KB。
M5 = 组件体系：chord 宿主 → `@tenon/component-host`（清单/装配/覆盖层/加载计划）→
三个官方组件（AI 小助手 / 导出 CSV / 审批流，契约形状一致）→ 网关注入 + WS 链路 →
`install_component`/`remove_component`/插件页 → 真 Chromium 端到端。
**欠账**：Docker compose 产物、真远端 push、`lint` 未接、额度无跨应用总闸、
用量答不了"哪个角色花了多少"、组件无持久化（审批数据重启即失）、三个 web bundle 各 735KB 未共享运行时。

## 已定的架构选择（推翻要重做很多）
- server 与生成应用后端都 Fastify 5 / NestJS 11 + TS ESM；应用库 `pglite`（默认）/ `postgres`，产品库 `node:sqlite`
- Git 一等公民（isomorphic-git 纯 JS 打进 `server.mjs`）：一轮一 commit，回滚用 `revert`，看单条用 `git.show`
- 跨档迁移纯 JS 逻辑拷贝（不用 `pg_dump`）；`@tenon/runtime` 源码分发 + 逐字节漂移测试
- 发布不走 `git.push`（只走 HTTP 传输）；日志走应用自报不走 CDP；只读检索 `ls/glob/grep` 自己实现
- 组件是**注入式**（网关注入 + 宿主 activate），应用代码零参与 → 不生成 `components.generated.ts`

## 会静默坏数据/静默失效的（完整 153 条见 STATUS §5）
- **pglite 档 `pool.max` 必须 = 1**（否则一条 ROLLBACK 抹掉另一条已写入的行）；迁移必须 `setval`
- **不能用 `git.statusMatrix` 判变更**（同长度同毫秒改动被判"没变"）→ 自算 blob oid + `add({force:true})`；
  `git.writeObject` 传 string 写坏对象 → 一律 Buffer
- 回滚顺序必须是「检查 → 还原数据 → 回滚代码」；`dumpDataDir()` ≠ `cp -r`
- **用量只在服务端算**（`harness.usage()` 全量快照），前端累加必少一半；熔断判 `>=`
- **`chat.close()` 是全局开关** → 删应用用 `chat.detach(appId)`
- **`content-length` 与 `transfer-encoding` 不能并存**（注入脚本后只重算长度 → 客户端永等不到结束）
- **扩展只 `registry.install()` 不够，必须进会话的 `extensions`**；`AgentChange.tools` 是可用集，
  `modelTools` 才是递给模型的
- **发布门禁三态**（skip/fail）；「没跑成」是 `fail`；`force` 只改「拦不拦」不改「跑不跑」；
  预检结论只对那个 sha 有效（publish 必须自己再跑一遍）
- **chord**：对象默认 `referenced` → state 随 root 静默归零（组件必须 `linger`）；断链调用挂住不抛
  （每个调用自带超时）；状态字段不能叫 `status/error/variant/ready/...`（`member name is reserved`）；
  host `name` 必须等于契约 `hostNamed(…)`；**链路要在 socket 建出来那一刻挂上**（等 `open` 会丢帧 → ack 越界）
- **组件覆盖层按"根"选版本**（hub > bundled，不是全局最高）；装配逐条独立判定；
  装不上返回 problem 不抛 500；facet 是构建产物不进 git（忘建的表现是 Cannot find module）；
  `TENON_PLUGINS_DIR` 与 `TENON_TEMPLATES_DIR` 同坑（错的表现是"插件页空空如也"且无报错）
- **模块脚本加载失败是静默的** → 网关插了错误捕手 `window.__tenonComponentErrors`，端到端读它

## 本机环境
Node v22.22.2 / pnpm 9.15.9。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`
（node-language-shim 让 PGlite 慢 10 倍；Electron 被误当 node）。无 docker / `pg_dump`。
Electron 需 `--no-sandbox`（否则 ERR_FAILED）；`npx electron` 是断链 → 用 `.pnpm/electron@<ver>/.../MacOS/Electron`。
**本机 bash 的 `grep` 常返回空** → 查文件用 Grep 工具。`docs/PI-CHEATSHEET.md` 写代码前必查。
`docs/reverse/`、`*.har` 仅研究，**clean-room 红线：不得搬代码/文案/提示词**。
**改完前端必须重启 server 再截图**（启动时把 `apps/web/dist` 读进内存）。
