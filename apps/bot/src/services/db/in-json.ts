import type { AnyColumn } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

/** Keep variable-length selections within D1's per-statement binding limit. */
export function inJson(column: AnyColumn, values: readonly (string | number)[]) {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`
}
