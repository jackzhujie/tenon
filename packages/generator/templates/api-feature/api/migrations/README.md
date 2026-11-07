# 迁移放这里

文件名：`<毫秒时间戳>-<名字>.ts`，时间戳决定执行顺序（例如 `1767225600000-InitItems.ts`）。

- 启动后端时**自动执行**（`db.ts` 里 `migrationsRun: true`），不需要手工命令
- 同一份迁移必须能在 PGlite（WASM 版 PG）与真 PostgreSQL 上都跑通 —— 只用标准 PG 语法，
  不要 `integer` 自增、`datetime`、无时区时间戳这类 SQLite 写法
- `down()` 要真的能撤销：回滚靠它，写个 `-- 不撤销` 的注释等于没有回滚
