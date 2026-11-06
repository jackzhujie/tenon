# 参与贡献

先说清楚这是个什么项目：**本地优先、可自托管的对话式 AI 全栈应用搭建平台**。
它靠 Agent 改一个真实仓库、跑真实预览、发真实版本 —— 所以「改坏了」不是一句提示语的事。
下面的要求都是从这个前提出发的。

## 开工前

```bash
pnpm install
pnpm typecheck      # 18 个 project
pnpm test           # 700 项，约 4 分钟（串行跑，因为端口与文件系统都在用）
pnpm build:web
```

这三步就是 CI 跑的全部（`.github/workflows/ci.yml`）。**PR 必须让它绿。**
`e2e:*` 系列（真 Chromium / 真 Docker / 真 PostgreSQL）不进 CI，按需在本地跑，
改动涉及哪条链路就跑哪条：

| 改了什么 | 跑哪个 |
|---|---|
| 预览、依赖安装 | `pnpm e2e:preview` |
| 库快照 / 回滚 / 迁移 | `pnpm e2e:diff`、`pnpm e2e:postgres` |
| 发布、导出 | `pnpm e2e:release`、`pnpm e2e:export`、`pnpm e2e:docker` |
| 组件、Hub | `pnpm e2e:component`、`pnpm e2e:hub` |
| Agent 角色 / 工具 | `pnpm e2e:e2e` |

## 提交

- **一个提交一件事**。信息用中文，第一行说结论，正文说**为什么**（不是复述改了什么）。
- **必须带 `Signed-off-by`**（DCO，不是 CLA）：

  ```bash
  git commit -s -m "fix(preview): 端口占用时明确报错，而不是白屏"
  ```

  它表示你有权贡献这段代码。不需要签任何文件。

## 两条红线

1. **不要提交逆向所得的东西**。本项目对同类产品做过研究，但那条线是 clean-room：
   可以看行为，**不得搬代码、文案、提示词**。`docs/reverse/`、`*.har` 一律不进仓库
   （`.gitignore` 已覆盖，别绕过它）。
2. **不要提交密钥与个人数据**。`.env`、私钥、真实 API Key、别人的数据库连接串。
   CI 里没有秘密扫描器，靠自觉。

## 代码口味（不是强制的，但会被要求）

- 注释写**为什么**，以及"不这么做会怎样"。这个代码库里密度最高的信息是陷阱，
  不是接口说明（见 `docs/STATUS.md §5`，168 条）。
- 新增行为要有测试。**能被静默破坏的东西优先**：数据迁移、序列、快照、用量、门禁。
- 牵扯到「生成的应用」时记住铁律 2：**生成应用的代码永远不感知运行环境**，只认 `DATABASE_URL`。

## 协议

贡献按本仓库既有协议授权：主体部分 **AGPL-3.0-only**，`runtime-sdk` / 模板 / `plugins`
为 **Apache-2.0**，文档为 **CC BY 4.0**（见 `NOTICE` 与 `README` 的 License 段）。
提交即表示你同意按对应目录的协议发布你的贡献。
