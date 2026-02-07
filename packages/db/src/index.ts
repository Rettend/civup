import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema/index.ts'

export { schema }
export * from './schema/index.ts'

/**
 * Create a Drizzle client from a D1 binding.
 * Use this in Workers: `const db = createDb(env.DB)`
 */
export function createDb(d1: any) {
  return drizzle(d1, { schema })
}

export type Database = ReturnType<typeof createDb>
