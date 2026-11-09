## 登录与用户体系

> 这一节由 Tenon 维护（加登录时写入），**不要手改**这个标题下的结构说明。

这个应用有账号体系：没登录的人**看不到也调不动任何数据接口**。

```
api/auth/auth.module.ts       模块：注册两张表 + 装上全局守卫（不要从 imports 里删）
api/auth/auth.guard.ts        全局守卫：默认拒绝，只放行 @Public()
api/auth/auth.controller.ts   /api/auth/* 八个接口
api/auth/auth.service.ts      口令校验、会话签发/吊销、增删账号
api/auth/password.ts          scrypt 哈希（node:crypto，无原生依赖）
api/auth/cookie-name.ts       会话 cookie 名（按应用区分，见文件里的注释）
shared/auth-schema.ts         前后端共用的 zod 契约（唯一事实来源）
src/auth/AuthGate.tsx         登录闸门（main.tsx 里已经把 <App/> 包在里面）
src/auth/LoginPage.tsx        登录 / 首次初始化
src/auth/MembersPanel.tsx     管理员加人、改自己的密码
```

**三条不能破的约定：**

1. **新接口默认就是要登录的。** 守卫是全局的（`APP_GUARD`），你加的接口自动受保护。
   要公开必须显式 `@Public()` —— 反过来做（默认放行、逐个加守卫）一定会漏，而漏掉的
   那个接口看起来和旁边的一模一样。

2. **`GET /api/health` 由守卫硬编码放行，不要把它改成要登录。** Tenon 起预览时靠它
   判断后端就绪；它一旦 401，预览会永远"起不来"，而日志里只有一串 401 和超时。
   这条没有走 `@Public()`，因为它是平台契约（网关写死了这条路径），不是应用内约定。

3. **口令只存哈希，永不回显。** `SessionUser` 里没有 `passwordHash` 就是这个原因；
   任何"调试用"的接口把 user 实体整个返回，都是把哈希送进浏览器缓存。

**加一个"只有登录用户能用"的接口**（照这个写就行）：

```ts
import { CurrentUser } from './auth/current-user.decorator'
import type { SessionUser } from '../shared/auth-schema'

@Get('reports')
list(@CurrentUser() user: SessionUser) {
  // 用 user.id 过滤数据 —— 别信前端传来的 userId
  return this.reports.listFor(user.id)
}
```

需要"管理员才能做"的动作，在控制器里加一句 `if (user.role !== 'admin') throw new ForbiddenException()`。
前端藏按钮**不算**权限控制。

**第一次使用**：库里零账号时，打开应用会显示"创建第一个管理员"。在那之前，
任何能访问到这个地址的人都能把自己设成管理员 —— 所以部署完先自己打开一次。
一旦有了账号，`/api/auth/setup` 会自动关闭。

**会话**：httpOnly cookie（名字见 `cookie-name.ts`），7 天有效。退出登录会删掉服务端
那条记录，所以"退了就是退了"，不是靠前端删一个 token。

**导出静态包时没有登录**：静态包是纯前端的，没有后端就没有鉴权。要给人用就导出
Docker（compose 自带 PostgreSQL）。
