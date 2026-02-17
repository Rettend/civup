import type { Database as CivupDatabase } from '@civup/db'
import { schema } from '@civup/db'
import { Database } from 'bun:sqlite'
import { readdir } from 'node:fs/promises'
import { drizzle } from 'drizzle-orm/bun-sqlite'

export async function createTestDatabase(): Promise<{ db: CivupDatabase, sqlite: Database }> {
  const sqlite = new Database(':memory:')
  sqlite.run('PRAGMA foreign_keys = ON')

  const migrationDir = new URL('../../../../packages/db/migrations/', import.meta.url)
  const migrationFiles = (await readdir(migrationDir))
    .filter(file => /^\d+_.*\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b))

  for (const file of migrationFiles) {
    const migrationSql = await Bun.file(new URL(file, migrationDir)).text()
    for (const statement of migrationSql.split('--> statement-breakpoint')) {
      const sql = statement.trim()
      if (!sql) continue
      sqlite.exec(sql)
    }
  }

  const db = drizzle(sqlite, { schema }) as unknown as CivupDatabase
  return { db, sqlite }
}

export function createTestKv(): KVNamespace {
  const store = new Map<string, string>()

  const kv = {
    async get(key: string, type?: string) {
      const value = store.get(key)
      if (value == null) return null
      if (type === 'json') {
        try {
          return JSON.parse(value)
        }
        catch {
          return null
        }
      }
      return value
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  }

  return kv as unknown as KVNamespace
}
