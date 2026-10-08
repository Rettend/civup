import type { CloudflareD1Statement } from '../../../scripts/cloudflare-client.ts'
import { balancedSqlAnd } from './season-cancellation-predicates.ts'

/** Postconditions come from the original, unoptimized replay, not the compactor. */
export function replayPostconditions(
  statements: readonly CloudflareD1Statement[],
  matchIds: readonly string[],
): CloudflareD1Statement[] {
  const tables = new Map<string, { columns: string[]; rows: Array<Array<string | number | null>> }>()
  for (const statement of statements) {
    if (!/^insert into "(?:player_rating_events|season_rating_states|player_ratings)" /.test(statement.sql)) continue
    const parsed = /^insert into "([a-z_]+)" \(([^)]+)\) values \(([^)]+)\)(?: on conflict .*)?$/.exec(statement.sql)
    if (!parsed) throw new Error('Unsupported rating write shape; cannot verify this cancellation plan.')
    const table = parsed[1]!
    const columns = parsed[2]!.split(', ').map(column => {
      if (!/^"[a-z_][a-z0-9_]*"$/.test(column)) throw new Error('Unsupported rating column.')
      return column.slice(1, -1)
    })
    let parameter = 0
    const row = parsed[3]!.split(', ').map(value => {
      if (value === 'null') return null
      if (value !== '?') throw new Error('Unsupported rating value.')
      const bound = statement.params?.[parameter++]
      if (bound === undefined) throw new Error('Missing rating value.')
      return bound
    })
    if (columns.length !== row.length) throw new Error('Rating columns and values disagree.')
    // This field is omitted from the season-state UPSERT's update clause.
    const managedTier = columns.indexOf('managed_tier')
    if (managedTier >= 0) {
      columns.splice(managedTier, 1)
      row.splice(managedTier, 1)
    }
    const existing = tables.get(table)
    if (existing && JSON.stringify(existing.columns) !== JSON.stringify(columns))
      throw new Error('Rating write columns changed during replay.')
    if (existing) existing.rows.push(row)
    else tables.set(table, { columns, rows: [row] })
  }
  if (!tables.has('season_rating_states') || !tables.has('player_ratings'))
    throw new Error('The replay has no expected rating summaries.')
  const queries: CloudflareD1Statement[] = []
  for (const [table, { columns, rows }] of tables) {
    for (let offset = 0; offset < rows.length; offset += 40) {
      queries.push({
        sql: `SELECT count(*) AS mismatches FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM "${table}" actual WHERE ${balancedSqlAnd(columns.map((column, i) => `actual."${column}" IS json_extract(expected.value,'$[${i}]')`))})`,
        params: [JSON.stringify(rows.slice(offset, offset + 40))],
      })
    }
  }
  queries.push({
    sql: 'SELECT abs(count(*)-?) AS mismatches FROM player_rating_events WHERE match_id IN (SELECT value FROM json_each(?))',
    params: [tables.get('player_rating_events')?.rows.length ?? 0, JSON.stringify(matchIds)],
  })
  return queries
}
