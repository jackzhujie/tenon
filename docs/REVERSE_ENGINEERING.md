# REVERSE_ENGINEERING.md — 妙搭逆向工作手册

> 工具：rea MCP（逆向分析工具链）  
> 环境状态：✅ 调试 Chrome 已启动（CDP `http://127.0.0.1:9222`，独立 profile `/tmp/miaoda-rea-profile`）

## 1. 采集路线

| 路线          | 工具                                             | 输入                  | 产出                                               |
| ----------- | ---------------------------------------------- | ------------------- | ------------------------------------------------ |
| A. CDP 静态分析 | `analyze_web_bundle` → `inspect_analysis_view` | 调试 Chrome 中已加载的妙搭页面 | chunk 依赖图、路由、API 端点候选、vendor 指纹、source map（如有）   |
| B. 网络抓包     | `inspect_web_network_capture`（HAR）             | 全流程操作录制的 HAR        | API surface（method/origin/路径模板）、SSE/WS 消息形状、发布协议 |
| C.（后置可选）    | `analyze_javascript_application`               | 飞书桌面端 asar          | 妙搭在客户端内的集成方式（价值有限）                               |

## 2. HAR 采集清单（用户操作）

在调试 Chrome 的 DevTools → Network → ☑️ Preserve log，录制以下完整流程后 **Export HAR**：

1. **登录**（扫码/账号）
2. **创建应用**：输入需求（建议用典型场景，如「团队点餐系统，含菜单管理、下单、订单记录」），选「完整应用」模式
3. **概要设计确认**：等待并确认生成的概要设计
4. **开发计划**：等待开发计划（需求分析/技术方案/任务清单）生成
5. **生成过程**：等待应用生成完成（期间产生最多的 Agent 编排流量）
   1. **对话修改**：提 1-2 条修改需求（如「把首页配色改成绿色」）
6. **选中精调**：选中页面某元素后对话修改一次
7. **预览**：打开运行态预览，做一次数据写入操作（如提交一条记录）
8. **发布**：执行发布流程
   1. **回滚**：版本历史里回滚一次

导出为 `~/project/miaoda/docs/reverse/session.har`（文件名任意，路径告知助手即可）。

## 3. rea 执行序（助手操作）

1. `list_browser_targets` 确认妙搭搭建器页面 target
2. `analyze_web_bundle`（cdp_endpoint=127.0.0.1:9222，target_id=搭建器页面，include_script_sources=true, fetch_source_maps=true, include_json_body_shapes=true, include_websocket_shapes=true）
3. `inspect_analysis_view` 分页查看 modules / references / api-surface
4. HAR 就绪后：`inspect_web_network_capture`（format=har, detail=summary）→ `inspect_analysis_view` kind=capture / api-surface
5. Evidence 通过 `get_evidence_bundle` 沉淀，行为规格写入 `docs/PROTOCOL.md`

## 4. 分析目标（要回答的问题）

- [ ] Agent 编排协议：消息格式、流式通道（SSE/WS/长轮询）、阶段切换信号
- [ ] 开发计划结构：需求分析/技术方案/任务清单的字段形状
- [ ] 搭建块 DSL：页面/组件/数据表/AI 能力的 schema 表示
- [ ] 数据 API：生成应用运行态的 CRUD 协议
- [ ] 发布协议：发布范围、版本管理、回滚的接口形状
- [ ] 前端栈指纹：React 版本、路由、状态管理、UI 库、构建工具
- [ ] 交互范式：消息队列、选中上下文、主题面板的 UI 信息架构

## 5. 合规红线（开源项目）

- **可以**：参考协议形状、交互范式、信息架构、功能清单，写成我们自己的规格
- **不可以**：复制字节的前端代码、组件实现、文案、图标、提示词原文、API 原样兼容（仅借鉴形状）
- 所有 rea Evidence 仅作为内部研究记录，不进入开源仓库；开源仓库只含 clean-room 重写的规格与实现
- 产品命名与描述规避「妙搭/飞书」商标
