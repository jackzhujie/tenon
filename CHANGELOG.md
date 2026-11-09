# CHANGELOG

> **用户视角的"这一版变了什么"**，一行一条。
>
> 分工（三份文档不许互相抄）：
> - 为什么这么改、踩了什么坑、验证数据 → [`docs/STATUS.md`](docs/STATUS.md) 的 §4 各节
> - 还差什么、接下来做什么 → [`docs/BACKLOG.md`](docs/BACKLOG.md)
> - 能做什么（能力清单）→ [`README.md`](README.md)
>
> 版本号跟 `apps/desktop/package.json` 与 git tag。发布时把 `未发布` 整段挪到对应版本标题下。

## 未发布

### 新增

- **桌面版自动更新**：启动后会检查 GitHub Releases，有新版本时顶栏下出现一条提示，点「下载」→「重启安装」。
  未签名的包 macOS 不允许自动替换，会明确提示改用手动下载（见 STATUS §4.60）
- 新文档 [`docs/BACKLOG.md`](docs/BACKLOG.md)：M1–M6 收口后的第一次系统盘点 —— 三条闭环、P0/P1/P2 与每项验收标准

### 变更

- **对话界面更干净**：助手正文改为满宽、去掉气泡底色，工具卡片只留 1px 边框；正文、工具行、「详情」
  现在共用同一个右边界（此前工具行比气泡宽 61px，一屏来回跳）
