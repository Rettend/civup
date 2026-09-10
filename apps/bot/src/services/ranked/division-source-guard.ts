import type { Database } from '@civup/db'
import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

const SOURCE_CHANGED_PATH = 'division-rank-source-changed'

/** An identifiable SQLite error rolls back the batch; unknown failures must not be retried. */
export function divisionSourceGuard(db: Database, condition: SQL) {
  return db.select({ valid: sql<number>`case when ${condition} then 1 else json_extract('{}', ${SOURCE_CHANGED_PATH}) end` }).from(sql`(select 1) as division_guard`)
}

export function isDivisionSourceConflict(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (error.message.includes(SOURCE_CHANGED_PATH) && /json path/i.test(error.message)) return true
    error = error.cause
  }
  return false
}
