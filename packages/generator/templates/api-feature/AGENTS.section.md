## 后端（NestJS + PostgreSQL）

> 这一节由 Tenon 维护（加后端时写入），**不要手改**这个标题下的结构说明。

这个应用有后端：`package.json` 的 `tenon.api` 指向 `api/main.ts`。Tenon 起预览时会
同时起前端（Vite）和后端（Nest），网关把 `/` 给前端、`/api/*` 给后端。

```
api/main.ts              入口（监听 PORT，全局前缀 api）
api/db.ts                数据源：只认 DATABASE_URL；实体清单在这里登记
api/app.module.ts        根模块：注册实体 / 控制器 / 服务
api/health.controller.ts GET /api/health（预览就绪判定打这条）
api/migrations/          迁移，文件名带时间戳，启动时自动执行
shared/schema.ts         前后端共用的 zod 契约（唯一事实来源）
src/api.ts               前端调用出口，一律相对路径 /api/...
```

三条不能破的约定：

1. **只认一个 `DATABASE_URL`。** 不要写 `if (process.env.NODE_ENV === ...)`，不要判断
   "本地还是容器"。本地预览指向 PGlite，导出到 Docker 指向 compose 里的 postgres ——
   应用代码应当零改动。
2. **`DATABASE_POOL_MAX` 是容量参数，不是环境标记。** PGlite 只有一个 backend 会话，
   平台会设成 1；`pool.max > 1` 会让并发事务互相回滚（静默丢数据，不是性能问题）。
3. **迁移是 schema 的唯一来源。** `synchronize` 永远是 `false`；改表就加一个迁移文件，
   不要手改数据库。

加一张表的顺序：写 entity → 在 `db.ts` 的 `entities` 与 `app.module.ts` 的
`TypeOrmModule.forFeature([...])` 里登记 → 写迁移 → 重启后端（迁移自动跑）。
