import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb, matches, matchParticipants } from '@civup/db'
import { calibratePublicRatings } from '@civup/rating'
import { getRankedRoleConfig } from '../../src/services/ranked/roles.ts'
import { CUTOVER_SCOPES, openingPlayers, prepareSeasonCutover } from '../../src/services/season/cutover.ts'
import { prepareSeasonFinalization } from '../../src/services/season/finalization.ts'
import { prepareSeasonReport, runAtomicSeasonBatch } from '../../src/services/season/report.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('the guarded cutover preserves lifetime evidence and history, freezes both seasons, and finalizes without touching the new season', async () => {
  const { sqlite } = await createTestDatabase()
  const db = createDb(createSqliteD1Database(sqlite))
  try {
    sqlite.exec(
      "UPDATE rating_maintenance SET state = 'paused', generation = 1; INSERT INTO seasons(id, season_number, name, starts_at, soft_reset, active) VALUES('old', 1, 'Old', 0, 0, 1)",
    )
    for (let index = 0; index < 8; index++) {
      sqlite
        .prepare('INSERT INTO players(id, display_name, created_at) VALUES (?, ?, 0)')
        .run(`p${index}`, `Player ${index}`)
      for (const mode of CUTOVER_SCOPES)
        sqlite
          .prepare(
            'INSERT INTO player_ratings(player_id, mode, mu, sigma, games_played, wins, effective_games, last_played_at) VALUES (?, ?, ?, 3, 40, 20, 40, 100)',
          )
          .run(`p${index}`, mode, 10 + index * 4)
    }
    const source = {
      generation: 1,
      season: sqlite.prepare('SELECT * FROM seasons').get() as any,
      ratings: sqlite.prepare('SELECT * FROM player_ratings ORDER BY player_id, mode').all() as any[],
      closingTiers: {},
    }
    const players = openingPlayers(source)
    const calibrations = CUTOVER_SCOPES.map(scope =>
      calibratePublicRatings({
        version: `next-${scope}`,
        scope,
        sourceDigest: 'snapshot',
        qualifiedHiddenScores: players.filter(row => row.mode === scope).map(row => row.hiddenScore),
      }),
    )
    const plan = prepareSeasonCutover(source, {
      seasonId: 'next',
      seasonNumber: 2,
      name: 'Next',
      cutoff: 1000,
      resetFactor: 0.5,
      sourceDigest: 'snapshot',
      calibrations,
    })
    const apply = (statements: string[]) => {
      sqlite.exec('BEGIN')
      try {
        for (const statement of statements) sqlite.exec(statement)
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    }
    sqlite.exec("UPDATE player_ratings SET effective_games = 41 WHERE player_id = 'p0'")
    expect(() => apply(plan.statements)).toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM public_rating_seeds').get()).toEqual({ n: 0 })
    sqlite.exec("UPDATE player_ratings SET effective_games = 40 WHERE player_id = 'p0'")
    apply(plan.statements)
    const before = sqlite.prepare('SELECT * FROM player_ratings ORDER BY player_id, mode').all()
    expect((before[0] as any).effective_games).toBe(40)
    expect((before[0] as any).public_rating).toBeNumber()
    expect(
      sqlite
        .prepare("SELECT count(*) AS n FROM season_rating_states WHERE season_id = 'old' AND public_rating IS NULL")
        .get(),
    ).toEqual({ n: 48 })
    await db.insert(matches).values({ id: 'late', gameMode: '1v1', status: 'active', createdAt: 500, seasonId: 'old' })
    await db.insert(matchParticipants).values([
      { matchId: 'late', playerId: 'p0', team: 0, placement: 1 },
      { matchId: 'late', playerId: 'p1', team: 1, placement: 2 },
    ])
    const [lateMatch] = await db.select().from(matches).where(eq(matches.id, 'late'))
    const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'late'))
    const late = await prepareSeasonReport(db, {
      match: lateMatch!,
      participants,
      acceptedAt: 2000,
      now: 2000,
      opponentTierByPlayerId: new Map(),
    })
    await runAtomicSeasonBatch(db, late.queries)
    expect(sqlite.prepare('SELECT * FROM player_ratings ORDER BY player_id, mode').all()).toEqual(before)
    const finalization = prepareSeasonFinalization({
      source,
      config: await getRankedRoleConfig(createTestKv(), 'test'),
      generation: 1,
      season: sqlite.prepare("SELECT * FROM seasons WHERE id = 'old'").get() as any,
      states: sqlite.prepare("SELECT * FROM season_rating_states WHERE season_id = 'old'").all() as any[],
      reports: sqlite.prepare('SELECT * FROM season_match_reports').all() as any[],
      events: sqlite.prepare('SELECT * FROM player_rating_events').all() as any[],
      now: plan.reportingDeadline,
    })
    apply(finalization.statements)
    apply(finalization.verification)
    const saved = sqlite
      .prepare("SELECT revision, finalized_at, payload FROM season_standing_snapshots WHERE season_id = 'old'")
      .get() as { revision: number; finalized_at: number; payload: string }
    expect(saved.finalized_at).toBe(plan.reportingDeadline)
    expect(saved.revision).toBe(
      (
        sqlite.prepare("SELECT standings_revision AS revision FROM seasons WHERE id = 'old'").get() as {
          revision: number
        }
      ).revision,
    )
    const standings = JSON.parse(saved.payload)
    expect(standings.modes.filter((row: { mode: string }) => row.mode === 'duel')).toHaveLength(8)
    expect(
      standings.modes.find((row: { playerId: string; mode: string }) => row.playerId === 'p7' && row.mode === 'duel')
        .position,
    ).toBe(1)
    expect(standings.peaks.length).toBeGreaterThan(0)
    expect(sqlite.prepare('SELECT * FROM player_ratings ORDER BY player_id, mode').all()).toEqual(before)
    expect(sqlite.prepare("SELECT count(*) AS n FROM public_rating_seeds WHERE season_id = 'next'").get()).toEqual({
      n: 48,
    })
    expect(() => apply(plan.statements)).toThrow()
  } finally {
    sqlite.close()
  }
})
