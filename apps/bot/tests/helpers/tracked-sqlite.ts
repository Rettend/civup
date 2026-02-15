import type { Database } from 'bun:sqlite'

export interface SqlOperationCounts {
  rowsRead: number
  rowsWritten: number
}

type StatementKind = 'read' | 'write' | 'other'

interface StatementRunResult {
  changes?: number
}

interface TrackedStatement {
  all?: (...args: any[]) => unknown
  get?: (...args: any[]) => unknown
  values?: (...args: any[]) => unknown
  iterate?: (...args: any[]) => Iterable<unknown>
  run?: (...args: any[]) => StatementRunResult
}

export function trackSqlite(sqlite: Database): {
  counts: SqlOperationCounts
  reset: () => void
  restore: () => void
} {
  const counts: SqlOperationCounts = {
    rowsRead: 0,
    rowsWritten: 0,
  }

  const originalPrepare = sqlite.prepare.bind(sqlite)

  sqlite.prepare = ((sql: string, ...rest: unknown[]) => {
    const statement = originalPrepare(sql, ...rest) as TrackedStatement
    const kind = classifyStatement(sql)
    return wrapStatement(statement, kind, counts)
  }) as typeof sqlite.prepare

  return {
    counts,
    reset() {
      counts.rowsRead = 0
      counts.rowsWritten = 0
    },
    restore() {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare
    },
  }
}

function classifyStatement(sql: string): StatementKind {
  const normalized = sql.trimStart().toLowerCase()
  if (normalized.startsWith('select') || normalized.startsWith('with')) return 'read'
  if (
    normalized.startsWith('insert')
    || normalized.startsWith('update')
    || normalized.startsWith('delete')
    || normalized.startsWith('replace')
  ) {
    return 'write'
  }
  return 'other'
}

function wrapStatement(
  statement: TrackedStatement,
  kind: StatementKind,
  counts: SqlOperationCounts,
): TrackedStatement {
  if (statement.all) {
    const original = statement.all.bind(statement)
    statement.all = (...args: any[]) => {
      const rows = original(...args)
      if (kind === 'read' && Array.isArray(rows)) counts.rowsRead += rows.length
      return rows
    }
  }

  if (statement.get) {
    const original = statement.get.bind(statement)
    statement.get = (...args: any[]) => {
      const row = original(...args)
      if (kind === 'read' && row != null) counts.rowsRead += 1
      return row
    }
  }

  if (statement.values) {
    const original = statement.values.bind(statement)
    statement.values = (...args: any[]) => {
      const rows = original(...args)
      if (kind === 'read' && Array.isArray(rows)) counts.rowsRead += rows.length
      return rows
    }
  }

  if (statement.iterate) {
    const original = statement.iterate.bind(statement)
    statement.iterate = (...args: any[]) => {
      const iterable = original(...args)
      if (kind !== 'read') return iterable

      return {
        [Symbol.iterator]() {
          const iterator = iterable[Symbol.iterator]()
          return {
            next() {
              const result = iterator.next()
              if (!result.done) counts.rowsRead += 1
              return result
            },
          }
        },
      }
    }
  }

  if (statement.run) {
    const original = statement.run.bind(statement)
    statement.run = (...args: any[]) => {
      const result = original(...args)
      if (kind === 'write' && typeof result?.changes === 'number') {
        counts.rowsWritten += result.changes
      }
      return result
    }
  }

  return statement
}
