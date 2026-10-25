# PROTOCOL.md — 妙搭行为规格 v0.1（clean-room）

> 逆向产出：仅记录协议形状与交互范式，供开源复刻参考。不含字节实现代码/文案/资源。
> 证据来源：`docs/reverse/builder-dump`（生成应用运行时）、`docs/reverse/ide-dump`（Builder 前端）、`docs/reverse/api-surface.md`（364 RPC）。

## 1. 系统架构（实测还原）

```
┌─ Builder SPA（miaoda.feishu.cn，webpack 分包）────────────────────┐
│  对话流 / 计划面板 / 终端面板 / 自动化面板×7 / 插件面板×5 / 代码面板 │
│  应用头 / 预览面板 / native-host-bridge                            │
└──────────┬───────────────────────────────────────────────────────┘
           │ 嵌入 iframe
┌─ Per-App 沙箱（<hash>-<app_id>-<sandbox_id>.aiforce.run）─────────┐
│  ① code-server WebIDE（feishucdn apaas/ai/ide 1.0.0.112，         │
│     VS Code workbench 魔改，经 /af/webide/<tenant>/<sid>/code-     │
│     server/webapi/v1/* 访问，WS token 鉴权）                       │
│  ② Vite dev server（Rolldown 打包，服务生成应用源码）              │
│     - HMR WebSocket 携带 JWT（tenant_id/app_id/sandbox_id）        │
│     - 生成应用资源路径 /app/<app_id>/node_modules/.vite/deps/*     │
└──────────────────────────────────────────────────────────────────┘
           │ 长连接
┌─ Frontier WS 网关（/ws/v2，QoS 参数）─────────────────────────────┐
│  ticket 流程：POST /af/api/v1/devops(_platform)/ws/ticket          │
│   {socketID} → {ticket, aid, fpid, accessKey, wssURL}             │
│  沙箱网关：GET /af/api/v1/sandbox_gateway/get_ws_token → token     │
└──────────────────────────────────────────────────────────────────┘
```

## 2. 生成应用技术栈（实测，全部开源件）

| 层 | 组件 |
|---|---|
| 构建 | **Vite + Rolldown**（Rust 打包器），HMR over WS（JWT 鉴权） |
| 框架 | React 19 + **React Router 7**（manifest 路由发现 + sessionStorage 版本缓存） |
| 样式 | Tailwind CSS |
| UI | shadcn/ui 体系：radix-ui + class-variance-authority + clsx + tailwind-merge；lucide-react 图标 |
| 数据校验 | zod |
| 反馈 | sonner（toast）、react-error-boundary、next-themes |
| SDK | **@lark-apaas/client-toolkit**（AppContainer/ErrorRender/NotFoundRender 组件 + runtime + logger） |
| 时间 | dayjs（registerDayjsPlugins） |
| 监控 | Slardar（bid=apaas_miaoda）、Tea collect、performance SDK（字节内部件，复刻时剔除） |
| 风格预设 | 8 种设计风格 + Ant Design / shadcn/ui 两种组件库风格 |

**关键结论**：生成应用没有任何自研闭源依赖（除 client-toolkit SDK），我们可 100% 用开源等价物复刻，SDK 对应我们的 `@app/client`。

## 3. 生成应用运行态 API

- 路由清单：`GET {basePath}/routes.json` → `[{"path":"/"},{"path":"/menu-manage"},...]`（极简数组）
- 发布态检查：`GET /app/<id>/__runtime__/api/v1/studio/get_published`（旧版 `/spark/b/<id>/get_published`）
- 用户信息：`GET /app/<id>/__runtime__/api/v1/account/login/user`（含 tenantDomainName）
- 登出：`POST /af/runtime/api/v1/account/logout`
- 权限点：`GET /app/<id>/api/sdk_innerapi/permission/user-points`（前端用 **CASL** ability 模型消费）
- 服务端日志流（开发态）：`/dev/logs/server-logs/stream`（SSE）
- 预览 CSRF：`GET /ai/api/feida_preview/csrf`；Cookie `suda-csrf-token` + Header `X-Suda-Csrf-Token`
- 注入的全局：`window.appId / tenantId / userId / csrfToken / __MIAODA_HMR_WS_TOKEN__`
- 全栈标记：`window.__FULLSTACK_RUNTIME_INITIALIZED__`（生成应用是全栈结构，含 client/src/app.tsx 路由表与 server 端）

## 4. Builder API Surface（364 RPC / 25 Service，全量见 api-surface.md）

| Service | 数 | 职责 | 复刻优先级 |
|---|---|---|---|
| StudioService | 175 | 对话/规格/子任务/检查点/发布/复制 | ★★★ 核心 |
| AilyCanvasService | 102 | AI Canvas（Feida 前缀迁移自 aily） | ★★ |
| ForcePermissionService | 12 | 企业权限 | ★ |
| TriggerModelService/Webhook/RecordChange/TriggerDebug/TriggerLog | 20 | 自动化触发器全家桶 | ★★ |
| DataTableService / DataloomService / VectorMetaService | 12 | 数据表 + **向量元数据（RAG）** | ★★★ |
| GitService / FunctionService | 4 | 沙箱内 git 合并/冲突、容器配置 | ★★（版本=Git） |
| SandboxService / EntitlementRuntime | 3 | 沙箱控制、配额 | ★ |

## 5. 对话/编排协议（复刻核心）

### 5.1 请求层（客户端实测）
- **AsyncChat**：`POST /api/v1/studio/async/conversation/chat`
  req `conversation.AsyncChatRequest`：`conversationID, userMessage, options, immediateExecute, idempotentKey, requestSource, bizType`
  客户端实际构造：`{idempotentKey, immediateExecute, conversationID, userMessage:{content, parts, attachments, attachmentIDs, quoteAttachmentIDs}, options:{model, overrides}}`
- **流式端点**：`POST /af/api/v1/studio/stream/conversation/chat`（`streamChatUrl`，SSE）+ `POST /api/v1/studio/stop`（StopChat，body `conversationID, replyGroupID, agentID, bizType`）
- **流状态查询**：`GET /api/v1/studio/:appID/conversation/:conversationID/streaming_status`（GetStreamingStatus）
- **幂等**：`idempotentKey`（来自 `userMessage.parts[]` 里带 idempotentKey 的 part）
- **暂存队列**（消息队列式对话的机制）：`sendMessageCacheList` **上限 10 条**，生成中发的新消息入队；`immediateExecute=true` 可插队立即执行；超出上限 Toast 提示不再入队
- **传输层**：Frontier WS SDK（`version_code: fws_1.0.0`）用于服务端推送，`/ws/v2?device_platform=web&access_key&fpid&aid&device_id&xsack&xaack&xsqos&qos_level&qos_sdk_version=2`，多端点重试 + QoS + ACK

### 5.2 消息与工具调用结构（Agent 协议骨架）
- 消息对象：`{replyGroupID, content, parts[], attachments[], tools[]}`
- 工具调用：`tools[] = {name, output, status, toolCallId}`，`status` 取 `in_progress|completed`
  - `app_init` 工具：output 含 Spec 内容 → 客户端 `parseAppInitContent()` 转成 Spec 对象
  - Spec 更新类工具：output 含 `specID / path / content`，写入 `spec.files[]`（`{name, path, content, status, draftContent, isSaved}`）
- **Spec 文件体系**（沙箱内 / 协议层均以此组织）：
  - `init_spec.json`（应用初始化规格，JSON）
  - `task_implement.json`（任务实施清单，JSON）
  - `spec.md` / `spec_doc.md`（人类可读规格）
- **CoT 分组**：流内含 `cotGroup`（思维链分组），客户端统计 `cotGroupCount` 用于渲染「思考过程」
- **规格（Spec）**：`GET /api/v1/studio/:appID/conversation/:cid/spec`（GetSpecByConversation）、`POST .../spec_meta`（UpsertSpecMeta）——应用 DSL 与会话绑定
- **子任务**：`pro_sub_task` CRUD（CreateProSubTask/List/Get/Update/Delete）——「开发计划-任务清单」的落库形式
- **检查点**：`POST /api/v1/studio/:appID/checkpoint/list_by_convs`（版本快照与回滚）
- **产物版本 / 回滚**（客户端 `resetArtifactVersion` 实测字段）：
  - 必填：`appID` + `sandboxID`（缺则抛错「sandbox not bound」）
  - Checkpoint 回滚：`{artifactType:"checkpoint", checkPointID}`
  - Artifact 版本回滚：`{artifactID, version, artifactName?}`
  - Git 提交回退：`{commitID, revertTargetEndTime?}`
  - 数据回滚开关：`dbRestore`（连同数据库一起回退）
- **在线状态**：`POST /af/api/v1/studio/app/:appID/presence/heartbeat|leave`

### 5.2b 多 Agent 编排配置（★ 复刻的黄金参考，实测 `GET /af/api/v1/studio/multi_agent/default_config?app_type=6`）

共 **6 个内置 Agent**，每个含 `agent_key / name / description / model_tier_key / scheduling_mode / enabled / visible / configurable`：

| key | 名称 | 职责（官方描述） | 模型档位 |
|---|---|---|---|
| `miaoda` | 妙搭助手 | **核心调度者**：理解需求、拆解任务、协调各助手协同完成开发 | comprehensive |
| `Explore` | 代码检索 | 深入探索应用代码与关联服务，查询数据库结构、权限配置、日志记录 | fast |
| `CodeAct` | 脚本帮手 | 编写并运行临时脚本，完成导入、转换、整理与一次性探查任务 | comprehensive |
| `Librarian` | 调研助手 | 提前厘清规则、资料与约束条件，减少试错，降低返工成本 | fast |
| `E2E` | 验收测试 | 用浏览器替你实际操作应用，验收功能是否正常、排查页面问题 | comprehensive |
| `Reviewer` | 问题审查 | 深度审查代码的设计、性能与安全风险，定位根因并给出改进建议 | thinking |

**关键机制**：
- **模型分档路由**：`fast / comprehensive / thinking` 三档——同一 Agent 按档位选不同能力模型（复刻时映射到我们的 BYOK 模型档位配置）
- `scheduling_mode: auto`（自动调度，主 Agent 决定何时唤起子 Agent）
- `enabled / visible / configurable` 三态开关：部分 Agent 对用户隐藏（`miaoda`、`Explore` 为 visible=false）、是否允许用户配置
- **复刻映射**：我们的 `orchestrator` crate 直接按此 6 角色建模（调度 + 检索 + 脚本 + 调研 + E2E 验收 + 审查），这是经过产品验证的最小完备 Agent 集

### 5.2c 模型与风格配置

- `GET /af/api/v1/studio/chat/model/list?bizType=miaoda` → 9 个模型：`auto`(智能选择)、`doubao-seed-2.1-turbo`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`deepseek-v4-flash`、`glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx`、`qwen-3.8-max`
  → 印证我们的 **BYOK 多提供商 + "智能选择"默认档**设计正确
- `GET /af/api/v1/studio/design_style/templates?scene=application_default` → 设计风格预设（每个含多张预览图 + cover_url）
  → 对应我们「风格预设」功能
- `GET /af/api/v1/studio/market/resources?resource_types=plugin|skill` → 插件/技能市场（OpenClaw 生态）
- `GET /af/api/v1/studio/entitlements` → 配额/订阅（购买链接指向 feishu.cn/member/subscription）

### 5.3 Copilot 服务层 API 清单（客户端封装，复刻时对应 `orchestrator` crate）
`FeidaListMessage / FeidaCreateConversation / FeidaListConversation / FeidaUpdateConversation / FeidaUpdateMessage / FeidaStopChat / FeidaGetAppArtifact / FeidaUpsertSpecMeta` + `GetSpecByConversation` + `GetWorkspaceFile` + `streamChatUrl` + `resetArtifactVersion`

## 6. 发布协议

- `POST /api/feida/v1/app/:app_id/publish`（PublishApp）
- `GET /api/feida/v1/app/:app_id/get_published` / `get_last_success_published`
- `POST .../update_published`；运行态另有 `feida_runtime/v1` 免费入口变体
- 发布说明 AI 生成（release notes generation）；自定义域名绑定（k_devops_platform_ec 错误码族）
- **复刻映射**：发布 API 族 → 我们的「导出自托管单二进制」；飞书域名 → 用户自己的域名

## 7. 自动化引擎（Trigger*Services）

触发器类型：**Webhook 监听、定时任务（CompSchedTask）、记录变更监听（RecordChangeListen）、飞书审批（FeishuApproval）**；支持启用/禁用/删除/调试（stream_debug SSE 端点）。
**复刻映射**：本地调度器 + Webhook 接收端点进导出二进制。

## 8. 数据层

DataTableService / DataloomService（表 CRUD）+ **VectorMetaService（向量元数据——AI 应用 RAG 支撑）** + Bitable 互通（plugin_components 下读写多维表格）。
**复刻映射**：SQLite 表 + sqlite-vec/FTS5 做向量/全文；多维表格互通做成可选插件。

## 9. 沙箱基建（HAR 实测，复刻的关键参考）

- **底层**：火山引擎 **VEFaaS**（`sandboxType:"vefaas"`），沙箱实例 ID 形如 `vefaas-1soj617x-bai6zcoodv-…-sandbox`，代码目录 `/home/gem/workspace/code`
- **绑定 API**：`GET /af/api/v1/studio/app/:appID/instance/get_or_bind?sandboxID=xxx`
  响应：`{sandboxInstanceID, previewURL, isFrozen, sandboxID, bizStatus:{fileOperate|preview|dependencyRestore|devServer: {status:"ready"}}, codeDir}`
  → 复刻映射：我们本地用一个进程 + 目录替代，但**「实例绑定 + 就绪状态分维度上报」**这一套值得照搬（预览/依赖/devServer 分别 ready 才可用）
- **统一响应信封**：`{data: …, status_code: "0"}`（全站一致，含错误码在 status_code）
- **预览域名**：每应用独立子域 `https://{region}-{appID}-{sandboxID}.aiforce.run/app/{appID}`，短时效 JWT `sso_token` 直通（exp ≈ iat + 300s）
- **WS 端点**（实测两条）：
  - `wss://ws.aiforce.run/app/{appID}/ws?token=…&sandbox_token=…`（`Sec-WebSocket-Protocol: vite-hmr`）→ **Vite HMR 中继**
  - `wss://ws.aiforce.run/af/webide/{tenantID}/{sandboxID}/code-server/stable-{commit}?connectionType=…` → **VS Code WebIDE 通道**（Agent 改代码/跑命令走这里）
- **运行时 RBAC**：`POST .../__runtime__/api/v1/permissions/roles` → `{data:{roleList:["admin"]}}`；生成代码里统一 `403 → "无操作权限，请联系管理员分配角色"`
- **生成应用数据 API**：标准自动 CRUD，`GET /api/dishes` → `{items:[{id:uuid, name, price:"28.00", category, status, createdAt, updatedAt}]}`（金额用字符串、时间 ISO）
- **dev 日志**：`GET .../dev/logs/server-logs/stream`（SSE）+ `POST .../dev/logs/collect-batch`
- **routes.json**：`[{path:"/"},{path:"/my-orders"},…]` 极简路由清单

## 9b. 环境与基建细节

- 环境矩阵：boe（测试）/ ppe（预发）/ prod；header `x-use-boe|ppe` + `x-tt-env`
- 域名族：accounts.* / aily.* / apaas.feishuapp.cn / internal-api-lark-api.{region}.cn
- 容器配置项（FunctionService）：cpuMilli/memoryMB/fixedIP/minInstance/maxInstance/maxConcurrency
- 产品内部代号：**Spark**（i18n key 前缀）、多 Agent 平台 **OpenClaw**（miaoda-openclaw-agent*）、aily feisuda 迁移痕迹

## 10. 复刻决策影响（对 ARCHITECTURE.md 的修订输入）

1. `protocol` crate 需定义 **Spec/conversation/subtask/checkpoint** 四元数据模型（妙搭已验证此抽象足够支撑对话式全栈生成）
2. 版本管理直接 **Git 化**（妙搭沙箱内就是 git + artifact version），我们用 libgit2 而非自研快照
3. 生成应用 dev 态走 **Vite dev server**（我们桌面端可内嵌 vite dev / 或直接 Tauri 静态服务 + HMR 自研）
4. `@app/client` 需提供：AppContainer/ErrorRender/NotFoundRender、CASL 风格权限、CSRF、多后端同构数据访问（已与 ARCHITECTURE.md §4 一致）
5. 自动化触发器纳入 M3+（妙搭是独立面板体系，量大）
6. routes.json 极简形状直接沿用

## 11. 采集状态与待补

### 已完成（本阶段证据）
| 数据 | 来源 | 状态 |
|---|---|---|
| 364 RPC / 25 Service API surface | IDE chunks 静态提取 | ✅ |
| 沙箱绑定/预览/日志/数据 API/路由 | HAR（50MB，页面加载流量） | ✅ |
| 对话请求层 + 暂存队列 + 工具调用结构 | IDE chunks（0122/0129/0142） | ✅ |
| Spec 文件体系（4 个文件） | IDE chunks 常量提取 | ✅ |
| 回滚协议字段 | IDE chunks（resetArtifactVersion） | ✅ |
| Frontier WS SDK 参数 | IDE chunk 0051 | ✅ |
| code-server / Vite HMR WS 端点 | HAR + nettap | ✅ |
| **多 Agent 花名册（6 个 Agent + 三档模型路由）** | nettap v2（`/af/api/v1/studio/multi_agent/default_config`） | ✅ |
| 模型列表 / 设计风格 / 插件市场 / 配额 | nettap v2（home 页 XHR） | ✅ |

### 仍待补（需用户额度恢复后重采，**已有工具链就绪，10 分钟可完成**）
- [ ] SSE 流的**逐事件**字段形状（`stream/conversation/chat` 每个 event 的 data 结构）——拦截器 v2 已布防（含 XHR 流式 + WS 二进制 base64），额度恢复后重走一次操作流即可收割
- [ ] 发布 REST 调用的实际请求/响应体（`PublishApp` 时序）
- [ ] code-server WS **二进制帧**内容（Agent 如何写文件/跑命令——对 appgen 设计价值极高）
- [ ] 回滚的 UI 入口位置（用户未找到；协议层已明确，仅需确认入口）
- [ ] OpenClaw agent 协议细节

### 采集工具链（已就绪，可复用）
- `/tmp/nettap2.js`：页面内网络拦截器（fetch + SSE tee + XHR 流式 + WS 二进制 base64）
- `/tmp/cdp-hold-persist.mjs`：持久化注入（托管后台任务运行，刷新自动布防）
- `/tmp/cdp-await-eval.mjs` + `/tmp/rea-full.mjs`：CDP 求值 / rea stdio 直连（MCP 管道断时的兜底）
