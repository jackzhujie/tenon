# 项目记忆 — Tenon（榫）

本地优先、可自托管的**对话式 AI 全栈应用搭建平台**（桌面 + Web 同构）。作用域 `@tenon/*`。
隐喻：应用靠标准组件咬合，Agent 只做设计。⚠️ `LM Studio` 是第三方名，改名须保护。

**开工入口：`docs/STATUS.md`**（进度 / DoD / 代码地图 / **§5 陷阱 168 条，细节都在那里**）；
方案 `docs/DESIGN.md`（v1.2.26）。这里只留「不知道就会走错方向」的。

## 协议（已落地，别搞反）
**按目录分区**，不是单一协议：`apps/*` + `packages/*`（除下面两项）= **AGPL-3.0-only**；
`packages/runtime-sdk`、`packages/generator/templates`、`plugins/` = **Apache-2.0**（生成的应用不传染）；
`docs/` = **CC BY 4.0**。版权行 `Copyright (c) 2026 jackzhujie and contributors`。
商业双许可（闭源集成 / 公司内部多人部署）写在 `NOTICE` 与 README 的 License 段。

## 三条铁律
1. **Electron 只做壳**，业务全在本地 HTTP Server（否则 Web 模式 / Agent 自调试 / SaaS 化全废）
2. **生成应用永不感知运行环境**，只认 `DATABASE_URL`（`POOL_MAX` 是容量参数，不是环境判断）
3. **pi 全家与 PGlite 是实验性 API** → `save-exact` 锁版本 + adapter 包一层

## 状态（2026-11-04）
M1 九步 + M2 七步（Docker 产物按用户决定跳过）+ M3 九步 + M4 七步 + **M5 八步全部收口**
（DoD ①②③④ 满足）。九个包 + `apps/web` + `apps/desktop`。
**M6 五步全部收口**（Hub 客户端验签/落盘 + 签名索引 + `hub.check` + **组件商店** +
**组件持久化**（`db:*` → `(appId, componentId)` 键值空间，配额 500 键/64KB）+
**收口**：授权模型定稿（DESIGN §21.5，现在不做 license）+ **Hub 配置随包分发** +
`pnpm e2e:hub` 32 项从零发布）。
**收口后补的一批**（盘点"还剩什么没完善"）：应用能删（原来是死代码）、能改名、顶栏有
未发布版本数（`lib/release-hint.ts`）、脚本的 `@options` 不再能放大超时上限（§4.37）、
**导出静态包**（`export.static`，产物拷走就能跑）+ **Docker 上下文**（`export.docker`，
M2 第 8 步落地；compose 自带 PG，`e2e:docker` 全栈 21 项真跑 compose）。
全绿基线：typecheck 18 project / test **712** / smoke 9 / e2e:preview 16 / e2e:inspector 13 /
e2e:diff 36 / e2e:release 44 / e2e:e2e 9 / **e2e:component 5** / **e2e:hub 32** / **e2e:apps 18** / **e2e:export 22** / **e2e:docker 21** / **e2e:postgres 31** / **shot:usage** /
spike:chord 10 / smoke:desktop 8 / smoke:desktop:packaged 8 / build:web 322KB。
M5 = 组件体系：chord 宿主 → `@tenon/component-host`（清单/装配/覆盖层/加载计划）→
三个官方组件（AI 小助手 / 导出 CSV / 审批流，契约形状一致）→ 网关注入 + WS 链路 →
`install_component`/`remove_component`/插件页 → 真 Chromium 端到端。
**欠账**：Docker compose 产物、真远端 push、**真 Hub 未上线**（静态托管/域名/缓存）、`lint` 未接、
额度无跨应用总闸、用量答不了"哪个角色花了多少"、三个 web bundle 各 735KB 未共享运行时。

## 已定的架构选择（推翻要重做很多）
- server 与生成应用后端都 Fastify 5 / NestJS 11 + TS ESM；应用库 `pglite`（默认）/ `postgres`，产品库 `node:sqlite`
- Git 一等公民（isomorphic-git 纯 JS 打进 `server.mjs`）：一轮一 commit，回滚用 `revert`，看单条用 `git.show`
- 跨档迁移与**发布档快照**都是纯 JS（不用 `pg_dump`/`pg_restore`，用户机器没有那两个二进制）；
  `@tenon/runtime` 源码分发 + 逐字节漂移测试
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
- **Hub 索引必须签名**：包签名拦不住"把最新指向旧的、确实签过名的版本"（降级）；
  索引地址固定 `<hubUrl>/index.json`，里面的 URL 是绝对的 → 换域名必须重新发布
- **打包版的配置不能只靠环境变量**：双击打开的 `.app` 里没有 `TENON_*` → 商店永远"未配置"且不报错。
  模式固定为「壳只指路径 + 业务侧读内容 + 界面报来源」（`TENON_HUB_CONFIG_FILE` 与
  `TENON_PLUGINS_DIR`/`TENON_TEMPLATES_DIR` 同构）；`extraResources` 来源不存在会让打包失败，所以
  `build.mjs` 总是写一份（没配就写空值）
- **付费（`pricing: paid`）要拦在"下载"之前**，`installComponent`（装进应用）拦不住 `hub.install`
  （装到本机）→ 包会落到 `~/.tenon/plugins`。判据用索引（误拒只是"暂未开放"，漏判是"付费内容已在磁盘"）；
  真判据仍在签名包里。发布脚本必须把 `pricing` 写进索引，否则那道门永不触发
- **PEM 尾换行会造出第二个指纹**（文件读出来带换行、env 读出来 trim 过）→ `hubKeyFingerprint` 先 trim；
  `resolveHubConfig` 顺序必须「先还原字面量 `\n` 再 trim」
- **脚本的 `@options` 能放大超时**：上游是 `options.timeoutMs ?? this.timeoutMs`，脚本写
  `// @options: {"timeout_ms": 3600000}` 就绕过了 60 秒上限。**自己设的上限必须自己在工具入口夹**
  （`codeact.ts` 的 `checkScriptOptions`），拒绝而不是静默钳制
- **`electronMain()` 模板字符串里不能出现反引号**（注释里写 `` `git.log` `` 会提前结束模板，
  报 TS1005 像别处坏了）；React 受控输入直接赋 `value` 无效，要原生 setter + `input` 事件
- **"装了"≠"用上了"**：组件装在本机是全局的，用不用由应用声明的版本区间定；
  `planHubUpdates` 的 `blockedBy` 就是这件事，install 不重载区间不接受的应用
- **"装到本机"≠"装进应用"**：前者写 `<home>/plugins`，后者写装配声明 + `AGENTS.md` + reload。
  共用入口 `installComponentWithHub`（缺包就去 Hub 拿），三处（RPC / 工具 / 商店）都走它
- **付费门禁只拦"安装"，且明说不是 DRM**：组件文件明文落盘，加载层再拦是自我安慰
- **组件的 `activate` 可以是 async**（先恢复数据再 `serve`）：宿主必须 await；测试夹具里最容易漏
- **恢复数据时"计数类状态"初值不能写死 0**（审批流重启后徽标 0 而清单有 2 张待审单 → 用户重复提交）
- **没权限时给 `undefined`，不给"一调就抛的对象"**：否则组件作者只会 try/catch 静默降级
- **组件覆盖层按"根"选版本**（hub > bundled，不是全局最高）；装配逐条独立判定；
  装不上返回 problem 不抛 500；facet 是构建产物不进 git（忘建的表现是 Cannot find module）；
  `TENON_PLUGINS_DIR` 与 `TENON_TEMPLATES_DIR` 同坑（错的表现是"插件页空空如也"且无报错）
- **跨应用读账本不能 `acquire()`**：那会建 5 个扩展（`codeact` 起 worker 线程）、`configure`
  根会话、还 `resume()` —— 为了看一眼别人花了多少钱，把人家的任务也接着跑了。开"最小 harness"
  （同 storage + 共享 models + 空 registry + 不 resume）读 `usage()`，16ms 一个
- **用量汇总缺一格就会骗人**：`known`（还没账本 ≠ 花了 0）、`failed`（读不到的不加进合计）、
  `priced`（没配价格时 $0 是"没算"）。三格全是"看起来像数字其实是假的"
- **`formatTokens` 10k 以上取整会让汇总对不上**（6.3k+4.2k=10k）→ 改成 10k~99.9k 保留一位小数
- **杀 pnpm 不等于杀掉它的子进程**：`child.kill('SIGKILL')` 只杀直接子进程，而它再 spawn
  `eslint`/`vitest`，**孙进程握着 stdout** → 管道不关 → `close` 永远不来 → `await` 挂着，
  界面"检查中…"永不结束。要 `detached: true` 进自己的进程组 + 负 pid 杀整组，
  并且**超时立刻 resolve，不等 close**
- **不能拿 `ELIFECYCLE` / `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 判断"命令没装"**：这两行在
  **任何** pnpm 失败里都有。拿它当判据会把"查到 3 个错误"报成"没装依赖"，
  用户会去改一段本来没问题的代码。只看 shell 的 `: command not found`
- **"命令没装"与"代码有问题"必须两句话**：前者 `pnpm install`，后者改代码。
  门禁里混成一句，等于给用户指错方向
- **模板的 lint 规则只留三条是设计不是没配完**：开 `recommended` 全家桶会让 Agent 生成
  一次红一次，而**被关掉的检查等于不存在**。`exhaustive-deps` 设 warn（误报太多，
  设 error 会成最常见拦路石）
- **模块脚本加载失败是静默的** → 网关插了错误捕手 `window.__tenonComponentErrors`，端到端读它
- **子会话的花费不进父会话的 `pi.usage`**（"嵌套调用不进父会话事件流"的另一面）→ 要知道
  "这次派活花了多少"必须按子会话 id 读 `harness.snapshot(UsageDoc, child.id)`；
  它是公开 API（`UsageDoc` 从包入口导出），会话列表则要 `commit(tx => tx.scanConversations())`
- **按角色累计刻意没做**：会被历史稀释、旧数据缺归属、且不影响控制逻辑。
  做的是**单次派活成本**（`subagent` → `details.spend` → `MessagePart.spend` → 工具行显示）。
  触发条件写在 STATUS §4.44（按角色计费 / 多人按人出账单 / 真出过事故）
- **GitHub 建仓选的 license 会直接变成 `LICENSE` 文件**：它不读 README / 设计文档。本仓出现过
- **"不随开源发布"写成注释 ≠ 不在仓库里**：`docs/REVERSE_ENGINEERING.md` 被 README 与 STATUS
  两处声明"仅内部"，却一直 tracked，公开仓库上直接能打开。判定要看 `git ls-files`。
  已 `git rm --cached` + `.gitignore`（本地保留），**但历史里仍在** —— 彻底清除要重写历史
- **README 与 STATUS 双写必然长出过期句子**：什么"规划中"、"518 个测试"、"某半边是下一步"，
  都是两边各抄一份的后果。读者不同：README 讲"能做什么"，STATUS 讲"怎么做的、坑在哪"
- **`SelectionContext` 没有 `screenshot` 字段**（只有 kind/route/loc/selector/rect/text/styles/
  elements/viewport）—— 曾把"留了没填"当成欠账写在 STATUS，实际是选了结构化描述而非像素
  "README 写 AGPL、LICENSE 却是建仓默认的 MIT"，而后者才有法律效力。MIT 是永久授权、发出去
  收不回来 —— 这次是在 `forks=0` 时换掉的（有时间窗）
- **`postgres:18` 的卷必须挂 `/var/lib/postgresql`**（不是 `.../data`）：18 起 PGDATA 在
  `/var/lib/postgresql/18/docker`。挂错不报"挂载点不对"，而是入口脚本说"数据在 unused mount/volume 里"
  拒绝启动 → db `unhealthy`、`app`（`depends_on: service_healthy`）连启动都没有
- **快照还原不能"按行数组前 N 个值"取值**：快照之后 `drop column` 过的话，保留的列不再是前 N 个 ——
  按位置取会让整行往前错一位。类型相容就是**静默写进错误的列**，类型不容才报
  `malformed array literal`。必须按列名取坐标（`columns.map(n => table.columns.indexOf(n))`）
- **迁移的校验不能是"源行数 == 目标行数"**：目标库有迁移之后新写的数据时（或只是重跑），
  会把一次正确迁移判成失败，还提示"先清空目标表再迁"（= 建议用户删数据）。
  正确判据是「目标(后) == 目标(前) + 实写」，`on conflict` 跳过的行数进报告的 `skipped`
- **colima 虚拟机里没有 DNS**：`/etc/resolv.conf` 是悬空的 systemd-resolved 链接，而 systemd-resolved
  在这个镜像里**没装**。**坏得极隐蔽**：配了 HTTP 代理时 pull 照样成功（域名由代理解析），
  代理一停（WorkBuddy 的代理每会话换端口）才同时报 `proxyconnect ... connection refused` 与
  `could not resolve host`。修要先 `rm` 掉那个链接再建真文件
- **colima 每次 `start` 都重写 `/etc/docker/daemon.json`** → 手工加的 `registry-mirrors` 活不过重启，
  它还会把宿主代理写进去。持久做法挂 `docker.service` 的 `ExecStartPre`（本机 `/usr/local/bin/tenon-vm-fix.sh`）

## 本机环境
Node v22.22.2 / pnpm 9.15.9。**所有命令都要** `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`
（node-language-shim 让 PGlite 慢 10 倍；Electron 被误当 node）。无 `pg_dump`。
**docker 现在可用**：colima（vz）+ 官方二进制，daemon 29.5.2 / compose v5.7 / buildx。
**不要把 `/usr/local/bin` 放到 PATH 前面**（那里有 brew 的 Node 20，会顶掉项目的 Node 22，
症状是 `No such built-in module: node:sqlite`）→ 用 `/usr/local/bin/docker` 绝对路径。
colima 不自启，重启后先 `colima start`。
Electron 需 `--no-sandbox`（否则 ERR_FAILED）；`npx electron` 是断链 → 用 `.pnpm/electron@<ver>/.../MacOS/Electron`。
**本机 bash 的 `grep` 常返回空** → 查文件用 Grep 工具。`docs/PI-CHEATSHEET.md` 写代码前必查。
`docs/reverse/`、`*.har` 仅研究，**clean-room 红线：不得搬代码/文案/提示词**。
**改完前端必须重启 server 再截图**（启动时把 `apps/web/dist` 读进内存）。
