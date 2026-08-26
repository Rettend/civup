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

interface QueryPlanRow {
  detail: string
}

export function trackSqlite(sqlite: Database, options: { trackQueryPlans?: boolean } = {}): {
  counts: SqlOperationCounts
  flushQueryPlans: () => string[]
  reset: () => void
  restore: () => void
  runWithoutTracking: <T>(callback: () => Promise<T> | T) => Promise<T>
} {
  const counts: SqlOperationCounts = {
    rowsRead: 0,
    rowsWritten: 0,
  }
  let trackingEnabled = true
  const pendingQueryPlans = new Map<string, unknown[]>()
  const plannedSql = new Set<string>()

  const originalPrepare = sqlite.prepare.bind(sqlite)

  sqlite.prepare = ((sql: string, ...rest: unknown[]) => {
    const statement = originalPrepare(sql, ...rest) as TrackedStatement
    const kind = classifyStatement(sql)
    return wrapStatement(statement, kind, counts, () => trackingEnabled, (args) => {
      if (!options.trackQueryPlans || plannedSql.has(sql) || pendingQueryPlans.has(sql)) return
      pendingQueryPlans.set(sql, args)
    })
  }) as typeof sqlite.prepare

  return {
    counts,
    flushQueryPlans() {
      const details: string[] = []
      for (const [sql, args] of pendingQueryPlans) {
        const rows = originalPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as QueryPlanRow[]
        details.push(...rows.map(row => row.detail))
        plannedSql.add(sql)
      }
      pendingQueryPlans.clear()
      return details
    },
    reset() {
      counts.rowsRead = 0
      counts.rowsWritten = 0
    },
    async runWithoutTracking<T>(callback: () => Promise<T> | T): Promise<T> {
      const previous = trackingEnabled
      trackingEnabled = false
      try {
        return await callback()
      }
      finally {
        trackingEnabled = previous
      }
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
  isTrackingEnabled: () => boolean,
  recordQueryPlan: (args: unknown[]) => void,
): TrackedStatement {
  if (statement.all) {
    const original = statement.all.bind(statement)
    statement.all = (...args: any[]) => {
      if (isTrackingEnabled() && kind === 'read') recordQueryPlan(args)
      const rows = original(...args)
      if (isTrackingEnabled() && kind === 'read' && Array.isArray(rows)) counts.rowsRead += rows.length
      return rows
    }
  }

  if (statement.get) {
    const original = statement.get.bind(statement)
    statement.get = (...args: any[]) => {
      if (isTrackingEnabled() && kind === 'read') recordQueryPlan(args)
      const row = original(...args)
      if (isTrackingEnabled() && kind === 'read' && row != null) counts.rowsRead += 1
      return row
    }
  }

  if (statement.values) {
    const original = statement.values.bind(statement)
    statement.values = (...args: any[]) => {
      if (isTrackingEnabled() && kind === 'read') recordQueryPlan(args)
      const rows = original(...args)
      if (isTrackingEnabled() && kind === 'read' && Array.isArray(rows)) counts.rowsRead += rows.length
      return rows
    }
  }

  if (statement.iterate) {
    const original = statement.iterate.bind(statement)
    statement.iterate = (...args: any[]) => {
      if (isTrackingEnabled() && kind === 'read') recordQueryPlan(args)
      const iterable = original(...args)
      if (kind !== 'read') return iterable

      return {
        [Symbol.iterator]() {
          const iterator = iterable[Symbol.iterator]()
          return {
            next() {
              const result = iterator.next()
              if (isTrackingEnabled() && !result.done) counts.rowsRead += 1
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
      if (isTrackingEnabled() && kind === 'write' && typeof result?.changes === 'number') {
        counts.rowsWritten += result.changes
      }
      return result
    }
  }

  return statement
}
