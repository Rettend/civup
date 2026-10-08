import type { Database } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  divisionRankPolicies,
  divisionRankStates,
  divisionQualityCredits,
  matches,
  matchParticipants,
  playerRatingEvents,
  playerRatings,
  players,
  publicRatingCalibrations,
  publicRatingSeeds,
  seasonMatchReports,
  seasonRatingCheckpoints,
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
import { initializeQualityCheckpointPage } from '../../src/services/ranked/quality-checkpoint.ts'
import { prepareSeasonBulkCancellation, prepareSeasonReplay } from '../../src/services/season/replay.ts'
import { prepareSeasonReport, runAtomicSeasonBatch } from '../../src/services/season/report.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

async function setup() {
  const fixture = await createTestDatabase()
  const db = new Proxy(fixture.db, {
    get(target, property) {
      if (property === 'batch') {
        return async (queries: Array<{ run(): unknown }>) =>
          fixture.sqlite.transaction(() => queries.map(query => query.run()))()
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database
  await db
    .insert(players)
    .values(['p', 'q', 'r', 's', 't', 'u', 'v', 'w'].map(id => ({ id, displayName: id, createdAt: 0 })))
  await db.insert(seasons).values({
    id: 's9',
    seasonNumber: 9,
    name: 'Season 9',
    startsAt: 1000,
    active: true,
    ratingSystem: 'rp',
    isolatedRatingsEnabled: true,
  })
  for (const scope of ['global', 'duel', 'ffa']) {
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
  let sequence = 0
  async function play(id: string, first = 'p', second = 'q', gameMode = '1v1') {
    const at = 1000 + ++sequence * 100
    await db.insert(matches).values({
      id,
      seasonId: 's9',
      gameMode,
      createdAt: at,
      status: 'active',
      draftData: JSON.stringify({ completedAt: at + 1, permanentAlly: false }),
    })
    await db
      .insert(matchParticipants)
      .values([first, second].map((playerId, team) => ({ matchId: id, playerId, team, placement: team + 1 })))
    const [match] = await db.select().from(matches).where(eq(matches.id, id))
    const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id))
    await runAtomicSeasonBatch(
      db,
      (
        await prepareSeasonReport(db, {
          match: match!,
          participants,
          acceptedAt: at + 1,
          now: at + 1,
          opponentTierByPlayerId: new Map([[second, 'tier1']]),
        })
      ).queries,
    )
    await db
      .update(matches)
      .set({ status: 'completed', completedAt: at + 1 })
      .where(eq(matches.id, id))
  }
  function snapshot() {
    return [
      'matches',
      'match_participants',
      'season_match_reports',
      'player_rating_events',
      'public_rating_seeds',
      'season_rating_states',
      'player_ratings',
      'season_rating_checkpoints',
      'division_rank_states',
      'division_quality_credits',
    ].map(table => fixture.sqlite.query(`select * from ${table} order by 1, 2, 3`).all())
  }
  return { db, sqlite: fixture.sqlite, play, snapshot }
}

describe('bulk season cancellation replay', () => {
  test('replays overlapping closures once across modes, using each chain prefix and leaving unrelated rows untouched', async () => {
    const fixtures = await Promise.all([setup(), setup()])
    try {
      for (const { play } of fixtures) {
        await play('q-ffa-prefix', 'q', 'w', 'ffa')
        await play('duel-prefix')
        await play('r-ffa-prefix', 'r', 's', 'ffa')
        await play('unrelated-before', 'u', 'v')
        await play('target-a')
        await play('late-prefix', 's', 't', 'ffa')
        await play('target-b', 'r', 't', 'ffa')
        await play('merge', 'p', 'r', 'ffa')
        await play('tail', 'r', 'q')
        await play('transitive', 't', 'w')
        await play('unrelated-after', 'u', 'v')
      }
      const { db, snapshot } = fixtures[0]!
      const before = snapshot()
      const events = await db.select().from(playerRatingEvents)
      const checkpoints = await db.select().from(seasonRatingCheckpoints)
      const states = await db.select().from(seasonRatingStates)
      const live = await db.select().from(playerRatings)
      const seeds = await db.select().from(publicRatingSeeds)
      const replay = await prepareSeasonBulkCancellation(db, 's9', ['target-b', 'target-a'], 3000)
      expect(replay.matchIds).toEqual(['target-a', 'target-b', 'merge', 'tail', 'transitive'])
      expect(new Set(replay.matchIds).size).toBe(replay.matchIds.length)
      expect(snapshot()).toEqual(before)
      for (const query of replay.queries)
        expect((query as unknown as { toSQL(): { params: unknown[] } }).toSQL().params.length).toBeLessThanOrEqual(100)
      await runAtomicSeasonBatch(db, replay.queries)
      // Terminal lifecycle writes belong to the caller, as they do for single-match replay.
      for (const id of ['target-a', 'target-b'])
        await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, id))
      const affected = new Set(replay.matchIds)
      const afterEvents = await db.select().from(playerRatingEvents)
      expect(afterEvents.filter(row => !affected.has(row.matchId))).toEqual(
        events.filter(row => !affected.has(row.matchId)),
      )
      expect((await db.select().from(seasonRatingCheckpoints)).filter(row => !affected.has(row.matchId))).toEqual(
        checkpoints.filter(row => !affected.has(row.matchId)),
      )
      expect(afterEvents.filter(row => row.matchId.startsWith('target-'))).toHaveLength(0)
      expect(
        (await db.select().from(seasonMatchReports))
          .filter(row => row.matchId.startsWith('target-'))
          .map(row => row.cancelledAt),
      ).toEqual([3000, 3000])
      expect(
        (await db.select().from(matchParticipants))
          .filter(row => row.matchId.startsWith('target-'))
          .every(
            row =>
              row.placement == null &&
              row.ratingBeforeMu == null &&
              row.ratingBeforeSigma == null &&
              row.ratingAfterMu == null &&
              row.ratingAfterSigma == null,
          ),
      ).toBe(true)
      const untouched = (row: { playerId: string; mode: string }) =>
        ['s', 'u', 'v'].includes(row.playerId) || (['q', 'w'].includes(row.playerId) && row.mode === 'ffa')
      const afterStates = await db.select().from(seasonRatingStates)
      expect(afterStates.filter(untouched)).toEqual(states.filter(untouched))
      expect((await db.select().from(playerRatings)).filter(untouched)).toEqual(live.filter(untouched))
      for (const state of afterStates.filter(row => !untouched(row))) {
        expect(state.revision).toBe(
          states.find(old => old.playerId === state.playerId && old.mode === state.mode)!.revision + 1,
        )
      }
      expect(await db.select().from(publicRatingSeeds)).toEqual(seeds)
      await expect(prepareSeasonReplay(db, 's9', undefined, 3100)).resolves.toBeDefined()

      const sequential = fixtures[1]!.db
      for (const id of ['target-a', 'target-b']) {
        await runAtomicSeasonBatch(
          sequential,
          (await prepareSeasonReplay(sequential, 's9', { matchId: id, cancel: true }, 3000)).queries,
        )
        await sequential.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, id))
      }
      const sortEvents = (rows: typeof afterEvents) =>
        rows.sort((a, b) =>
          `${a.matchId}:${a.playerId}:${a.mode}`.localeCompare(`${b.matchId}:${b.playerId}:${b.mode}`),
        )
      expect(sortEvents(afterEvents)).toEqual(sortEvents(await sequential.select().from(playerRatingEvents)))
      expect(await db.select().from(playerRatings)).toEqual(await sequential.select().from(playerRatings))
    } finally {
      for (const { sqlite } of fixtures) sqlite.close()
    }
  })

  test('removes every target from overall quality and assigns divisions from the shared result', async () => {
    const { db, sqlite, play } = await setup()
    try {
      for (const id of ['one', 'two', 'three', 'four']) await play(id)
      await db.insert(divisionRankPolicies).values({
        guildId: 'guild',
        seasonId: 's9',
        version: ONE_DIVISION_RANK_POLICY_VERSION,
        phase: 'active',
        updatedAt: 2000,
        configJson: JSON.stringify({
          preparation: {
            unrankedRoleId: 'unranked',
            roleIdsByMinimum: Object.fromEntries(
              PUBLIC_RATING_BANDS.map(band => [band.minimum, `role-${band.minimum}`]),
            ),
          },
        }),
      })
      for (const id of ['p', 'q']) while (!(await initializeQualityCheckpointPage(db, 'guild', id, 2000))) {}
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', undefined, 2000)).queries)
      expect(await db.select().from(divisionQualityCredits)).toHaveLength(8)
      for (const state of await db.select().from(divisionRankStates))
        expect(JSON.parse(state.resultJson!).band).not.toBeNull()
      const replay = await prepareSeasonBulkCancellation(db, 's9', ['three', 'one'], 2000)
      expect(replay.matchIds).toEqual(['one', 'two', 'three', 'four'])
      await runAtomicSeasonBatch(db, replay.queries)
      const credits = await db.select().from(divisionQualityCredits)
      expect(credits).toHaveLength(4)
      expect(credits.every(row => ['two', 'four'].includes(row.matchId))).toBe(true)
      for (const state of await db.select().from(divisionRankStates)) {
        const result = JSON.parse(state.resultJson!)
        expect(result.band).toBeNull()
        expect(result.recent.effectiveGames).toBeCloseTo(2, 3)
        expect(state.desiredRoleId).toBe('unranked')
        expect(state.projectionPending).toBe(true)
      }
      expect((await db.select().from(seasonRatingStates)).every(row => row.seasonGames === 2)).toBe(true)
      expect((await db.select().from(playerRatings)).every(row => row.effectiveGames === 2)).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  test.each([
    { ids: [], error: 'Choose at least one match' },
    { ids: ['one'], cancelledAt: -1, error: 'The cancellation time is invalid.' },
    { ids: ['one'], cancelledAt: 1.5, error: 'The cancellation time is invalid.' },
    { ids: ['one', 'one'], error: 'Choose each match only once' },
    { ids: ['one', ''], error: 'Choose at least one match' },
    { ids: ['one', 'missing'], error: 'could not be found' },
    {
      ids: ['one', 'two'],
      mutation: "update matches set season_id=null where id='two'",
      error: 'Choose matches from this season',
    },
    {
      ids: ['one', 'two'],
      mutation: "update season_match_reports set season_id='s8' where match_id='two'",
      error: 'no recorded result',
    },
    {
      ids: ['one', 'two'],
      mutation: "update matches set status='active' where id='two'",
      error: 'Only completed rated matches',
    },
    {
      ids: ['one', 'two'],
      mutation: "update matches set game_mode='unknown' where id='two'",
      error: 'Only completed rated matches',
    },
    {
      ids: ['one', 'two'],
      mutation: "delete from season_match_reports where match_id='two'",
      error: 'no recorded result',
    },
    {
      ids: ['one', 'two'],
      mutation: "update season_match_reports set sequence=0 where match_id='two'",
      error: 'no recorded result',
    },
    {
      ids: ['one', 'two'],
      mutation: "update matches set status='cancelled' where id='two'; update seasons set active=0",
      error: 'already cancelled',
    },
    {
      ids: ['one', 'two'],
      mutation: "update season_match_reports set cancelled_at=1500 where match_id='two'",
      error: 'already cancelled',
    },
  ])(
    'rejects invalid targets without preparing writes: $error ($mutation)',
    async ({ ids, mutation, error, cancelledAt }) => {
      const { db, sqlite, play, snapshot } = await setup()
      try {
        await play('one')
        await play('two')
        await db.insert(seasons).values({ id: 's8', seasonNumber: 8, name: 'Season 8', startsAt: 0 })
        if (mutation) sqlite.exec(mutation)
        const before = snapshot()
        await expect(prepareSeasonBulkCancellation(db, 's9', ids, cancelledAt ?? 2000)).rejects.toThrow(error)
        expect(snapshot()).toEqual(before)
      } finally {
        sqlite.close()
      }
    },
  )

  test.each([
    {
      mutation: "delete from player_rating_events where match_id='two' and mode='global' and player_id='p'",
      error: 'recorded events',
    },
    {
      mutation:
        "update player_rating_events set public_rating_after=public_rating_after+1 where match_id='two' and mode='global' and player_id='p'",
      error: 'recorded events',
    },
    {
      mutation: "update season_rating_states set season_games=season_games+1 where player_id='q' and mode='global'",
      error: 'current summaries',
    },
    {
      mutation: "update player_ratings set wins=wins+1 where player_id='q' and mode='global'",
      error: 'Live and season summaries disagree',
    },
  ])('checks unchanged history for all targets before cancellation: $error', async ({ mutation, error }) => {
    const { db, sqlite, play, snapshot } = await setup()
    try {
      await play('one')
      await play('two')
      await play('later')
      sqlite.exec(mutation)
      const before = snapshot()
      await expect(prepareSeasonBulkCancellation(db, 's9', ['one', 'two'], 2000)).rejects.toThrow(error)
      expect(snapshot()).toEqual(before)
    } finally {
      sqlite.close()
    }
  })

  test('guards every target and rolls back the whole prepared batch when a target changes', async () => {
    const { db, sqlite, play, snapshot } = await setup()
    try {
      await play('one')
      await play('two')
      await play('later')
      const replay = await prepareSeasonBulkCancellation(db, 's9', ['one', 'two'], 2000)
      sqlite.exec("update match_participants set placement=2 where match_id='two' and player_id='p'")
      const before = snapshot()
      await expect(runAtomicSeasonBatch(db, replay.queries)).rejects.toThrow()
      expect(snapshot()).toEqual(before)
    } finally {
      sqlite.close()
    }
  })

  test('validates and guards the separate chain prefix of a later, disconnected target', async () => {
    const { db, sqlite, play, snapshot } = await setup()
    try {
      await play('prefix', 'r', 's', 'ffa')
      await play('one')
      await play('two', 'r', 's', 'ffa')
      const replay = await prepareSeasonBulkCancellation(db, 's9', ['one', 'two'], 2000)
      expect(replay.matchIds).toEqual(['one', 'two'])
      sqlite.exec(
        "update season_rating_checkpoints set summary=json_set(summary,'$.publicRating',0) where match_id='prefix' and player_id='r' and mode='global'",
      )
      const before = snapshot()
      await expect(prepareSeasonBulkCancellation(db, 's9', ['one', 'two'], 2000)).rejects.toThrow(
        'checkpoint does not match',
      )
      await expect(runAtomicSeasonBatch(db, replay.queries)).rejects.toThrow()
      expect(snapshot()).toEqual(before)
    } finally {
      sqlite.close()
    }
  })

  test('applies the existing correction window to every target', async () => {
    const { db, sqlite, play, snapshot } = await setup()
    try {
      await play('one')
      await play('two')
      const before = snapshot()
      await expect(prepareSeasonBulkCancellation(db, 's9', ['one', 'two'], 31 * 24 * 60 * 60 * 1000)).rejects.toThrow(
        'older than 30 days',
      )
      expect(snapshot()).toEqual(before)
    } finally {
      sqlite.close()
    }
  })

  test('one-target bulk cancellation preserves the single-change API result', async () => {
    const { db, sqlite, play } = await setup()
    try {
      await play('prefix')
      await play('target')
      await play('later')
      const single = await prepareSeasonReplay(db, 's9', { matchId: 'target', cancel: true }, 2000)
      const bulk = await prepareSeasonBulkCancellation(db, 's9', ['target'], 2000)
      expect(bulk.matchIds).toEqual(single.matchIds)
      await runAtomicSeasonBatch(db, bulk.queries)
      expect((await db.select().from(seasonRatingStates)).every(row => row.seasonGames === 2)).toBe(true)
      await expect(prepareSeasonReplay(db, 's9', undefined, 2100)).resolves.toBeDefined()
    } finally {
      sqlite.close()
    }
  })
})
