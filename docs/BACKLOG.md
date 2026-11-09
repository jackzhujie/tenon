# BACKLOG.md — 还差什么（缺口清单）

> **这份文件回答一个问题：M1–M6 都收口了，为什么还不能直接丢给陌生人用？**
> 唯一事实来源。新增缺口写这里，别散落到 STATUS 的段落里；做完一项就来划掉并标日期。
> 最后盘点：2026-11-09（M1–M6 收口后第一次系统盘点）
>
> 阅读顺序：先看 §0 结论，再按 §1–§3 找自己的活。**每项都写了"证据"**（文件/文档/命令），
> 没有证据的"感觉缺"不算缺口 —— 这条规矩是为了防止把"我没想到"写成"还没做"。

---

## 0. 结论

**功能主干没有缺口。欠的是三条闭环：装得出去、卖得出去、用得长久。**

| 闭环 | 差在哪 | 一句话后果 |
|---|---|---|
| **装得出去** | ✅ 真 Hub 已上线（§2.1）；仍欠签名 / 遥测 / 真远端 push | 组件生态已能更新；但包还没签名，用户装了就停在那一版 |
| **卖得出去** | 商业授权无联系入口；组织级能力全在设计稿；付费无交易只有门禁 | 双许可的变现路径是断的 |
| **用得长久** | ✅ 生成应用的用户体系已补（§1.3）；仍欠存储无清理、跨应用用量无上限 | "给同事用的系统"现在拦得住没登录的人；但会越用越占盘，且没人管得住总花费 |

**优先级判据**：这项不做，会不会让"第一个真实用户"卡住？会 → P0；只影响规模 → P1；只影响体验 → P2。

---

## 1. P0：不做就没有复购

### 1.1 自动更新 —— 🚧 壳侧已落地（2026-11-09），卡在签名

| 项 | 内容 |
|---|---|
| 现状 | ✅ 壳侧做完了：`electron-updater` 6.8.11（锁版本）+ `publish: github` + preload 桥 + 界面横幅 + 10 项单测。见 STATUS §4.60 |
| 后果（已解） | 修好的 bug 不再要求用户自己去下安装包 —— 只要那个包装了签名，检查/下载/重启安装是通的 |
| 仍卡 | **macOS 的 Squirrel.Mac 拒绝未签名更新** —— 与 1.2 是同一笔证书账；Windows NSIS 不需要签名 |
| 还没验的 | 打包版真机走完"检查到新版 → 下载 → 重启换版本"。mac 要等 1.2；Windows 有机器即可单独验 |
| 落点 | `apps/desktop/src/{updater,preload,main}.ts`、`apps/desktop/electron-builder.yml`、`apps/web/src/{hooks/useAppUpdate.ts,features/update/UpdateBanner.tsx}`、`apps/desktop/test/updater.test.ts` |

### 1.2 签名与公证 —— ⏳ 接线已完成（2026-11-09），只等证书

| 项 | 内容 |
|---|---|
| 现状 | CI 与打包配置已经**能签**了：`electron-builder.yml` 不再写死 `identity: null`（那是"强制不签"而不是"找不到就不签"——买完证书的人会得到一个构建全绿、产物仍未签名的结果）；`hardenedRuntime` + entitlements 已配；`desktop.yml` 按 Secrets 是否存在决定签不签、公证不公证，并各有一条验证步骤。**无证书路径已用真 dispatch 验过**（run `42540462130`，四平台全绿、150s） |
| 还差什么 | **钱**：Apple Developer Program $99/年（要 Developer ID Application，**免费的 "Apple Development" 证书不行**，本机那张也已过期）+ Windows 代码签名证书（OV/EV，或用 Azure Trusted Signing，约 $10/月） |
| 怎么接 | 往仓库 Secrets 里放五项，见下表；放完**不用改代码**，下一次打包自动带上签名与公证 |
| DoD | ① mac：`spctl -a -vvv --type execute Tenon.app` 返回 accepted（已公证）；② Windows：`Get-AuthenticodeSignature` 为 `Valid`；③ 自动更新（§1.1）在已签名包上真的换得掉版本 |
| 验证命令 | mac：`codesign --verify --deep --strict --verbose=2 Tenon.app` / `xcrun stapler validate Tenon.app`；Windows：`signtool verify /pa Tenon-*-setup.exe` |

**要配的 Secrets**

| Secret | 是什么 | 怎么来 |
|---|---|---|
| `MAC_CSC_LINK` | `Developer ID Application` 证书的 `.p12`，**base64** | 钥匙串导出 .p12 → `base64 -i cert.p12 \| pbcopy` |
| `MAC_CSC_KEY_PASSWORD` | 导出 .p12 时设的密码 | — |
| `APPLE_ID` | 开发者账号邮箱 | — |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码（不是账号密码） | appleid.apple.com → 登录与安全 |
| `APPLE_TEAM_ID` | 10 位团队 ID | 开发者后台 Membership |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows 代码签名证书 `.pfx` 与口令 | 证书颁发机构 |

> 缺任何一项都不会让构建失败 —— 只是回到"未签名"那条路。这是刻意的：一个没有证书的
> fork 也应该能打出包来试。但**"签了"必须被验证过**，所以每条签名路径后面都有一个验证步骤，
> 没有它，签名只是构建日志里的一句话。

### 1.3 生成的应用需要用户体系 —— ✅ 已落地（2026-11-09）

| 项 | 内容 |
|---|---|
| 现状 | ✅ 「加登录」是一个功能包：`applyAuthFeature`（生成器）+ `add_auth`（Agent 工具）+ `app.addAuth`（RPC）。`auth_users` / `auth_sessions` 两张表、`/api/auth/*` 八个接口、**默认拒绝的全局守卫**、登录页 + 成员浮层。纯前端应用会先自动补后端。见 STATUS §4.62 |
| 已验证 | `pnpm e2e:auth` 真起应用打接口，**30 项全过**：未登录 401、`/api/health` 不被守卫拦（readiness 四格全 ready）、弱口令 400、setup 只成功一次（再调 409）、错密码 403、admin 加人 201、member 调管理员接口 403、退出后老 cookie 立刻 401。另有 5 条单测钉住四处"漏了不报错"的就地改 |
| 视觉验收 | `pnpm shot:auth`：Electron 真渲染，登录页 / 登录后账号栏 / 成员浮层三张截图 |
| 依赖代价 | 生成应用**没有新增任何包**：口令用 `node:crypto` 的 scrypt，会话是库里的不透明令牌（不用 JWT，为了能吊销），cookie 解析手写十几行 |
| 仍需注意 | ① 首次部署后要**先自己打开一次**完成初始化，否则第一个访问的人会成为管理员；② 导出**静态包**没有后端，登录不适用（Docker 导出才有效） |
| 仍欠 | 找回密码（通常做法是"管理员重置"）；要"初始化需要一次性口令"的话是个产品决定，现在只写进了生成的 AGENTS.md |
| DoD | ① ✅ 一句话「加上登录」能装出来；② ✅ 未登录请求一律 401（含业务接口）；③ ✅ 密码只存 scrypt 哈希；④ ✅ Docker 导出后有效，静态包不适用（已在文档与工具输出里说明） |
| 落点 | `packages/generator/src/features.ts`、`packages/generator/templates/auth-feature/**`、`packages/agent/src/tools/auth.ts`、`packages/server/src/handlers.ts`、`packages/protocol/src/rpc.ts`、`scripts/e2e-add-auth.ts`、`scripts/shot-auth.ts` |

---

## 2. P1：决定它是玩具还是生态

### 2.1 真 Hub 上线 —— ✅ 已上线（2026-11-09）

| 项 | 内容 |
|---|---|
| 地址 | **https://download.telepathy-app.com/tenon-hub**（`index.json` + 三个官方组件包，同一层平铺） |
| 现状 | ✅ 公网可达的静态 Hub：TLS 由该域名现有证书提供；nginx `location ^~ /tenon-hub/` 指向 `/www/wwwroot/tenon-hub`；gzip 开着（560KB → 154KB） |
| 客户端 | `apps/desktop/hub.defaults.json` 随仓库带官方地址与公钥（公开信息），`build.mjs` 与 `dev-web.ts` 都读它 → **不设环境变量也是对的**；环境变量仍优先 |
| 发布流程 | ✅ 一条命令：GitHub Actions 手动触发（或推 `hub-v*` tag）→ 打包签名 → `rsync` 上传 → 字节比对 → 线上自检，全在 `.github/workflows/hub.yml`。签名私钥与部署钥匙都在 **`hub-release` 环境**（配了 required reviewer，批准前不进 runner）。上传用的 SSH 钥匙在服务器上被 `rrsync` 锁死成「只能写 hub 目录」——CI 钥匙泄露 ≠ 服务器失守（三条边界实测过）。本地仍可手打 `pack:hub` + `rsync` 应急 |
| 自检 | `pnpm hub:check` 走客户端自己的 `fetchHubIndex`（含验签）+ 逐个 HEAD bundle + 校验 content-type |
| 服务器访问 | ✅ 2026-11-09 起**只允许密钥登录**：本机 `~/.ssh/tenon_kr_ed25519`，`ssh tenon-kr` 直达（`~/.ssh/config` 里配了 `43.166.42.20` 的别名）。`PasswordAuthentication no`、`PermitRootLogin prohibit-password`。改前整目录备份在服务器 `~/sshd-backup-20261109-215228/`，锁死时的兜底是**宝塔面板的网页终端**（HTTPS 登录，不依赖 sshd） |
| 已验证 | ① 公网索引验签通过（3 组件）；② 客户端代码真装了一个包到本机（`installFromHubIndex`）；③ 应用自己的 `hub.check` 能列出 3 个组件；④ 下载站原有页面仍 200 |
| 私钥保管 | ✅ 已做加密异地备份（2026-11-09）：`AES-256-CBC + PBKDF2(300k)`，一份在 `~/tenon-backups/`、一份在 iCloud Drive 的 `tenon-backups/`（密文，Apple 也解不开）。**备份被验证过是能用的**——解开后逐字节一致，且用它签出的索引能被线上公钥验过。口令在 macOS 登录钥匙串（条目 `tenon-hub-key-backup`），**不在仓库、不在备份目录附近**。仍要记住：换密钥等于所有老客户端都装不了新组件（它们认的是这把公钥） |
| 仍欠 | CDN / 多地域（现在只有一台机器，`max-age=300` 一刀切）；第三方上架与审核（M7，属商业版）；回滚只是「重推一版 index.json」，没有版本列表可回切（索引是增量重写的，旧 bundle 还在，但 UI 上没有回退入口） |
| DoD | ① ✅ 公网可达（HTTPS + 签名索引）；② ✅ 全新客户端能装非随包组件（已用客户端代码实测）；③ ✅ 发布是一条命令（Actions 里点一次 + 批准），上传与自检都在里面 |

### 2.2 商业授权入口

| 项 | 内容 |
|---|---|
| 现状 | README 写「需商业授权（双许可）」，但 `mailto` / 邮箱 / 表单 **grep 全空** —— 想付钱的人找不到门 |
| 做法 | README 与 NOTICE 各加一段，写明授权范围、报价方式、联系方式（邮箱或表单） |
| DoD | 陌生人读完 README 能用一句话说清"我要商用该点哪里" |

### 2.3 组织级能力（商业版）

| 项 | 内容 |
|---|---|
| 现状 | DESIGN §16.2 承诺：团队协作 / SSO / RBAC / 审计 / 私有组件市场 / 云同步。代码里都没有 |
| 判断 | **不该进开源主干**（DESIGN §1.3 非目标）。要做就作为商业版分支，先把 2.2 的入口开出来再谈 |
| DoD | 由商业需求驱动，不在这里排期 |

### 2.4 付费组件的交易链路

| 项 | 内容 |
|---|---|
| 现状 | 付费组件在**下载前**就被拒（`remove/shop` 明说"购买流程还没做"）—— 门禁有了，没有收钱 |
| 后果 | 收费组件一份也卖不出去；第三方也没有上架动机（M7 后置） |
| DoD | 至少一条真实交易路径（哪怕只是 License Key 兑换），且 key 与 `(appId, componentId)` 绑定 |

---

## 3. P2：用得久才暴露的问题

| # | 缺口 | 证据 | 量级 | DoD |
|---|---|---|---|---|
| 3.1 | **全局用量无上限** | 只有 `budget.app.<appId>`（`packages/agent/src/chat.ts` 的 `BUDGET_EXCEEDED`）；跨应用只有汇总（§4.41）。欠账④：看得见 ≠ 拦得住 | S | 一条"这个月最多 $N"的总闸，超了所有应用都发不出去 |
| 3.2 | 成本无法按角色/按人归属 | 欠账⑤：`harness.usage()` 只给按模型/工具聚合，子会话的账在它自己的桶里 | M | 用量面板能回答"Explore 这个子角色花了多少" |
| 3.3 | **存储无清理** | §4.7「快照会累积，暂未做清理策略」；§4.8「单个应用内的历史没做清理」 | S–M | ① 快照保留策略（N 份/按天）；② 备份裸库 `gc`；③ 设置里显示 `~/.tenon` 占用并可清理 |
| 3.4 | 崩溃 / 错误遥测 | 无 sentry / posthog；只有本地日志面板 | M | 可选开启的匿名崩溃上报（默认关，附开关与说明） |
| 3.5 | i18n | 界面文案硬编码中文（`apps/web/src` 无 i18n 层）；DESIGN M6 列过 | M | 至少 en 一份，文案走同一张表 |
| 3.6 | 文档站 | DESIGN M6 列过；现在只有 `docs/*.md` | M | 静态站可直接从 md 生成，链回仓库 |
| 3.7 | e2e 不在 CI | `ci.yml` 注释：GUI / 容器跑不了，靠手动；832 项单测兜不住预览链路 | M | 至少一条"能跑 e2e 的 CI 车道"（self-hosted runner 或 xvfb + docker） |
| 3.8 | Agent 命令无沙箱 | `SECURITY.md` 自己列为"当前最大信任边界" | L | 分阶段：先做可审计（命令白名单/确认弹窗），再谈隔离 |
| 3.9 | 真远端 push | 欠账③：只推本地裸库；GitHub 要凭据 + 真网络 | S | 配好凭据后能推真远端，失败信息能指路 |
| 3.10 | Linux 桌面端 | README：M7 后置；CI 出 AppImage 但无 GUI 验证 | M | 真机启动 + 冒烟；或明确宣布不做 |
| 3.11 | DCO 未强制 | 欠账：靠 `git commit -s` 自觉 | XS | CI 里加一条 `Signed-off-by` 检查 |
| 3.12 | 第三方组件上架与审核 | DESIGN §17：M7 后置 | L | 不排期 |

---

## 4. 明确不做（别再讨论）

DESIGN §1.3 已定：多租户 SaaS 托管、企业 SSO、跨组织协作、移动端原生 App、可视化拖拽画布、妙搭协议兼容。
M7 的「团队协作 / 托管 / 第三方审核」同理 —— **要变现就放商业版，不进开源主干。**

---

## 5. 文档自身的漂移（比缺功能更伤新人）

入口文档自己不自洽，会让人不敢信任何一页。已知：

| 漂移 | 现状 |
|---|---|
| `STATUS.md` §4.2 表格里 M5 第 8 步仍是 🚧 | 实际 §4.26 已 ✅ 收口 |
| 测试数漂移 | 实际是 **832**（2026-11-09 实测，含加登录的 5 项）。STATUS §0 的「700 个」与 §4.47 的「809 项」是**当时的快照**，别当当前值读。以后改数先跑一遍 `pnpm test` |
| 「还差什么」散落 4 处 | README 一段、STATUS §7 欠账、各步骤末尾的"还没做的"、这份 BACKLOG —— **以这份为准**，其余只留链接 |
