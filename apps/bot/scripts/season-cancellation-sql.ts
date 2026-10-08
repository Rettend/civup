/** Local-only compaction of compiled replay queries. This module never submits SQL. */
export interface ReplaySqlQuery {
  sql: string
  params: readonly unknown[]
}

export interface ReplaySqlLimits {
  maxStatements: number
  maxBodyBytes: number
  maxSqlBytes: number
  maxBindingBytes: number
  maxParameters: number
}

export const REPLAY_SQL_LIMITS: Readonly<ReplaySqlLimits> = Object.freeze({
  maxStatements: 999,
  maxBodyBytes: 9_999_999,
  maxSqlBytes: 100_000,
  maxBindingBytes: 2_000_000,
  maxParameters: 100,
})

const bytes = (value: string) => new TextEncoder().encode(value).length
const column = (table: string, name: string) => `"${table}"."${name}"`
const guardSql = (condition: string) =>
  `select case when ${condition} then 1 else json_extract('Stale season rating source', '$') end from (select 1) as rating_guard`

// These are exact compiled Drizzle shapes, not a general SQL parser. Changes to a
// shape (including whitespace) deliberately fall back to the original query.
const eventGuardColumns = [
  'rating_before_mu',
  'rating_before_sigma',
  'rating_after_mu',
  'rating_after_sigma',
  'games_delta',
  'wins_delta',
  'imported_games_delta',
  'effective_games_delta',
  'wins_vs_tier_1_delta',
  'wins_vs_tier_2_plus_delta',
  'effective_wins_vs_tier_1_delta',
  'effective_wins_vs_tier_2_plus_delta',
  'public_rating_before',
  'public_rating_after',
  'public_sequence',
  'public_formula_version',
  'public_calibration_version',
  'public_decay_before',
  'public_decay_after',
  'public_decay_delta',
]
const ratingEvidenceColumns = [
  'games_played',
  'wins',
  'imported_games',
  'effective_games',
  'wins_vs_tier_1',
  'wins_vs_tier_2_plus',
  'effective_wins_vs_tier_1',
  'effective_wins_vs_tier_2_plus',
]
const guardConditions = [
  `coalesce((select revision from division_rank_sources where player_id=?),0)=?
        and (select result_json from division_rank_states where guild_id=? and player_id=?) is ?`,
  `exists(select 1 from "matches" where "matches"."id" = ?
    and "matches"."status" = ? and "matches"."season_id" = ? and "matches"."draft_data" is ?
    and "matches"."created_at" = ? and "matches"."game_mode" = ? and "matches"."is_old" = ?)
    and (select count(*) from "match_participants" where "match_participants"."match_id" = ?) = ?`,
  `exists(select 1 from "match_participants" where "match_participants"."match_id" = ?
    and "match_participants"."player_id" = ? and "match_participants"."team" is ?
    and "match_participants"."placement" is ? and "match_participants"."civ_id" is ?)`,
  `exists(select 1 from "season_match_reports" where "season_match_reports"."match_id" = ?
    and "season_match_reports"."sequence" = ? and "season_match_reports"."accepted_at" = ?
    and "season_match_reports"."cancelled_at" is ? and "season_match_reports"."opponent_tiers" = ?)`,
  `exists(select 1 from "season_rating_states" where "season_rating_states"."season_id" = ?
    and "season_rating_states"."player_id" = ? and "season_rating_states"."mode" = ?
    and "season_rating_states"."revision" = ? and "season_rating_states"."mu" = ? and "season_rating_states"."sigma" = ?
    and "season_rating_states"."public_rating" is ? and "season_rating_states"."public_badge" is ? and "season_rating_states"."public_decay" is ? and "season_rating_states"."evidence" = ?
    and "season_rating_states"."season_games" = ? and "season_rating_states"."season_wins" = ?
    and "season_rating_states"."last_played_at" is ?)`,
  `exists(select 1 from "player_ratings"
    where "player_ratings"."player_id" = ? and "player_ratings"."mode" = ?
    and "player_ratings"."mu" = ? and "player_ratings"."sigma" = ? and "player_ratings"."public_rating" is ?
    and "player_ratings"."public_badge" is ? and "player_ratings"."public_decay" is ?
    and "player_ratings"."updated_at" is ? and "player_ratings"."last_played_at" is ?
    and (${ratingEvidenceColumns.map(name => `${column('player_ratings', name)} = ?`).join(' and ')}))`,
  `exists(select 1 from "player_rating_events" where "player_rating_events"."match_id" = ?
    and "player_rating_events"."player_id" = ? and "player_rating_events"."mode" = ?
    and (${eventGuardColumns.map(name => `${column('player_rating_events', name)} is ?`).join(' and ')}))`,
]

interface Rule {
  kind: 'guard' | 'write'
  sql: string
  compactSql: string
  row: (params: readonly unknown[]) => readonly unknown[] | null
  sameGroup?: (params: readonly unknown[], first: readonly unknown[]) => boolean
  bindings?: (rows: string, first: readonly unknown[]) => readonly unknown[]
  uniqueKey?: (params: readonly unknown[]) => string
}
const rules = new Map<string, Rule>()
const extract = (index: number) => `json_extract(replay_rows.value, '$[${index}]')`

for (const condition of guardConditions) {
  let count = 0
  // Replacement is restricted to the constant allowlist above; there are no
  // quoted question marks, named parameters, writes, or volatile expressions.
  const compactCondition = condition.replaceAll('?', () => extract(count++))
  const sql = guardSql(condition)
  rules.set(sql, {
    kind: 'guard',
    sql,
    compactSql: guardSql(
      `not exists(select 1 from json_each(?) as replay_rows where case when ${compactCondition} then 0 else 1 end)`,
    ),
    row: params => {
      if (params.length !== count) return null
      // The raw sql guard binds Drizzle's is_old boolean without a column
      // encoder. JSON extraction must compare its SQLite 0/1 representation.
      if (condition === guardConditions[1] && typeof params[6] === 'boolean')
        return params.map((value, index) => (index === 6 ? Number(value) : value))
      return params
    },
  })
}

interface InsertShape {
  table: string
  columns: string[]
  /** Parameter indexes in the original insert; null means the SQL literal NULL. */
  values?: (number | null)[]
  keys?: string[]
  updates?: string[]
  where?: string
  compactWhere?: string
  check?: (params: readonly unknown[]) => boolean
}

function addInsert(shape: InsertShape) {
  const { table, columns, keys, updates = [] } = shape
  const values = shape.values ?? columns.map((_, index) => index)
  const insertParams = values.filter(index => index !== null).length
  const prefix = `insert into "${table}" (${columns.map(name => `"${name}"`).join(', ')})`
  const conflict = keys ? ` on conflict (${keys.map(name => column(table, name)).join(', ')}) do update set ` : ''
  const sql = `${prefix} values (${values.map(index => (index === null ? 'null' : '?')).join(', ')})${conflict}${updates.map(name => `"${name}" = ?`).join(', ')}${shape.where ? ` where ${shape.where}` : ''}`
  const compactSql = `${prefix} select ${columns.map((_, index) => extract(index)).join(', ')} from json_each(?) as replay_rows where true order by cast(replay_rows.key as integer)${conflict}${updates.map(name => `"${name}" = excluded.${name}`).join(', ')}${shape.compactWhere ? ` where ${shape.compactWhere}` : ''}`
  const count = insertParams + updates.length + (shape.where ? 1 : 0)
  const rule: Rule = {
    kind: 'write',
    sql,
    compactSql,
    row: params => {
      if (params.length !== count || (shape.check && !shape.check(params))) return null
      const row = values.map(index => (index === null ? null : params[index]))
      // Do not assume update bindings match insert bindings: Drizzle supplies
      // both. Only rewrite to excluded after verifying every duplicated value.
      if (updates.some((name, index) => !Object.is(row[columns.indexOf(name)], params[insertParams + index])))
        return null
      return row
    },
  }
  rules.set(sql, rule)
  return rule
}

const eventInsert = addInsert({
  table: 'player_rating_events',
  columns: [
    'match_id',
    'player_id',
    'mode',
    'game_mode',
    ...eventGuardColumns.slice(0, 12),
    'match_created_at',
    'match_completed_at',
    'updated_at',
    'season_id',
    'public_sequence',
    'public_rating_before',
    'public_rating_after',
    'public_formula_version',
    'public_calibration_version',
    'public_decay_before',
    'public_decay_after',
    'public_decay_delta',
  ],
})

const playerRatingColumns = [
  'player_id',
  'mode',
  'mu',
  'sigma',
  ...ratingEvidenceColumns,
  'last_played_at',
  'updated_at',
  'public_rating',
  'public_badge',
  'public_decay',
]
const liveRatingInsert = addInsert({
  table: 'player_ratings',
  columns: playerRatingColumns,
  keys: ['player_id', 'mode'],
  updates: playerRatingColumns,
})

const seasonRatingColumns = [
  'season_id',
  'player_id',
  'mode',
  'mu',
  'sigma',
  'public_rating',
  'public_badge',
  'public_decay',
  'managed_tier',
  'season_games',
  'season_wins',
  'evidence',
  'last_played_at',
  'revision',
  'updated_at',
]
const seasonRatingInsert = addInsert({
  table: 'season_rating_states',
  columns: seasonRatingColumns,
  values: seasonRatingColumns.map((_, index) => (index === 8 ? null : index > 8 ? index - 1 : index)),
  keys: ['season_id', 'player_id', 'mode'],
  updates: seasonRatingColumns.filter(name => name !== 'managed_tier'),
})
const divisionPeakInsert = addInsert({
  table: 'season_peak_division_ranks',
  columns: ['season_id', 'player_id', 'minimum', 'achieved_at'],
  keys: ['season_id', 'player_id'],
  updates: ['minimum', 'achieved_at'],
  where: '"season_peak_division_ranks"."minimum"<?',
  compactWhere: '"season_peak_division_ranks"."minimum"<excluded.minimum',
  check: params => Object.is(params[2], params[6]),
})
const rankPeakInsert = addInsert({
  table: 'season_peak_ranks',
  columns: ['season_id', 'player_id', 'tier', 'source_mode', 'achieved_at'],
  keys: ['season_id', 'player_id'],
  updates: ['tier', 'source_mode', 'achieved_at'],
  where: 'cast(substr("season_peak_ranks"."tier",5) as integer)>?',
  compactWhere: 'cast(substr("season_peak_ranks"."tier",5) as integer)>cast(substr(excluded.tier,5) as integer)',
  check: params =>
    typeof params[2] === 'string' &&
    /^tier[1-9]\d*$/.test(params[2]) &&
    Number.isSafeInteger(params[8]) &&
    Number(params[2].slice(4)) === params[8],
})

const participantSnapshotSql =
  'update "match_participants" set "rating_before_mu" = ?, "rating_before_sigma" = ?, "rating_after_mu" = ?, "rating_after_sigma" = ? where ("match_participants"."match_id" = ? and "match_participants"."player_id" = ?)'
const participantSnapshots: Rule = {
  kind: 'write',
  sql: participantSnapshotSql,
  compactSql: `update "match_participants" set ${['rating_before_mu', 'rating_before_sigma', 'rating_after_mu', 'rating_after_sigma'].map((name, index) => `"${name}" = ${extract(index)}`).join(', ')} from json_each(?) as replay_rows where "match_participants"."match_id" = ${extract(4)} and "match_participants"."player_id" = ${extract(5)}`,
  row: params =>
    params.length === 6 &&
    typeof params[4] === 'string' &&
    typeof params[5] === 'string' &&
    params.slice(0, 4).every(value => value === null || (typeof value === 'number' && Number.isFinite(value)))
      ? params
      : null,
  uniqueKey: params => JSON.stringify(params.slice(4)),
}
rules.set(participantSnapshots.sql, participantSnapshots)

const dirtyDelete: Rule = {
  kind: 'write',
  sql: 'delete from "division_quality_dirty" where ("division_quality_dirty"."guild_id" = ? and "division_quality_dirty"."player_id" = ?)',
  compactSql: `delete from "division_quality_dirty" where ("guild_id", "player_id") in (select ${extract(0)}, ${extract(1)} from json_each(?) as replay_rows)`,
  row: params => (params.length === 2 && params.every(value => typeof value === 'string') ? params : null),
}
rules.set(dirtyDelete.sql, dirtyDelete)

function jsonStringArray(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null
  } catch {
    return null
  }
}

const creditsDeletePrefix =
  'delete from "division_quality_credits" where ("division_quality_credits"."guild_id" = ? and "division_quality_credits"."player_id" = ? and "division_quality_credits"."match_id" in (select value from json_each(?))'
const creditsDelete: Rule = {
  kind: 'write',
  sql: `${creditsDeletePrefix} and "division_quality_credits"."match_id" not in (select value from json_each(?)))`,
  // Enumerate the finite, non-NULL composite keys so SQLite can seek the PK,
  // rather than scanning unrelated guilds' ledgers for an EXISTS predicate.
  compactSql: `delete from "division_quality_credits" where ("guild_id", "player_id", "match_id") in (select ${extract(0)}, ${extract(1)}, replaced.value from json_each(?) as replay_rows join json_each(?) as replaced where replaced.value not in (select value from json_each(${extract(2)})))`,
  row: params =>
    (params.length === 3 || params.length === 4) &&
    typeof params[0] === 'string' &&
    typeof params[1] === 'string' &&
    jsonStringArray(params[2]) &&
    (params.length === 3 || jsonStringArray(params[3]))
      ? [params[0], params[1], params[3] ?? null]
      : null,
  sameGroup: (params, first) => params[2] === first[2],
  bindings: (rows, first) => [rows, first[2]],
}
rules.set(creditsDelete.sql, creditsDelete)
rules.set(`${creditsDeletePrefix})`, creditsDelete)

const creditColumns = ['at', 'effective_games', 'high_rank_wins', 'elite_wins']
const creditFields = ['at', 'effectiveGames', 'highRankWins', 'eliteWins']
const creditsInsert: Rule = {
  kind: 'write',
  sql: 'insert into "division_quality_credits" ("guild_id", "player_id", "match_id", "at", "effective_games", "high_rank_wins", "elite_wins") select ? as "guild_id", ? as "player_id", json_extract(value,\'$.matchId\') as "match_id", json_extract(value,\'$.at\') as "at", json_extract(value,\'$.effectiveGames\') as "effective_games", json_extract(value,\'$.highRankWins\') as "high_rank_wins", json_extract(value,\'$.eliteWins\') as "elite_wins" from json_each(?) where true on conflict ("division_quality_credits"."guild_id", "division_quality_credits"."player_id", "division_quality_credits"."match_id") do update set "at" = excluded.at, "effective_games" = excluded.effective_games, "high_rank_wins" = excluded.high_rank_wins, "elite_wins" = excluded.elite_wins where "division_quality_credits"."at" is not excluded.at or "division_quality_credits"."effective_games" is not excluded.effective_games\n          or "division_quality_credits"."high_rank_wins" is not excluded.high_rank_wins or "division_quality_credits"."elite_wins" is not excluded.elite_wins',
  compactSql: `insert into "division_quality_credits" ("guild_id", "player_id", "match_id", "at", "effective_games", "high_rank_wins", "elite_wins") select ${extract(0)}, ${extract(1)}, json_extract(credits.value, '$.matchId'), ${creditFields.map(name => `json_extract(credits.value, '$.${name}')`).join(', ')} from json_each(?) as replay_rows join json_each(${extract(2)}) as credits where true order by cast(replay_rows.key as integer), cast(credits.key as integer) on conflict ("division_quality_credits"."guild_id", "division_quality_credits"."player_id", "division_quality_credits"."match_id") do update set ${creditColumns.map(name => `"${name}" = excluded.${name}`).join(', ')} where ${creditColumns.map(name => `"division_quality_credits"."${name}" is not excluded.${name}`).join(' or ')}`,
  row: params => {
    if (
      params.length !== 3 ||
      typeof params[0] !== 'string' ||
      typeof params[1] !== 'string' ||
      typeof params[2] !== 'string'
    )
      return null
    try {
      const rows: unknown = JSON.parse(params[2])
      if (
        !Array.isArray(rows) ||
        !rows.every(
          row =>
            row &&
            typeof row === 'object' &&
            typeof row.matchId === 'string' &&
            (row.playerId === undefined || row.playerId === params[1]) &&
            creditFields.every(name => typeof row[name] === 'number' && Number.isFinite(row[name])),
        )
      )
        return null
      // Keep the original JSON as text. Parsing/reserializing its numbers can
      // change int64 or double interpretation relative to the original SQL.
      return params
    } catch {
      return null
    }
  },
}
rules.set(creditsInsert.sql, creditsInsert)

const divisionStateInsert: Rule = {
  kind: 'write',
  sql: 'insert into "division_rank_states" ("guild_id", "player_id", "source_revision", "result_json", "next_check_at", "desired_role_id", "applied_role_id", "pending", "projection_pending", "retry_at", "last_error") values (?, ?, coalesce((select revision from division_rank_sources where player_id=?),0), ?, ?, ?, ?, ?, ?, ?, null) on conflict ("division_rank_states"."guild_id", "division_rank_states"."player_id") do update set "source_revision" = coalesce((select revision from division_rank_sources where player_id=?),0), "result_json" = ?, "next_check_at" = ?, "desired_role_id" = ?, "pending" = "division_rank_states"."applied_role_id" is not ?, "projection_pending" = ?, "retry_at" = ?, "last_error" = ?',
  compactSql: `insert into "division_rank_states" ("guild_id", "player_id", "source_revision", "result_json", "next_check_at", "desired_role_id", "applied_role_id", "pending", "projection_pending", "retry_at", "last_error") select ${extract(0)}, ${extract(1)}, coalesce((select revision from division_rank_sources where player_id=${extract(2)}),0), ${Array.from({ length: 7 }, (_, index) => extract(index + 3)).join(', ')}, null from json_each(?) as replay_rows where true order by cast(replay_rows.key as integer) on conflict ("division_rank_states"."guild_id", "division_rank_states"."player_id") do update set "source_revision" = excluded.source_revision, "result_json" = excluded.result_json, "next_check_at" = excluded.next_check_at, "desired_role_id" = excluded.desired_role_id, "pending" = "division_rank_states"."applied_role_id" is not excluded.desired_role_id, "projection_pending" = excluded.projection_pending, "retry_at" = excluded.retry_at, "last_error" = excluded.last_error`,
  row: params => {
    if (
      params.length !== 18 ||
      typeof params[0] !== 'string' ||
      typeof params[1] !== 'string' ||
      params[2] !== params[1] ||
      params[10] !== params[1]
    )
      return null
    if (
      ![
        [3, 11],
        [4, 12],
        [5, 13],
        [5, 14],
        [8, 15],
        [9, 16],
      ].every(([left, right]) => Object.is(params[left!], params[right!]))
    )
      return null
    if (![0, 1].includes(params[7] as number) || params[8] !== 1 || params[9] !== 0 || params[17] !== null) return null
    return params.slice(0, 10)
  },
}
rules.set(divisionStateInsert.sql, divisionStateInsert)

function encodeRow(row: readonly unknown[]): string | null {
  const parts: string[] = []
  for (const value of row) {
    if (value === null || typeof value === 'string') {
      parts.push(JSON.stringify(value))
    } else if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) {
      const number = JSON.stringify(value)
      // An unsafe integer is a double, not an exact SQLite int64. Force JSON's
      // REAL path so decimal formatting cannot silently change its value/type.
      parts.push(!Number.isSafeInteger(value) && !/[.eE]/.test(number) ? `${number}.0` : number)
    } else {
      return null
    }
  }
  return `[${parts.join(',')}]`
}

interface IndexedQuery {
  query: ReplaySqlQuery
  source: number
}

function valid(item: IndexedQuery | undefined, rule: Rule): item is IndexedQuery {
  if (!item || rules.get(item.query.sql) !== rule) return false
  const row = rule.row(item.query.params)
  return row !== null && encodeRow(row) !== null
}

/**
 * These are three grammars from replay.ts / atomic-divisions.ts, not a sort.
 * A complete maximal region must validate; any mutation/overlap keeps that
 * entire region in its original order. Guards and other SQL are hard barriers.
 *
 * Proof, against migrations 0028 and 0029 (verified separately below):
 * - Participant snapshots have no triggers, touch no event/quality fields, and
 *   cannot affect event FKs. Event triggers never read participant snapshots.
 *   Event order is retained; keyed UPDATEs have unique input keys.
 * - Live summaries have no triggers. Season summaries only increment the
 *   owning season's standings_revision, without reading live summaries.
 *   Each table retains its original UPSERT order, including repeated keys.
 * - Division blocks have distinct players and one guild. Credits and dirty
 *   work have no triggers; state subqueries read only their own player's source
 *   revision, which no operation in the region changes. Pending reads only the
 *   same state's applied role. Peak triggers only add to standings_revision;
 *   those increments commute. Per-player step order and each table's row order
 *   are retained. Initial guards and the final policy increment never move.
 */
function reorderReplayBlocks(input: readonly ReplaySqlQuery[]) {
  const original = input.map((query, source) => ({ query, source }))
  const items: IndexedQuery[] = []
  const eventRules = new Set([eventInsert, participantSnapshots])
  const ratingRules = new Set([seasonRatingInsert, liveRatingInsert])
  const divisionRules = new Set([
    dirtyDelete,
    creditsDelete,
    creditsInsert,
    divisionStateInsert,
    divisionPeakInsert,
    rankPeakInsert,
  ])
  let reorderedBlocks = 0
  for (let start = 0; start < original.length;) {
    const firstRule = rules.get(original[start]!.query.sql)
    const family =
      firstRule &&
      (eventRules.has(firstRule)
        ? eventRules
        : ratingRules.has(firstRule)
          ? ratingRules
          : divisionRules.has(firstRule)
            ? divisionRules
            : null)
    if (!family) {
      items.push(original[start++]!)
      continue
    }
    let end = start
    while (end < original.length && family.has(rules.get(original[end]!.query.sql)!)) end++
    const region = original.slice(start, end)
    let phases: IndexedQuery[][] | null = null
    if (family === eventRules) {
      const events: IndexedQuery[] = [],
        snapshots: IndexedQuery[] = []
      const eventKeys = new Set<string>(),
        snapshotKeys = new Set<string>()
      let cursor = 0
      while (cursor < region.length) {
        const event = region[cursor++]
        if (!valid(event, eventInsert)) break
        const p = event.query.params
        if (
          ![p[0], p[1], p[2]].every(value => typeof value === 'string') ||
          !['global', 'duel', 'duo', 'squad', 'ffa'].includes(p[2] as string)
        )
          break
        const key = JSON.stringify(p.slice(0, 3))
        if (eventKeys.has(key)) break
        eventKeys.add(key)
        events.push(event)
        if (p[2] !== 'global') {
          const update = region[cursor++]
          if (!valid(update, participantSnapshots)) break
          const u = update.query.params
          if (!u.slice(0, 4).every((value, index) => Object.is(value, p[index + 4])) || u[4] !== p[0] || u[5] !== p[1])
            break
          const updateKey = participantSnapshots.uniqueKey!(u)
          if (snapshotKeys.has(updateKey)) break
          snapshotKeys.add(updateKey)
          snapshots.push(update)
        }
      }
      if (events.length + snapshots.length === region.length) phases = [events, snapshots]
    } else if (family === ratingRules) {
      const states: IndexedQuery[] = [],
        live: IndexedQuery[] = []
      for (let cursor = 0; cursor < region.length; cursor += 2) {
        const state = region[cursor],
          rating = region[cursor + 1]
        if (!valid(state, seasonRatingInsert) || !valid(rating, liveRatingInsert)) break
        if (
          typeof state.query.params[0] !== 'string' ||
          typeof state.query.params[1] !== 'string' ||
          typeof state.query.params[2] !== 'string' ||
          state.query.params[1] !== rating.query.params[0] ||
          state.query.params[2] !== rating.query.params[1]
        )
          break
        states.push(state)
        live.push(rating)
      }
      if (states.length + live.length === region.length) phases = [states, live]
    } else {
      const beforeDirty: IndexedQuery[] = [],
        deletes: IndexedQuery[] = [],
        credits: IndexedQuery[] = [],
        afterDirty: IndexedQuery[] = [],
        states: IndexedQuery[] = [],
        divisionPeaks: IndexedQuery[] = [],
        rankPeaks: IndexedQuery[] = []
      const players = new Set<string>()
      let guild: unknown
      let cursor = 0
      while (cursor < region.length) {
        const block: IndexedQuery[][] = [[], [], [], [], [], [], []]
        if (valid(region[cursor], dirtyDelete)) block[0]!.push(region[cursor++]!)
        const deletion = region[cursor++]
        if (!valid(deletion, creditsDelete)) break
        const [ownGuild, player] = deletion.query.params as [string, string]
        if (players.has(player) || (guild !== undefined && guild !== ownGuild)) break
        players.add(player)
        guild = ownGuild
        block[1]!.push(deletion)
        if (valid(region[cursor], creditsInsert)) block[2]!.push(region[cursor++]!)
        const dirty = region[cursor++],
          state = region[cursor++]
        if (!valid(dirty, dirtyDelete) || !valid(state, divisionStateInsert)) break
        block[3]!.push(dirty)
        block[4]!.push(state)
        if (
          !block
            .slice(0, 5)
            .flat()
            .every(item => item.query.params[0] === ownGuild && item.query.params[1] === player)
        )
          break
        if (valid(region[cursor], divisionPeakInsert)) {
          const division = region[cursor++],
            rank = region[cursor++]
          if (
            !valid(rank, rankPeakInsert) ||
            division!.query.params[1] !== player ||
            rank.query.params[1] !== player ||
            division!.query.params[0] !== rank.query.params[0] ||
            typeof rank.query.params[0] !== 'string'
          )
            break
          block[5]!.push(division!)
          block[6]!.push(rank)
        }
        const targets = [beforeDirty, deletes, credits, afterDirty, states, divisionPeaks, rankPeaks]
        block.forEach((rows, index) => targets[index]!.push(...rows))
      }
      const result = [beforeDirty, deletes, credits, afterDirty, states, divisionPeaks, rankPeaks]
      if (result.flat().length === region.length) phases = result
    }
    const ordered = phases?.flat()
    if (ordered && ordered.some((item, index) => item.source !== region[index]!.source)) {
      reorderedBlocks++
      items.push(...ordered)
    } else {
      items.push(...region)
    }
    start = end
  }
  return { items, reorderedBlocks }
}

export interface ReplaySqlSourceRange {
  /** Authoritative original coverage; end is exclusive. Never a bounding box. */
  sources: { start: number; end: number }[]
  kind: 'guard' | 'write' | 'unchanged'
}

function sourceCoverage(items: readonly IndexedQuery[]) {
  const sources: { start: number; end: number }[] = []
  for (const { source } of items) {
    const previous = sources.at(-1)
    if (previous?.end === source) previous.end++
    else sources.push({ start: source, end: source + 1 })
  }
  return sources
}

/** Query all deployed triggers on these tables, including empty result sets. */
export const SEASON_CANCELLATION_COMPACTION_TRIGGER_TABLES = Object.freeze([
  'player_rating_events',
  'match_participants',
  'season_rating_states',
  'player_ratings',
  'division_rank_sources',
  'division_rank_states',
  'division_quality_dirty',
  'division_quality_credits',
  'season_peak_division_ranks',
  'season_peak_ranks',
  'seasons',
])

export interface ReplaySqlTrigger {
  name: string
  tbl_name: string
  sql: string | null
}

const expectedTriggers: ReplaySqlTrigger[] = [
  {
    name: 'division_rank_event_insert',
    tbl_name: 'player_rating_events',
    sql: `CREATE TRIGGER division_rank_event_insert AFTER INSERT ON player_rating_events
WHEN NEW.mode = 'global' AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, NEW.player_id, NEW.match_id FROM division_rank_policies;
  INSERT INTO division_rank_sources(player_id, revision) VALUES(NEW.player_id, 1)
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO division_rank_states(guild_id, player_id, next_check_at)
    SELECT guild_id, NEW.player_id, 0 FROM division_rank_policies WHERE 1
    ON CONFLICT(guild_id, player_id) DO UPDATE SET next_check_at = 0;
END;`,
  },
  {
    name: 'division_rank_event_update',
    tbl_name: 'player_rating_events',
    sql: `CREATE TRIGGER division_rank_event_update AFTER UPDATE ON player_rating_events
WHEN (NEW.mode = 'global' OR OLD.mode = 'global') AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, OLD.player_id, OLD.match_id FROM division_rank_policies WHERE OLD.mode = 'global';
  INSERT INTO division_rank_sources(player_id, revision)
    SELECT OLD.player_id, 1 WHERE OLD.player_id != NEW.player_id
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0 WHERE player_id = OLD.player_id;
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, NEW.player_id, NEW.match_id FROM division_rank_policies;
  INSERT INTO division_rank_sources(player_id, revision) VALUES(NEW.player_id, 1)
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO division_rank_states(guild_id, player_id, next_check_at)
    SELECT guild_id, NEW.player_id, 0 FROM division_rank_policies WHERE 1
    ON CONFLICT(guild_id, player_id) DO UPDATE SET next_check_at = 0;
END;`,
  },
  {
    name: 'division_rank_event_delete',
    tbl_name: 'player_rating_events',
    sql: `CREATE TRIGGER division_rank_event_delete AFTER DELETE ON player_rating_events
WHEN OLD.mode = 'global' AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, OLD.player_id, OLD.match_id FROM division_rank_policies;
  INSERT INTO division_rank_sources(player_id, revision) VALUES(OLD.player_id, 1)
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0 WHERE player_id = OLD.player_id;
END;`,
  },
  {
    name: 'season_standings_metadata',
    tbl_name: 'seasons',
    sql: `CREATE TRIGGER season_standings_metadata AFTER UPDATE OF active, finalized_at, rating_system, public_reads_enabled ON seasons
WHEN OLD.active IS NOT NEW.active OR OLD.finalized_at IS NOT NEW.finalized_at OR OLD.rating_system IS NOT NEW.rating_system OR OLD.public_reads_enabled IS NOT NEW.public_reads_enabled
BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = NEW.id;
END;`,
  },
]
for (const [prefix, table] of [
  ['rating', 'season_rating_states'],
  ['peak', 'season_peak_ranks'],
  ['division_peak', 'season_peak_division_ranks'],
]) {
  for (const action of ['insert', 'update', 'delete']) {
    const name = `season_standings_${prefix}_${action}`
    const scope =
      action === 'update'
        ? 'id IN (OLD.season_id, NEW.season_id)'
        : `id = ${action === 'insert' ? 'NEW' : 'OLD'}.season_id`
    expectedTriggers.push({
      name,
      tbl_name: table!,
      sql: `CREATE TRIGGER ${name} AFTER ${action.toUpperCase()} ON ${table} BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE ${scope} AND active = 0;
END;`,
    })
  }
}

// Whitespace outside literals and the optional final semicolon are immaterial.
// Quoted content, tokens, punctuation and case must match the reviewed SQL.
function canonicalTrigger(sql: string) {
  return sql
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\s+/g, token => (/^\s/.test(token) ? ' ' : token))
    .trim()
    .replace(/;$/, '')
}

/** Fail closed on absent, edited or additional direct/transitive triggers. */
export function assertSeasonCancellationCompactionTriggers(actual: readonly ReplaySqlTrigger[]) {
  // SQLite identifiers ignore case, but the catalog preserves ON-clause casing.
  const relevant = actual.filter(trigger =>
    SEASON_CANCELLATION_COMPACTION_TRIGGER_TABLES.includes(trigger.tbl_name.toLowerCase()),
  )
  if (
    relevant.length !== expectedTriggers.length ||
    new Set(relevant.map(trigger => trigger.name)).size !== relevant.length
  )
    throw new Error('The database triggers do not match the reviewed cancellation SQL rules.')
  for (const expected of expectedTriggers) {
    const found = relevant.find(trigger => trigger.name === expected.name)
    if (
      !found ||
      found.tbl_name !== expected.tbl_name ||
      found.sql === null ||
      canonicalTrigger(found.sql) !== canonicalTrigger(expected.sql!)
    )
      throw new Error('The database triggers do not match the reviewed cancellation SQL rules.')
  }
}

/**
 * Merge exact shapes after the three proven block transformations above.
 * Guards retain CASE's NULL failure behavior. Unsupported shapes and mutated
 * blocks retain their original order. The result is ONE atomic batch;
 * callers must refuse an oversized result, never split it into transactions.
 * Call assertSeasonCancellationCompactionTriggers against deployed triggers
 * before submitting; an extra/changed trigger invalidates the proof.
 * per-query result counts/last_row_id are intentionally not preserved.
 */
export function compactSeasonCancellationSql(input: readonly ReplaySqlQuery[], options: Partial<ReplaySqlLimits> = {}) {
  const limits = { ...REPLAY_SQL_LIMITS, ...options }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('SQL limits must be positive whole numbers.')
    if (value > REPLAY_SQL_LIMITS[key as keyof ReplaySqlLimits])
      throw new Error('SQL limits may only be reduced from the supported ceilings.')
  }
  const { items, reorderedBlocks } = reorderReplayBlocks(input)
  const queries: ReplaySqlQuery[] = []
  const sourceRanges: ReplaySqlSourceRange[] = []
  let groupedGuards = 0,
    groupedWrites = 0,
    unchangedStatements = 0
  for (let start = 0; start < items.length;) {
    const first = items[start]!.query
    const rule = rules.get(first.sql)
    const rows: string[] = []
    let length = 2,
      end = start
    const keys = new Set<string>()
    if (rule && bytes(rule.compactSql) <= limits.maxSqlBytes) {
      while (end < items.length && rules.get(items[end]!.query.sql) === rule) {
        const params = items[end]!.query.params
        if (rule.sameGroup && !rule.sameGroup(params, first.params)) break
        const key = rule.uniqueKey?.(params)
        if (key !== undefined && keys.has(key)) break
        const row = rule.row(params)
        const encoded = row && encodeRow(row)
        if (!encoded) break
        const added = bytes(encoded) + (rows.length ? 1 : 0)
        if (length + added > limits.maxBindingBytes) break
        rows.push(encoded)
        if (key !== undefined) keys.add(key)
        length += added
        end++
      }
    }
    if (rule && rows.length > 1) {
      const encoded = `[${rows.join(',')}]`
      queries.push({ sql: rule.compactSql, params: rule.bindings ? rule.bindings(encoded, first.params) : [encoded] })
      sourceRanges.push({ sources: sourceCoverage(items.slice(start, end)), kind: rule.kind })
      if (rule.kind === 'guard') groupedGuards++
      else groupedWrites++
      start = end
    } else {
      queries.push(first)
      sourceRanges.push({ sources: sourceCoverage(items.slice(start, start + 1)), kind: 'unchanged' })
      unchangedStatements++
      start++
    }
  }
  const bodyBytes = bytes(JSON.stringify({ batch: queries }))
  const violations: string[] = []
  let largestSqlBytes = 0,
    largestBindingBytes = 0,
    largestParameterCount = 0
  queries.forEach((query, index) => {
    const sqlBytes = bytes(query.sql)
    largestSqlBytes = Math.max(largestSqlBytes, sqlBytes)
    largestParameterCount = Math.max(largestParameterCount, query.params.length)
    if (sqlBytes > limits.maxSqlBytes) violations.push(`Statement ${index} exceeds the SQL byte limit.`)
    if (query.params.length > limits.maxParameters) violations.push(`Statement ${index} has too many parameters.`)
    for (const value of query.params) {
      if (value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))
        violations.push(`Statement ${index} has an unsupported D1 parameter.`)
      const bindingBytes = typeof value === 'string' ? bytes(value) : 0
      largestBindingBytes = Math.max(largestBindingBytes, bindingBytes)
      if (bindingBytes > limits.maxBindingBytes) violations.push(`Statement ${index} exceeds the binding byte limit.`)
    }
  })
  if (queries.length > limits.maxStatements) violations.push('The atomic batch exceeds the statement limit.')
  if (bodyBytes > limits.maxBodyBytes) violations.push('The atomic batch exceeds the request body byte limit.')
  return {
    queries,
    sourceRanges,
    requiresTriggerVerification: groupedWrites > 0 || reorderedBlocks > 0,
    fitsLimits: violations.length === 0,
    violations,
    stats: {
      originalStatements: input.length,
      compactedStatements: queries.length,
      originalBodyBytes: bytes(JSON.stringify({ batch: input })),
      bodyBytes,
      groupedGuards,
      groupedWrites,
      reorderedBlocks,
      unchangedStatements,
      largestSqlBytes,
      largestBindingBytes,
      largestParameterCount,
    },
  }
}
