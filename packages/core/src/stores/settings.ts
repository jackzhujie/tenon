import type { TenonDatabase } from '../db.js'

interface SettingRow {
  key: string
  value_json: string
}

/** 键值设置。值统一 JSON 编码，读坏一条不能炸整个 settings.get。 */
export class SettingsStore {
  constructor(private readonly db: TenonDatabase) {}

  all(): Record<string, unknown> {
    const rows = this.db.all<SettingRow>('SELECT key, value_json FROM settings')
    const values: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        values[row.key] = JSON.parse(row.value_json)
      } catch {
        values[row.key] = null
      }
    }
    return values
  }

  get<T>(key: string): T | undefined {
    const row = this.db.get<SettingRow>('SELECT value_json FROM settings WHERE key = ?', key)
    if (row === undefined) return undefined
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return undefined
    }
  }

  set(values: Record<string, unknown>): Record<string, unknown> {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        this.db.run(
          `INSERT INTO settings (key, value_json) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
          key,
          JSON.stringify(value),
        )
      }
    })
    return this.all()
  }
}
