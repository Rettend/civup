import type { CloudflareD1Statement } from '../../../../scripts/cloudflare-client.ts'
import type { ReplaySqlQuery, ReplaySqlSourceRange, ReplaySqlTrigger } from '../../scripts/season-cancellation-sql.ts'
import type { Database as SqliteDatabase } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  matches,
  divisionRankPolicies,
  matchParticipants,
  playerRatingEvents,
  playerRatings,
  players,
  publicRatingCalibrations,
  seasonPeakDivisionRanks,
  seasonPeakRanks,
  seasonRatingConfigurations,
  seasonRatingStates,
  seasons,
} from '@civup/db'
import {
  calibratePublicRatings,
  ONE_DIVISION_RANK_POLICY_VERSION,
  PUBLIC_RATING_BANDS,
  PUBLIC_RATING_FORMULA_VERSION,
} from '@civup/rating'
import {
  assertSeasonCancellationCompactionTriggers,
  compactSeasonCancellationSql,
} from '../../scripts/season-cancellation-sql.ts'
import { replayPostconditions } from '../../scripts/season-cancellation-verification.ts'
import { initializeQualityCheckpointPage } from '../../src/services/ranked/quality-checkpoint.ts'
import { prepareSeasonBulkCancellation, prepareSeasonReplay } from '../../src/services/season/replay.ts'
import { prepareSeasonReport, seasonSourceGuard } from '../../src/services/season/report.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

function compile(queries: readonly unknown[]): ReplaySqlQuery[] {
  return queries.map(query => (query as { toSQL(): ReplaySqlQuery }).toSQL())
}

function apply(sqlite: SqliteDatabase, queries: readonly ReplaySqlQuery[]) {
  sqlite.transaction(() => {
    for (const query of queries) {
      sqlite
        .prepare(query.sql)
        .all(
          ...(query.params.map(value => (typeof value === 'boolean' ? Number(value) : value)) as (
            | string
            | number
            | null
          )[]),
        )
    }
  })()
}

function snapshot(sqlite: SqliteDatabase) {
  const tables = sqlite.prepare("select name from sqlite_master where type='table' order by name").all() as {
    name: string
  }[]
  return tables.map(({ name }) => ({
    name,
    rows: sqlite.prepare(`select rowid, * from "${name.replaceAll('"', '""')}" order by rowid`).all(),
  }))
}

const triggers = (sqlite: SqliteDatabase) =>
  sqlite.prepare("select name,tbl_name,sql from sqlite_master where type='trigger'").all() as ReplaySqlTrigger[]

function expectCoverage(ranges: ReplaySqlSourceRange[], length: number) {
  const covered = ranges.flatMap(range =>
    range.sources.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, offset) => start + offset)),
  )
  expect(covered.toSorted((left, right) => left - right)).toEqual(Array.from({ length }, (_, index) => index))
}

async function fixture() {
  const result = await createTestDatabase()
  result.sqlite.exec('update public_rating_decay_policies set enabled_at=9000000000000')
  await result.db.insert(players).values(['p', 'q', 'r'].map(id => ({ id, displayName: id, createdAt: 0 })))
  await result.db.insert(seasons).values({
    id: 's9',
    seasonNumber: 9,
    name: 'Season 9',
    startsAt: 1000,
    active: true,
    ratingSystem: 'rp',
    isolatedRatingsEnabled: true,
  })
  const db = new Proxy(result.db, {
    get(target, property) {
      if (property === 'batch') return async (queries: unknown[]) => apply(result.sqlite, compile(queries))
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...result, db }
}

async function replayFixture(withDivisions = false) {
  const result = await fixture()
  const { db, sqlite } = result
  for (const scope of ['global', 'duel']) {
    const calibration = calibratePublicRatings({
      scope,
      version: `test-${scope}`,
      sourceDigest: 'fixture',
      qualifiedHiddenScores: Array.from({ length: 101 }, (_, index) => index),
    })
    await db.insert(publicRatingCalibrations).values({ ...calibration, calibration, createdAt: 1000 })
    await db.insert(seasonRatingConfigurations).values({
      seasonId: 's9',
      mode: scope,
      formulaVersion: PUBLIC_RATING_FORMULA_VERSION,
      calibrationVersion: calibration.version,
    })
  }
  for (const [index, id] of ['prefix', 'target', 'tail'].entries()) {
    const at = 1100 + index * 100
    await db.insert(matches).values({
      id,
      seasonId: 's9',
      gameMode: '1v1',
      createdAt: at,
      status: 'active',
      draftData: JSON.stringify({ completedAt: at + 1 }),
    })
    await db
      .insert(matchParticipants)
      .values(['p', 'q'].map((playerId, team) => ({ matchId: id, playerId, team, placement: team + 1 })))
    const [match] = await db.select().from(matches).where(eq(matches.id, id))
    const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id))
    const report = await prepareSeasonReport(db, {
      match: match!,
      participants,
      acceptedAt: at + 1,
      now: at + 1,
      opponentTierByPlayerId: new Map(),
    })
    apply(sqlite, compile(report.queries))
    await db
      .update(matches)
      .set({ status: 'completed', completedAt: at + 1 })
      .where(eq(matches.id, id))
  }
  if (withDivisions) {
    await db.insert(divisionRankPolicies).values({
      guildId: 'guild',
      seasonId: 's9',
      version: ONE_DIVISION_RANK_POLICY_VERSION,
      phase: 'active',
      updatedAt: 1400,
      configJson: JSON.stringify({
        preparation: {
          unrankedRoleId: 'unranked',
          roleIdsByMinimum: Object.fromEntries(PUBLIC_RATING_BANDS.map(band => [band.minimum, `role-${band.minimum}`])),
        },
      }),
    })
    for (const player of ['p', 'q']) {
      let complete = false
      for (let page = 0; page < 10 && !complete; page++)
        complete = await initializeQualityCheckpointPage(db, 'guild', player, 1400)
      expect(complete).toBe(true)
    }
    apply(sqlite, compile((await prepareSeasonReplay(db, 's9', undefined, 1400)).queries))
    // Exercise the optional checkpoint cleanup branch and different source
    // revisions without changing the already verified quality ledger.
    sqlite.exec("update division_rank_sources set revision=revision+7 where player_id='p'")
    sqlite.exec("update division_rank_sources set revision=revision+29 where player_id='q'")
  }
  const plan = await prepareSeasonReplay(db, 's9', { matchId: 'target', cancel: true }, 1500)
  return { ...result, queries: compile(plan.queries) }
}

test('postconditions verify actual replay output and detect altered summaries and events', async () => {
  const { sqlite, queries } = await replayFixture()
  try {
    const checks = replayPostconditions(queries as CloudflareD1Statement[], ['target', 'tail'])
    const mismatches = () =>
      checks.reduce(
        (sum, check) => sum + (sqlite.query(check.sql).get(...check.params!) as { mismatches: number }).mismatches,
        0,
      )
    expect(mismatches()).toBeGreaterThan(0)
    apply(sqlite, compactSeasonCancellationSql(queries).queries)
    expect(mismatches()).toBe(0)
    sqlite.exec("update player_ratings set public_rating=public_rating+1 where player_id='p'")
    expect(mismatches()).toBeGreaterThan(0)
    sqlite.exec("update player_ratings set public_rating=public_rating-1 where player_id='p'")
    expect(mismatches()).toBe(0)
    sqlite.exec("delete from player_rating_events where match_id='tail'")
    expect(mismatches()).toBeGreaterThan(0)
  } finally {
    sqlite.close()
  }
})

test('a real prepared cancellation has identical rows, doubles and trigger effects in one transaction', async () => {
  const fixtures = await Promise.all([replayFixture(), replayFixture()])
  try {
    const original = fixtures[0]!
    const compact = fixtures[1]!
    expect(snapshot(original.sqlite)).toEqual(snapshot(compact.sqlite))
    const result = compactSeasonCancellationSql(original.queries)
    expect(result.fitsLimits).toBe(true)
    expect(result.stats.groupedGuards).toBeGreaterThanOrEqual(5)
    expect(result.stats.groupedWrites).toBeGreaterThan(0)
    expect(result.queries.length).toBeLessThan(original.queries.length)
    expectCoverage(result.sourceRanges, original.queries.length)
    assertSeasonCancellationCompactionTriggers(triggers(compact.sqlite))
    apply(original.sqlite, original.queries)
    apply(compact.sqlite, result.queries)
    expect(snapshot(compact.sqlite)).toEqual(snapshot(original.sqlite))
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('a real cancellation with quality checkpoints preserves every table, revision, dirty row and dynamic applied-role comparison', async () => {
  const fixtures = await Promise.all([replayFixture(true), replayFixture(true)])
  try {
    const queries = fixtures[0]!.queries
    const result = compactSeasonCancellationSql(queries)
    expect(result.fitsLimits).toBe(true)
    expect(result.stats.reorderedBlocks).toBe(3)
    expect(result.queries.length).toBeLessThan(40)
    expectCoverage(result.sourceRanges, queries.length)
    for (const value of fixtures) {
      assertSeasonCancellationCompactionTriggers(triggers(value.sqlite))
      // Delivery can change an applied role without changing the source guard.
      // Pending must compare the actual row, not the captured insert binding.
      value.sqlite.exec("update division_rank_states set applied_role_id=desired_role_id where player_id='q'")
    }
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    const sources = fixtures[1]!.sqlite
      .prepare('select player_id,revision from division_rank_sources order by player_id')
      .all() as { player_id: string; revision: number }[]
    const saved = fixtures[1]!.sqlite
      .prepare('select player_id,source_revision from division_rank_states order by player_id')
      .all()
    expect(saved).toEqual(sources.map(row => ({ player_id: row.player_id, source_revision: row.revision })))
    expect(sources[0]!.revision).not.toBe(sources[1]!.revision)
    expect(fixtures[1]!.sqlite.prepare('select * from division_quality_dirty').all()).toEqual([])
    expect(fixtures[1]!.sqlite.prepare('select projection_revision from division_rank_policies').get()).toEqual({
      projection_revision: 3,
    })
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('bulk cancellation with no surviving incoming credits preserves deletion-only player blocks', async () => {
  const fixtures = await Promise.all([replayFixture(true), replayFixture(true)])
  try {
    const queries = compile(
      (await prepareSeasonBulkCancellation(fixtures[0]!.db, 's9', ['prefix', 'target', 'tail'], 1500)).queries,
    )
    const result = compactSeasonCancellationSql(queries)
    expect(result.fitsLimits).toBe(true)
    expect(result.stats.reorderedBlocks).toBe(2)
    expectCoverage(result.sourceRanges, queries.length)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    expect(fixtures[1]!.sqlite.prepare('select * from division_quality_credits').all()).toEqual([])
    expect(fixtures[1]!.sqlite.prepare('select * from division_quality_dirty').all()).toEqual([])
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('nested credit payloads keep lexical int64 values, exact doubles and repeated-key UPSERT order', async () => {
  const fixtures = await Promise.all([replayFixture(true), replayFixture(true)])
  try {
    const queries = fixtures[0]!.queries
      .filter(row => row.sql.startsWith('insert into "division_quality_credits"'))
      .map(row => ({ sql: row.sql, params: [...row.params] }))
    for (const query of queries)
      query.params[2] = `[ {"playerId":"${query.params[1]}","matchId":"tail","at":9007199254740993,"effectiveGames":1.0000000000000002,"highRankWins":0.5,"eliteWins":0}, {"playerId":"${query.params[1]}","matchId":"tail","at":9007199254740993,"effectiveGames":49.41666666666668,"highRankWins":1.35,"eliteWins":5e-324} ]`
    const result = compactSeasonCancellationSql(queries)
    expect(result.queries).toHaveLength(1)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    expect(
      fixtures[1]!.sqlite
        .prepare(
          "select cast(at as text) as at, effective_games, high_rank_wins, elite_wins from division_quality_credits where player_id='p' and match_id='tail'",
        )
        .get(),
    ).toEqual({
      at: '9007199254740993',
      effective_games: 49.41666666666668,
      high_rank_wins: 1.35,
      elite_wins: Number.MIN_VALUE,
    })
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test.each([
  "update matches set draft_data='null' where id='tail'",
  "update match_participants set placement=2 where match_id='tail' and player_id='p'",
  "update season_match_reports set opponent_tiers='null' where match_id='tail'",
  "update season_rating_states set public_rating=public_rating+1 where player_id='q' and mode='global'",
  "insert into player_ratings(player_id,mode) values ('p','unexpected-mode')",
  "update player_rating_events set public_rating_after=public_rating_after+1 where match_id='prefix' and player_id='p' and mode='duel'",
  "update season_rating_checkpoints set summary='null' where match_id='prefix' and player_id='q' and mode='global'",
  "update division_rank_sources set revision=revision+1 where player_id='q'",
])('all original source guards still reject stale input and roll back (%s)', async mutation => {
  const fixtures = await Promise.all([replayFixture(true), replayFixture(true)])
  try {
    const original = fixtures[0]!.queries
    const compact = compactSeasonCancellationSql(original)
    for (const [index, value] of fixtures.entries()) {
      value.sqlite.exec(mutation)
      const before = snapshot(value.sqlite)
      const prefix = {
        sql: 'insert into players(id,display_name,created_at) values (?,?,?)',
        params: ['sentinel', 'sentinel', 0],
      }
      expect(() => apply(value.sqlite, [prefix, ...(index === 0 ? original : compact.queries)])).toThrow()
      expect(snapshot(value.sqlite)).toEqual(before)
    }
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('trigger verification rejects extra, missing and changed deployed effects', async () => {
  const { sqlite } = await fixture()
  try {
    const catalog = triggers(sqlite)
    expect(() => assertSeasonCancellationCompactionTriggers(catalog)).not.toThrow()
    const relevant = catalog.find(row => row.name === 'division_rank_event_insert')!
    expect(() => assertSeasonCancellationCompactionTriggers(catalog.filter(row => row !== relevant))).toThrow()
    expect(() => assertSeasonCancellationCompactionTriggers([...catalog, relevant])).toThrow()
    expect(() =>
      assertSeasonCancellationCompactionTriggers(
        catalog.map(row =>
          row === relevant
            ? Object.assign({}, row, { sql: row.sql!.replace("NEW.mode = 'global'", "NEW.mode = 'duel'") })
            : row,
        ),
      ),
    ).toThrow()
    sqlite.exec(`create trigger unexpected_snapshot after update on match_participants begin
      update division_rank_sources set revision=revision+1 where player_id=NEW.player_id;
    end`)
    expect(() => assertSeasonCancellationCompactionTriggers(triggers(sqlite))).toThrow()
  } finally {
    sqlite.close()
  }
})

test.each(['Match_Participants', 'Division_Rank_States', 'Seasons'])(
  'trigger verification rejects additional direct or transitive effects on mixed-case table names (%s)',
  async table => {
    const { sqlite } = await fixture()
    try {
      expect(() => assertSeasonCancellationCompactionTriggers(triggers(sqlite))).not.toThrow()
      sqlite.exec(`create trigger unexpected_mixed_case after update on "${table}" begin select 1; end`)
      const catalog = triggers(sqlite)
      expect(catalog.find(row => row.name === 'unexpected_mixed_case')!.tbl_name).toBe(table)
      expect(() => assertSeasonCancellationCompactionTriggers(catalog)).toThrow()
    } finally {
      sqlite.close()
    }
  },
)

test('reordered event pairs require trigger verification when binding limits prevent grouping', async () => {
  const { sqlite, queries } = await replayFixture()
  try {
    const input = queries
      .filter(
        row =>
          (row.sql.startsWith('insert into "player_rating_events"') && row.params[2] !== 'global') ||
          row.sql.startsWith('update "match_participants" set "rating_before_mu"'),
      )
      .slice(0, 4)
    expect(input).toHaveLength(4)
    // Every original binding fits, but neither grouped JSON payload can fit.
    const maxBindingBytes = Math.max(
      ...input.flatMap(query =>
        query.params.filter(value => typeof value === 'string').map(value => new TextEncoder().encode(value).length),
      ),
    )
    const result = compactSeasonCancellationSql(input, { maxBindingBytes })
    expect(result.fitsLimits).toBe(true)
    expect(result.stats.reorderedBlocks).toBe(1)
    expect(result.stats.groupedWrites).toBe(0)
    expect(result.requiresTriggerVerification).toBe(true)
    expect(result.queries).toEqual([input[0], input[2], input[1], input[3]])
    expectCoverage(result.sourceRanges, input.length)
    const unchanged = compactSeasonCancellationSql(input.slice(0, 2), { maxBindingBytes })
    expect(unchanged.stats.reorderedBlocks).toBe(0)
    expect(unchanged.stats.groupedWrites).toBe(0)
    expect(unchanged.requiresTriggerVerification).toBe(false)
  } finally {
    sqlite.close()
  }
})

test('reordered season/live pairs require trigger verification without grouping under default limits', async () => {
  const { sqlite, queries } = await replayFixture()
  try {
    const input = queries
      .filter(
        row =>
          row.sql.startsWith('insert into "season_rating_states"') ||
          row.sql.startsWith('insert into "player_ratings"'),
      )
      .slice(0, 4)
      .map(query => ({ sql: query.sql, params: [...query.params] }))
    expect(input).toHaveLength(4)
    // Valid JSON text fits each original binding, but two rows exceed the ceiling.
    const decay = `{}${' '.repeat(1_000_500)}`
    for (const query of input) {
      if (query.sql.startsWith('insert into "season_rating_states"')) query.params[7] = query.params[21] = decay
      else query.params[16] = query.params[33] = decay
    }
    const result = compactSeasonCancellationSql(input)
    expect(result.fitsLimits).toBe(true)
    expect(result.stats.reorderedBlocks).toBe(1)
    expect(result.stats.groupedWrites).toBe(0)
    expect(result.requiresTriggerVerification).toBe(true)
    expect(result.queries).toEqual([input[0], input[2], input[1], input[3]])
    expectCoverage(result.sourceRanges, input.length)
  } finally {
    sqlite.close()
  }
})

test.each(['snapshot', 'rating-key', 'overlapping-division', 'event-key'] as const)(
  'mutated generated blocks fall back without losing source coverage or sequential behavior (%s)',
  async mutation => {
    const fixtures = await Promise.all([replayFixture(true), replayFixture(true)])
    try {
      const queries = fixtures[0]!.queries.map(row => ({ sql: row.sql, params: [...row.params] }))
      if (mutation === 'snapshot') {
        const update = queries.find(row => row.sql.startsWith('update "match_participants" set "rating_before_mu"'))!
        update.params[0] = (update.params[0] as number) + 1
      } else if (mutation === 'rating-key') {
        const summary = queries.find(row => row.sql.startsWith('insert into "player_ratings"'))!
        summary.params[0] = summary.params[17] = 'r'
      } else if (mutation === 'overlapping-division') {
        const start = queries.findIndex(row => row.sql.startsWith('delete from "division_quality_dirty"'))
        const end = queries.findIndex(
          (row, index) => index > start && row.sql.startsWith('update "division_rank_policies"'),
        )
        queries.splice(end, 0, ...queries.slice(start, end))
      } else {
        const start = queries.findIndex(row => row.sql.startsWith('insert into "player_rating_events"'))
        queries.splice(start + 2, 0, ...queries.slice(start, start + 2))
      }
      const result = compactSeasonCancellationSql(queries)
      expect(result.stats.reorderedBlocks).toBe(2)
      expectCoverage(result.sourceRanges, queries.length)
      if (mutation === 'event-key') {
        for (const [index, value] of fixtures.entries()) {
          const before = snapshot(value.sqlite)
          expect(() => apply(value.sqlite, index === 0 ? queries : result.queries)).toThrow()
          expect(snapshot(value.sqlite)).toEqual(before)
        }
      } else {
        apply(fixtures[0]!.sqlite, queries)
        apply(fixtures[1]!.sqlite, result.queries)
        expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
      }
    } finally {
      for (const value of fixtures) value.sqlite.close()
    }
  },
)

test('a guard between generated event pairs remains at its original effect boundary', async () => {
  const fixtures = await Promise.all([replayFixture(), replayFixture()])
  try {
    const queries = [...fixtures[0]!.queries]
    const first = queries.findIndex(row => row.sql.startsWith('insert into "player_rating_events"'))
    const snapshotUpdate = queries[first + 1]!
    const p = snapshotUpdate.params
    const [guard] = compile([
      seasonSourceGuard(
        fixtures[0]!.db,
        sql`exists(select 1 from match_participants where match_id=${p[4]} and player_id=${p[5]} and rating_before_mu=${p[0]})`,
      ),
    ])
    queries.splice(first + 2, 0, guard!)
    const result = compactSeasonCancellationSql(queries)
    const guardIndex = result.queries.findIndex(query => query === guard)
    expect(guardIndex).toBeGreaterThan(0)
    expect(result.sourceRanges[guardIndex]!.sources).toEqual([{ start: first + 2, end: first + 3 }])
    expectCoverage(result.sourceRanges, queries.length)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('reordered season/live pairs preserve repeated keys and inactive-season trigger counts', async () => {
  const fixtures = await Promise.all([replayFixture(), replayFixture()])
  try {
    const queries = fixtures[0]!.queries.filter(
      row =>
        row.sql.startsWith('insert into "season_rating_states"') || row.sql.startsWith('insert into "player_ratings"'),
    )
    const duplicate = queries.slice(0, 2).map(query => ({ sql: query.sql, params: [...query.params] }))
    duplicate[0]!.params[3] = duplicate[0]!.params[17] = 1.0000000000000002
    duplicate[1]!.params[2] = duplicate[1]!.params[19] = 1.0000000000000002
    queries.push(...duplicate)
    const result = compactSeasonCancellationSql(queries)
    expect(result.stats.reorderedBlocks).toBe(1)
    expect(result.queries).toHaveLength(2)
    expectCoverage(result.sourceRanges, queries.length)
    for (const value of fixtures) {
      value.sqlite.exec('update seasons set active=0')
      assertSeasonCancellationCompactionTriggers(triggers(value.sqlite))
    }
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    expect(fixtures[1]!.sqlite.prepare('select standings_revision from seasons').get()).toEqual({
      standings_revision: 1 + queries.length / 2,
    })
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('a stale guard rolls back earlier writes in both original and compact batches', async () => {
  for (const compact of [false, true]) {
    const { sqlite, queries } = await replayFixture()
    try {
      sqlite.exec("update match_participants set civ_id='null' where match_id='tail' and player_id='q'")
      const before = snapshot(sqlite)
      const prefix = {
        sql: 'insert into players(id, display_name, created_at) values (?, ?, ?)',
        params: ['sentinel', 'sentinel', 0],
      }
      const selected = compact ? compactSeasonCancellationSql(queries).queries : queries
      expect(() => apply(sqlite, [prefix, ...selected])).toThrow('malformed JSON')
      expect(snapshot(sqlite)).toEqual(before)
    } finally {
      sqlite.close()
    }
  }
})

test('combined guards keep NULL failures and distinguish SQL NULL from JSON text', async () => {
  const { db, sqlite } = await fixture()
  try {
    sqlite.exec(
      "insert into division_rank_policies(guild_id, season_id, version, phase, config_json, updated_at) values ('g','s9','v','active','{}',0)",
    )
    sqlite.exec(
      "insert into division_rank_states(guild_id, player_id, result_json) values ('g','p','null'),('g','q',NULL)",
    )
    const guard = (player: string, revision: number | null, result: string | null) =>
      seasonSourceGuard(
        db,
        sql`coalesce((select revision from division_rank_sources where player_id=${player}),0)=${revision}
        and (select result_json from division_rank_states where guild_id=${'g'} and player_id=${player}) is ${result}`,
      )
    const valid = compile([guard('p', 0, 'null'), guard('q', 0, null)])
    const compact = compactSeasonCancellationSql(valid)
    expect(compact.queries).toHaveLength(1)
    apply(sqlite, valid)
    apply(sqlite, compact.queries)
    for (const invalid of [
      compile([guard('p', 0, null), guard('q', 0, null)]),
      compile([guard('p', null, 'null'), guard('q', 0, null)]),
    ]) {
      expect(compactSeasonCancellationSql(invalid).queries).toHaveLength(1)
      expect(() => apply(sqlite, invalid)).toThrow()
      expect(() => apply(sqlite, compactSeasonCancellationSql(invalid).queries)).toThrow()
    }
  } finally {
    sqlite.close()
  }
})

function ratingQueries(db: Awaited<ReturnType<typeof fixture>>['db']) {
  const numbers = [
    8.333333333333334,
    27.544347193308962,
    49.41666666666668,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    1e-300,
    1.0000000000000002,
    1_000_000_000_000_000_100,
  ]
  return numbers.map((mu, index) => {
    const row = {
      playerId: index % 2 ? 'q' : 'p',
      mode: `scope-${index}`,
      mu,
      sigma: 8.333333333333334,
      gamesPlayed: 10,
      wins: 5,
      importedGames: 0,
      effectiveGames: 1.35,
      winsVsTier1: 1,
      winsVsTier2Plus: 2,
      effectiveWinsVsTier1: 0.5,
      effectiveWinsVsTier2Plus: 49.41666666666668,
      lastPlayedAt: index % 2 ? null : 1500,
      updatedAt: index % 2 ? 1500 : null,
      publicRating: index % 2 ? null : 818.186997567931,
      publicBadge: index % 2 ? null : 800,
      publicDecay: null,
    }
    const [query] = compile([
      db
        .insert(playerRatings)
        .values(row)
        .onConflictDoUpdate({ target: [playerRatings.playerId, playerRatings.mode], set: row }),
    ])
    const params = [...query!.params]
    // These are already compiled SQL text bindings, not objects to reserialize.
    const decay = [null, 'null', '{ "number": 1.35, "value": null }', '"null"'][index % 4]!
    params[16] = decay
    params[33] = decay
    return { sql: query!.sql, params }
  })
}

test('JSON rows preserve IEEE doubles, nullable fields, JSON text and duplicate UPSERT ordering', async () => {
  const fixtures = await Promise.all([fixture(), fixture()])
  try {
    const queries = ratingQueries(fixtures[0]!.db)
    const duplicate = { ...queries[0]!, params: [...queries[0]!.params] }
    duplicate.params[2] = duplicate.params[19] = 1.0000000000000002
    queries.push(duplicate)
    const result = compactSeasonCancellationSql(queries)
    expect(result.queries).toHaveLength(1)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    const rows = fixtures[1]!.sqlite
      .query('select mu, typeof(mu) as storage, public_decay from player_ratings order by mode')
      .all() as { mu: number; storage: string; public_decay: string | null }[]
    expect(rows[0]!.mu).toBe(1.0000000000000002)
    expect(rows.every(row => row.storage === 'real')).toBe(true)
    expect(rows[0]!.public_decay).toBeNull()
    expect(rows[1]!.public_decay).toBe('null')
    expect(rows[2]!.public_decay).toBe('{ "number": 1.35, "value": null }')
    expect(rows[3]!.public_decay).toBe('"null"')
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('conditional peak UPSERTs retain improving-only behavior, repeated keys, timestamps and triggers', async () => {
  const fixtures = await Promise.all([fixture(), fixture()])
  try {
    for (const value of fixtures) value.sqlite.exec('update seasons set active=0')
    const db = fixtures[0]!.db
    const division = [700, 1000, 900, 1000, 1100].map((minimum, index) => {
      const row = { seasonId: 's9', playerId: 'p', minimum, achievedAt: 1500 + index }
      return db
        .insert(seasonPeakDivisionRanks)
        .values(row)
        .onConflictDoUpdate({
          target: [seasonPeakDivisionRanks.seasonId, seasonPeakDivisionRanks.playerId],
          set: { minimum, achievedAt: row.achievedAt },
          setWhere: sql`${seasonPeakDivisionRanks.minimum}<${minimum}`,
        })
    })
    const ranks = [4, 2, 3, 2, 1].map((rank, index) => {
      const row = {
        seasonId: 's9',
        playerId: 'p',
        tier: `tier${rank}`,
        sourceMode: index % 2 ? null : 'duel',
        achievedAt: 1600 + index,
      }
      return db
        .insert(seasonPeakRanks)
        .values(row)
        .onConflictDoUpdate({
          target: [seasonPeakRanks.seasonId, seasonPeakRanks.playerId],
          set: { tier: row.tier, sourceMode: row.sourceMode, achievedAt: row.achievedAt },
          setWhere: sql`cast(substr(${seasonPeakRanks.tier},5) as integer)>${rank}`,
        })
    })
    const queries = compile([...division, ...ranks])
    const result = compactSeasonCancellationSql(queries)
    expect(result.queries).toHaveLength(2)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    expect(fixtures[1]!.sqlite.query('select minimum, achieved_at from season_peak_division_ranks').get()).toEqual({
      minimum: 1100,
      achieved_at: 1504,
    })
    expect(fixtures[1]!.sqlite.query('select tier, achieved_at from season_peak_ranks').get()).toEqual({
      tier: 'tier1',
      achieved_at: 1604,
    })
    expect(fixtures[1]!.sqlite.query('select standings_revision from seasons').get()).toEqual({ standings_revision: 7 })
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('season state UPSERTs keep managed_tier on conflicts and replace nullable fields and JSON evidence', async () => {
  const fixtures = await Promise.all([fixture(), fixture()])
  try {
    for (const value of fixtures) {
      value.sqlite.exec('update seasons set active=0')
      value.sqlite.exec(
        "insert into season_rating_states(season_id,player_id,mode,mu,sigma,managed_tier,evidence,updated_at) values ('s9','p','global',25,8,'tier2','{}',0)",
      )
    }
    const queries = compile(
      [0, 1, 2].map(index => {
        const row = {
          seasonId: 's9',
          playerId: index === 1 ? 'q' : 'p',
          mode: 'global',
          mu: 25.084023119071695 + index,
          sigma: 7.782216564669934,
          publicRating: index ? 821.5486965286383 : null,
          publicBadge: index ? 800 : null,
          publicDecay: null,
          seasonGames: index,
          seasonWins: index,
          evidence: { effectiveGames: 1.35, wins: index },
          lastPlayedAt: index ? 1500 : null,
          revision: index,
          updatedAt: 1500,
        }
        return fixtures[0]!.db
          .insert(seasonRatingStates)
          .values(row)
          .onConflictDoUpdate({
            target: [seasonRatingStates.seasonId, seasonRatingStates.playerId, seasonRatingStates.mode],
            set: row,
          })
      }),
    )
    const result = compactSeasonCancellationSql(queries)
    expect(result.queries).toHaveLength(1)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    expect(
      fixtures[1]!.sqlite.query("select managed_tier from season_rating_states where player_id='p'").get(),
    ).toEqual({ managed_tier: 'tier2' })
    expect(
      fixtures[1]!.sqlite.query("select managed_tier from season_rating_states where player_id='q'").get(),
    ).toEqual({ managed_tier: null })
    expect(fixtures[1]!.sqlite.query('select standings_revision from seasons').get()).toEqual({ standings_revision: 5 })
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('interleaved event writes and per-player source-revision queries are not moved or rewritten', async () => {
  const fixtures = await Promise.all([fixture(), fixture()])
  try {
    for (const value of fixtures) {
      value.sqlite.exec(
        "insert into matches(id,game_mode,status,season_id,created_at) values ('event','1v1','completed','s9',1100)",
      )
      value.sqlite.exec(
        "insert into division_rank_policies(guild_id,season_id,version,phase,config_json,updated_at) values ('g','s9','v','active','{}',0)",
      )
      value.sqlite.exec("insert into division_rank_sources(player_id,revision) values ('p',7),('q',29)")
      value.sqlite.exec(`create table replay_effects(kind text, player_id text, mode text);
        create trigger replay_event_effect after insert on player_rating_events begin
          insert into replay_effects values ('event', new.player_id, new.mode);
        end;
        create trigger replay_state_effect after update on division_rank_states begin
          insert into replay_effects values ('state', new.player_id, new.result_json);
        end`)
    }
    const events = (player: string) =>
      compile(
        ['duel', 'global'].map(mode =>
          fixtures[0]!.db.insert(playerRatingEvents).values({
            matchId: 'event',
            playerId: player,
            mode,
            gameMode: '1v1',
            ratingBeforeMu: 25,
            ratingBeforeSigma: 8.333333333333334,
            ratingAfterMu: 27.544347193308962,
            ratingAfterSigma: 8.012364992269568,
            gamesDelta: 1,
            winsDelta: 1,
            importedGamesDelta: 0,
            effectiveGamesDelta: 1,
            winsVsTier1Delta: 0,
            winsVsTier2PlusDelta: 0,
            effectiveWinsVsTier1Delta: 0,
            effectiveWinsVsTier2PlusDelta: 0,
            matchCreatedAt: 1100,
            matchCompletedAt: null,
            updatedAt: 1500,
            seasonId: 's9',
            publicSequence: null,
            publicRatingBefore: null,
            publicRatingAfter: null,
            publicFormulaVersion: null,
            publicCalibrationVersion: null,
            publicDecayBefore: null,
            publicDecayAfter: null,
            publicDecayDelta: 0,
          }),
        ),
      )
    const state = (player: string): ReplaySqlQuery => ({
      sql: 'insert into "division_rank_states" ("guild_id", "player_id", "source_revision", "result_json", "next_check_at", "desired_role_id", "applied_role_id", "pending", "projection_pending", "retry_at", "last_error") values (?, ?, coalesce((select revision from division_rank_sources where player_id=?),0), ?, ?, ?, ?, ?, ?, ?, null) on conflict ("division_rank_states"."guild_id", "division_rank_states"."player_id") do update set "source_revision" = coalesce((select revision from division_rank_sources where player_id=?),0), "result_json" = ?, "next_check_at" = ?, "desired_role_id" = ?, "pending" = "division_rank_states"."applied_role_id" is not ?, "projection_pending" = ?, "retry_at" = ?, "last_error" = ?',
      params: [
        'g',
        player,
        player,
        'null',
        null,
        'role',
        null,
        1,
        1,
        0,
        player,
        'null',
        null,
        'role',
        'role',
        1,
        0,
        null,
      ],
    })
    const firstState = state('p')
    const secondState = state('q')
    const queries = [...events('p'), firstState, ...events('q'), secondState]
    const result = compactSeasonCancellationSql(queries)
    expect(result.queries).toHaveLength(4)
    expect(result.queries[1]).toBe(firstState)
    expect(result.queries[3]).toBe(secondState)
    apply(fixtures[0]!.sqlite, queries)
    apply(fixtures[1]!.sqlite, result.queries)
    expect(snapshot(fixtures[1]!.sqlite)).toEqual(snapshot(fixtures[0]!.sqlite))
    expect(
      fixtures[1]!.sqlite.query('select player_id, source_revision from division_rank_states order by player_id').all(),
    ).toEqual([
      { player_id: 'p', source_revision: 8 },
      { player_id: 'q', source_revision: 30 },
    ])
    expect(fixtures[1]!.sqlite.query('select * from replay_effects order by rowid').all()).toEqual(
      fixtures[0]!.sqlite.query('select * from replay_effects order by rowid').all(),
    )
  } finally {
    for (const value of fixtures) value.sqlite.close()
  }
})

test('unknown SQL and unequal insert/update bindings remain intact, with no grouping across them', async () => {
  const { db, sqlite } = await fixture()
  try {
    const values = ratingQueries(db)
    const mismatch = { ...values[1]!, params: [...values[1]!.params] }
    mismatch.params[19] = 123
    const unknown = { sql: 'select random() as value, ? as literal', params: ['?'] }
    const differentlySpelled = { ...values[0]!, sql: values[0]!.sql.replace('insert into', 'INSERT INTO') }
    const input = [values[0]!, unknown, values[0]!, mismatch, differentlySpelled, values[2]!, values[3]!]
    const result = compactSeasonCancellationSql(input)
    expect(result.queries).toHaveLength(6)
    for (let index = 0; index < 5; index++) expect(result.queries[index]).toBe(input[index])
    expect(result.sourceRanges.at(-1)).toEqual({ sources: [{ start: 5, end: 7 }], kind: 'write' })
  } finally {
    sqlite.close()
  }
})

test('binding-sized groups stay in one returned batch and oversized originals are reported, not split or dropped', async () => {
  const { db, sqlite } = await fixture()
  try {
    const queries = ratingQueries(db)
    const result = compactSeasonCancellationSql(queries, { maxBindingBytes: 500, maxStatements: 1, maxBodyBytes: 100 })
    expect(result.queries.length).toBeGreaterThan(1)
    expect(result.stats.largestBindingBytes).toBeLessThanOrEqual(500)
    expect(result.fitsLimits).toBe(false)
    expect(result.violations).toEqual([
      'The atomic batch exceeds the statement limit.',
      'The atomic batch exceeds the request body byte limit.',
    ])
    const oversized = { sql: 'select ?', params: ['😀'.repeat(26)] }
    const unchanged = compactSeasonCancellationSql([oversized], { maxBindingBytes: 100 })
    expect(unchanged.queries[0]).toBe(oversized)
    expect(unchanged.stats.largestBindingBytes).toBe(104)
    expect(unchanged.fitsLimits).toBe(false)
    expect(() => compactSeasonCancellationSql([], { maxStatements: 0 })).toThrow()
    expect(() => compactSeasonCancellationSql([], { maxParameters: 101 })).toThrow()
  } finally {
    sqlite.close()
  }
})
