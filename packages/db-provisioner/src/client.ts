/**
 * 给脚本 / 端到端用的最小连接助手。
 *
 * 存在的理由很实际：`pg` 是**本包**的依赖，pnpm 的严格布局下根目录的脚本看不到它
 * （`import { Client } from 'pg'` 在 `scripts/` 里会报 TS2307）。与其在根上加一份
 * 可能漂移的副本，不如把驱动留在本包内，外面只看到一个函数。
 */
import { Client } from 'pg'

export type PgClient = Client

/** 连上 → 执行 → 无论成败都断开 */
export async function withPostgres<T>(
  connectionString: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}

/** 探活：连得上就回版本号。连不上直接抛，让调用方决定重试还是失败 */
export async function probePostgres(
  connectionString: string,
  timeoutMs = 5_000,
): Promise<{ version: string }> {
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs })
  try {
    await client.connect()
    const result = await client.query<{ version: string }>('select version() as version')
    return { version: result.rows[0]?.version ?? '' }
  } finally {
    await client.end().catch(() => undefined)
  }
}
