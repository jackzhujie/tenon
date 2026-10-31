# {{appName}}

Tenon 生成的**全栈**应用：前端 React 19 + Vite 7，后端 NestJS 11 + TypeORM + PostgreSQL。

## 目录

```
index.html            前端入口
src/                  React 应用（改界面在这里）
shared/schema.ts      前后端共用的 zod 契约（唯一事实来源）
api/main.ts           后端入口（package.json 的 tenon.api 指向它）
api/db.ts             数据源：只认 DATABASE_URL
api/items/            一个完整的 CRUD 例子（entity / service / controller）
api/migrations/       迁移，文件名带时间戳，启动时自动执行
```

## 三条不能破的约定

1. **只认一个 `DATABASE_URL`。** 不要写 `if (process.env.NODE_ENV === ...)`、
   不要判断"本地还是容器"。本地预览时它指向 PGlite（WASM 版 PostgreSQL），
   导出到 Docker 时指向 compose 里的 `postgres` —— 代码应当零改动。
2. **`DATABASE_POOL_MAX` 是容量参数，不是环境标记。** PGlite 只有一个 backend 会话，
   平台会把它设成 1；`pool.max > 1` 会让并发事务互相回滚（静默丢数据，不是性能问题）。
   真 PG 上它就是普通的连接池上限。
3. **迁移是 schema 的唯一来源。** `synchronize` 永远是 `false`；改表就加一个迁移文件，
   不要手改数据库。同一份迁移必须能在 PGlite 与真 PG 上都跑通 —— 只用标准 PG 语法。

## 本地怎么跑

Tenon 起预览时会自动装依赖、起数据库、起两个进程（Vite + Nest），并用网关把
`/` 给 Vite、`/api/*` 给 Nest，所以前端永远用相对路径 `/api/xxx`。

想脱离 Tenon 自己跑：

```bash
pnpm install
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/app pnpm dev:api   # 后端 :3001
TENON_API_PORT=3001 pnpm dev:web                                    # 前端 :5173
```

后端用 `ts-node` 而不是 tsx/esbuild：Nest 的依赖注入依赖 `emitDecoratorMetadata`，
esbuild 不产出装饰器元数据，用 tsx 会在启动时报 `Cannot resolve dependency at index [0]`。

## 加一张表

1. 写 `api/items/xxx.entity.ts`（`@Entity`）
2. 在 `api/app.module.ts` 的 `TypeOrmModule.forFeature([...])` 里登记
3. 在 `api/migrations/<时间戳>-Xxx.ts` 里写 `up` / `down`
4. 重启后端 —— 迁移会自动跑

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（回显库版本、迁移数、真实连接池上限）|
| GET | `/api/items` | 列表 |
| POST | `/api/items` | 新建 `{ title }` |
| PATCH | `/api/items/:id` | 改 `{ done }` |
| DELETE | `/api/items/:id` | 删除 |
