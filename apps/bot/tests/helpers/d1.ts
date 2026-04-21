import type { Database as BunSqliteDatabase } from 'bun:sqlite'

type SqliteLike = Pick<BunSqliteDatabase, 'prepare' | 'exec'> | { $client?: Pick<BunSqliteDatabase, 'prepare' | 'exec'> }

const EMPTY_D1_META = {
  served_by: 'bun-sqlite-test',
  duration: 0,
  changes: 0,
  last_row_id: 0,
  changed_db: false,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
}

export function createSqliteD1Database(input: SqliteLike): D1Database {
  const sqlite = resolveSqlite(input)

  return {
    prepare(query: string) {
      return createPreparedStatement(sqlite, query)
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map(statement => statement.run()))
    },
    async exec(query: string) {
      sqlite.exec(query)
      return {
        count: 0,
        duration: 0,
      }
    },
  } as D1Database
}

function resolveSqlite(input: SqliteLike): Pick<BunSqliteDatabase, 'prepare' | 'exec'> {
  if ('prepare' in input && typeof input.prepare === 'function') return input
  if (input.$client && typeof input.$client.prepare === 'function') return input.$client
  throw new Error('Could not resolve sqlite client for test D1 adapter')
}

function createPreparedStatement(sqlite: Pick<BunSqliteDatabase, 'prepare'>, query: string): D1PreparedStatement {
  return {
    bind(...values: unknown[]) {
      return createBoundStatement(sqlite, query, values)
    },
  } as D1PreparedStatement
}

function createBoundStatement(
  sqlite: Pick<BunSqliteDatabase, 'prepare'>,
  query: string,
  values: unknown[],
): D1PreparedStatement {
  const statement = sqlite.prepare(query)

  return {
    bind(...nextValues: unknown[]) {
      return createBoundStatement(sqlite, query, nextValues)
    },
    async first<T = Record<string, unknown>>(columnName?: string) {
      const row = statement.get(...values) as Record<string, unknown> | null | undefined
      if (!row) return null
      if (columnName) return (row[columnName] ?? null) as T
      return row as T
    },
    async run() {
      const result = statement.run(...values)
      return {
        success: true,
        meta: {
          ...EMPTY_D1_META,
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid ?? 0),
          changed_db: result.changes > 0,
          rows_written: result.changes,
        },
      }
    },
    async all<T = Record<string, unknown>>() {
      const results = statement.all(...values) as T[]
      return {
        success: true,
        results,
        meta: {
          ...EMPTY_D1_META,
          rows_read: results.length,
        },
      }
    },
    async raw<T = unknown[]>() {
      return statement.values(...values) as T[]
    },
  } as D1PreparedStatement
}
