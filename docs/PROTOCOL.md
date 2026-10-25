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

- **AsyncChat**：`POST /api/v1/studio/async/conversation/chat`
  req `conversation.AsyncChatRequest`：`conversationID, userMessage, options, immediateExecute, idempotentKey, requestSource, bizType`
- **流式端点**：`POST /af/api/v1/studio/stream/conversation/chat`（SSE 流）+ `POST /api/v1/studio/stop`（StopChat）
- **幂等**：`idempotentKey` 字段（消息队列串行处理的外部保证）
- **规格（Spec）**：`GET /api/v1/studio/:appID/conversation/:cid/spec`（GetSpecByConversation）、`POST .../spec_meta`（UpsertSpecMeta）——应用 DSL 与会话绑定
- **子任务**：`pro_sub_task` CRUD（CreateProSubTask/List/Get/Update/Delete）——「开发计划-任务清单」的落库形式
- **检查点**：`POST /api/v1/studio/:appID/checkpoint/list_by_convs`（版本快照与回滚）
- **产物版本**：`POST /api/v1/studio/artifacts/:artifact_id/reset_version`（回滚）；artifacts 按 conversation 关联（ListConversationArtifacts）
- **在线状态**：`POST /af/api/v1/studio/app/:appID/presence/heartbeat|leave`

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

## 9. 环境与基建细节

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

## 11. 待补（依赖 HAR 采集）

- [ ] SSE 事件流的具体事件类型/字段形状（stream/conversation/chat 的 chunk 格式）
- [ ] Frontier WS 消息帧格式（QoS、ack）
- [ ] 发布/回滚完整时序
- [ ] OpenClaw agent 协议
