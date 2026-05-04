import { matches, matchParticipants, playerRatings, playerRatingSeeds, players } from '@civup/db'
import { DEFAULT_MU, DEFAULT_SIGMA, displayRating } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { recalculateLeaderboardMode, reportMatch } from '../../src/services/match/index.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import { createLobby, getTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = 'p1'
const VILLAIN_ID = 'p2'
const ALLY_ID = 'p3'
const OPPONENT_ID = 'p4'
const INITIAL_SEED_MU = DEFAULT_MU + 10
const SEED_STEP_MU = (INITIAL_SEED_MU - DEFAULT_MU) / 10

describe('match seed fade', () => {
  const directTerminalOptions = { allowDirectTerminalWriteForTests: true }

  test('recalculation removes one seed step after each new-bot game', async () => {
    const { db: decayDb, sqlite: decaySqlite } = await createTestDatabase()
    const { db: permanentDb, sqlite: permanentSqlite } = await createTestDatabase()

    try {
      await seedDuelPlayers(decayDb)
      await seedDuelPlayers(permanentDb)
      await seedSeedRow(decayDb, 10)
      await seedSeedRow(permanentDb, null)
      await seedCompletedDuel(decayDb, { matchId: 'm1', completedAt: NOW, isOld: false })
      await seedCompletedDuel(permanentDb, { matchId: 'm1', completedAt: NOW, isOld: false })

      const decayResult = await recalculateLeaderboardMode(decayDb, 'duel')
      const permanentResult = await recalculateLeaderboardMode(permanentDb, 'duel')
      expect('error' in decayResult).toBe(false)
      expect('error' in permanentResult).toBe(false)
      if ('error' in decayResult || 'error' in permanentResult) return

      const decayParticipant = await loadParticipant(decayDb, 'm1', HERO_ID)
      const permanentParticipant = await loadParticipant(permanentDb, 'm1', HERO_ID)
      const decayRating = await loadPlayerRating(decayDb, HERO_ID)

      expect(decayParticipant?.ratingBeforeMu).toBeCloseTo((permanentParticipant?.ratingBeforeMu ?? 0) - SEED_STEP_MU, 6)
      expect(decayParticipant?.ratingAfterMu).toBeCloseTo((permanentParticipant?.ratingAfterMu ?? 0) - SEED_STEP_MU, 6)
      expect(displayRating(decayParticipant?.ratingAfterMu ?? 0, decayParticipant?.ratingAfterSigma ?? 0)).toBeGreaterThan(
        displayRating(decayParticipant?.ratingBeforeMu ?? 0, decayParticipant?.ratingBeforeSigma ?? 0),
      )
      expect(decayRating?.gamesPlayed).toBe(1)
      expect(decayRating?.lastPlayedAt).toBe(NOW)
    }
    finally {
      decaySqlite.close()
      permanentSqlite.close()
    }
  })

  test('old matches change ratings without consuming seed fade or visible games', async () => {
    const { db: decayDb, sqlite: decaySqlite } = await createTestDatabase()
    const { db: permanentDb, sqlite: permanentSqlite } = await createTestDatabase()

    try {
      await seedDuelPlayers(decayDb)
      await seedDuelPlayers(permanentDb)
      await seedSeedRow(decayDb, 10)
      await seedSeedRow(permanentDb, null)
      await seedCompletedDuel(decayDb, { matchId: 'old-1', completedAt: NOW, isOld: true })
      await seedCompletedDuel(permanentDb, { matchId: 'old-1', completedAt: NOW, isOld: true })

      const decayResult = await recalculateLeaderboardMode(decayDb, 'duel')
      const permanentResult = await recalculateLeaderboardMode(permanentDb, 'duel')
      expect('error' in decayResult).toBe(false)
      expect('error' in permanentResult).toBe(false)
      if ('error' in decayResult || 'error' in permanentResult) return

      const decayParticipant = await loadParticipant(decayDb, 'old-1', HERO_ID)
      const permanentParticipant = await loadParticipant(permanentDb, 'old-1', HERO_ID)
      const decayRating = await loadPlayerRating(decayDb, HERO_ID)
      const villainRating = await loadPlayerRating(decayDb, VILLAIN_ID)

      expect(decayParticipant?.ratingBeforeMu).toBeCloseTo(permanentParticipant?.ratingBeforeMu ?? 0, 6)
      expect(decayParticipant?.ratingAfterMu).toBeCloseTo(permanentParticipant?.ratingAfterMu ?? 0, 6)
      expect(decayRating?.gamesPlayed).toBe(0)
      expect(decayRating?.lastPlayedAt).toBeNull()
      expect(villainRating?.gamesPlayed).toBe(0)
      expect(villainRating?.lastPlayedAt).toBeNull()
    }
    finally {
      decaySqlite.close()
      permanentSqlite.close()
    }
  })

  test('reportMatch uses the live seed fade path', async () => {
    const { db: decayDb, sqlite: decaySqlite } = await createTestDatabase()
    const { db: permanentDb, sqlite: permanentSqlite } = await createTestDatabase()
    const decayKv = createTestKv()

    try {
      await seedDuelPlayers(decayDb)
      await seedDuelPlayers(permanentDb)
      await seedSeedRow(decayDb, 10)
      await seedSeedRow(permanentDb, null)
      await seedActiveDuel(decayDb, 'active-1', NOW)
      await seedCompletedDuel(permanentDb, { matchId: 'completed-1', completedAt: NOW, isOld: false })

      const decayResult = await reportMatch(decayDb, decayKv, {
        matchId: 'active-1',
        reporterId: HERO_ID,
        placements: `<@${HERO_ID}>`,
      }, directTerminalOptions)
      const permanentResult = await recalculateLeaderboardMode(permanentDb, 'duel')

      expect('error' in decayResult).toBe(false)
      expect('error' in permanentResult).toBe(false)
      if ('error' in decayResult || 'error' in permanentResult) return

      const decayParticipant = decayResult.participants.find(participant => participant.playerId === HERO_ID)
      const permanentParticipant = await loadParticipant(permanentDb, 'completed-1', HERO_ID)
      const decayRating = await loadPlayerRating(decayDb, HERO_ID)

      expect(decayParticipant?.ratingBeforeMu).toBeCloseTo(INITIAL_SEED_MU - SEED_STEP_MU, 6)
      expect(decayParticipant?.ratingAfterMu).toBeCloseTo((permanentParticipant?.ratingAfterMu ?? 0) - SEED_STEP_MU, 6)
      expect(displayRating(decayParticipant?.ratingAfterMu ?? 0, decayParticipant?.ratingAfterSigma ?? 0)).toBeGreaterThan(
        displayRating(decayParticipant?.ratingBeforeMu ?? 0, decayParticipant?.ratingBeforeSigma ?? 0),
      )
      expect(decayRating?.gamesPlayed).toBe(1)
    }
    finally {
      decaySqlite.close()
      permanentSqlite.close()
    }
  })

  test('incremental live seed fade report matches boundary recalculation after prior games', async () => {
    const { db: incrementalDb, sqlite: incrementalSqlite } = await createTestDatabase()
    const { db: replayDb, sqlite: replaySqlite } = await createTestDatabase()
    const incrementalKv = createTestKv()

    try {
      await seedDuelPlayers(incrementalDb)
      await seedDuelPlayers(replayDb)
      await seedSeedRow(incrementalDb, 10)
      await seedSeedRow(replayDb, 10)

      await seedCompletedDuel(incrementalDb, { matchId: 'm1', completedAt: NOW - 10_000, isOld: false })
      await seedCompletedDuel(replayDb, { matchId: 'm1', completedAt: NOW - 10_000, isOld: false })

      const incrementalInit = await recalculateLeaderboardMode(incrementalDb, 'duel')
      const replayInit = await recalculateLeaderboardMode(replayDb, 'duel')
      expect('error' in incrementalInit).toBe(false)
      expect('error' in replayInit).toBe(false)
      if ('error' in incrementalInit || 'error' in replayInit) return

      await seedActiveDuel(incrementalDb, 'm2', NOW)
      await seedCompletedDuel(replayDb, { matchId: 'm2', completedAt: NOW, isOld: false })

      const incrementalResult = await reportMatch(incrementalDb, incrementalKv, {
        matchId: 'm2',
        reporterId: HERO_ID,
        placements: `<@${HERO_ID}>`,
      }, directTerminalOptions)
      const replayResult = await recalculateLeaderboardMode(replayDb, 'duel', {
        fromMatchId: 'm2',
        includeFromMatch: true,
      })

      expect('error' in incrementalResult).toBe(false)
      expect('error' in replayResult).toBe(false)
      if ('error' in incrementalResult || 'error' in replayResult) return

      const incrementalHero = await loadParticipant(incrementalDb, 'm2', HERO_ID)
      const replayHero = await loadParticipant(replayDb, 'm2', HERO_ID)
      const incrementalVillain = await loadParticipant(incrementalDb, 'm2', VILLAIN_ID)
      const replayVillain = await loadParticipant(replayDb, 'm2', VILLAIN_ID)
      expectParticipantRatingSnapshotsToMatch(incrementalHero, replayHero)
      expectParticipantRatingSnapshotsToMatch(incrementalVillain, replayVillain)

      const incrementalHeroRating = await loadPlayerRating(incrementalDb, HERO_ID)
      const replayHeroRating = await loadPlayerRating(replayDb, HERO_ID)
      const incrementalVillainRating = await loadPlayerRating(incrementalDb, VILLAIN_ID)
      const replayVillainRating = await loadPlayerRating(replayDb, VILLAIN_ID)
      expectPlayerRatingsToMatch(incrementalHeroRating, replayHeroRating)
      expectPlayerRatingsToMatch(incrementalVillainRating, replayVillainRating)
    }
    finally {
      incrementalSqlite.close()
      replaySqlite.close()
    }
  })

  test('reportMatch populates 2v2 rating snapshots when duo uses live seed fade', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: HERO_ID, displayName: HERO_ID, avatarUrl: null, createdAt: NOW },
        { id: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, createdAt: NOW },
        { id: ALLY_ID, displayName: ALLY_ID, avatarUrl: null, createdAt: NOW },
        { id: OPPONENT_ID, displayName: OPPONENT_ID, avatarUrl: null, createdAt: NOW },
      ]).onConflictDoNothing()

      await db.insert(playerRatingSeeds).values({
        playerId: HERO_ID,
        mode: 'duo',
        mu: INITIAL_SEED_MU,
        sigma: DEFAULT_SIGMA,
        eligibleForRanked: false,
        fadeGamesRemaining: 10,
        source: 'manual-role',
        note: 'Legion',
        createdAt: NOW,
        updatedAt: NOW,
      })

      await db.insert(matches).values({
        id: 'duo-active-1',
        gameMode: '2v2',
        status: 'active',
        isOld: false,
        createdAt: NOW,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({ completedAt: NOW }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'duo-active-1', playerId: HERO_ID, team: 0, civId: 'babylon-hammurabi', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'duo-active-1', playerId: ALLY_ID, team: 0, civId: 'rome-trajan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'duo-active-1', playerId: VILLAIN_ID, team: 1, civId: 'greece-gorgo', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'duo-active-1', playerId: OPPONENT_ID, team: 1, civId: 'china-yongle', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'duo-active-1',
        reporterId: HERO_ID,
        placements: '<@p1>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.participants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const storedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'duo-active-1'))

      expect(storedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const duoRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duo'))

      expect(duoRatings).toHaveLength(4)
    }
    finally {
      sqlite.close()
    }
  })

  test('retrying a broken completed match repairs missing rating snapshots', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelPlayers(db)
      await seedSeedRow(db, 10)
      await seedCompletedDuel(db, { matchId: 'completed-broken', completedAt: NOW, isOld: false })

      const result = await reportMatch(db, kv, {
        matchId: 'completed-broken',
        reporterId: HERO_ID,
        placements: `<@${HERO_ID}>`,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.idempotent).toBe(true)
      expect(result.participants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const storedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'completed-broken'))

      expect(storedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      expect(duelRatings).toHaveLength(2)
    }
    finally {
      sqlite.close()
    }
  })

  test('reportMatch repairs an earlier completed match with missing seed-fade snapshots', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelPlayers(db)
      await seedSeedRow(db, 10)
      await seedCompletedDuel(db, { matchId: 'broken-old', completedAt: NOW - 10_000, isOld: false })
      await seedActiveDuel(db, 'active-rollback', NOW)

      const result = await reportMatch(db, kv, {
        matchId: 'active-rollback',
        reporterId: HERO_ID,
        placements: `<@${HERO_ID}>`,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const [reportedMatch] = await db
        .select()
        .from(matches)
        .where(eq(matches.id, 'active-rollback'))
        .limit(1)

      expect(reportedMatch?.status).toBe('completed')
      expect(reportedMatch?.completedAt).not.toBeNull()

      const reportedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'active-rollback'))
      expect(reportedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const repairedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'broken-old'))

      expect(repairedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('seeded report repairs missing snapshots before marking SessionDO reported', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelPlayers(db)
      await seedSeedRow(db, 10)
      await seedCompletedDuel(db, { matchId: 'broken-old', completedAt: NOW - 10_000, isOld: false })

      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: HERO_ID,
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: HERO_ID, displayName: HERO_ID, avatarUrl: null, joinedAt: NOW }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, [HERO_ID, VILLAIN_ID], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: HERO_ID, displayName: HERO_ID, avatarUrl: null, joinedAt: NOW },
          { playerId: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, joinedAt: NOW },
        ],
      })
      const draftingLobby = await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
      })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: NOW })
      await db.update(matches).set({
        status: 'active',
        draftData: JSON.stringify({
          completedAt: NOW,
          state: {
            seats: [
              { playerId: HERO_ID, displayName: HERO_ID, avatarUrl: null, team: 0 },
              { playerId: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, team: 1 },
            ],
          },
        }),
      }).where(eq(matches.id, lobby.id))

      const result = await reportMatch(db, kv, {
        matchId: lobby.id,
        reporterId: HERO_ID,
        placements: `<@${HERO_ID}>`,
      }, {
        sessionNamespace: runtime.sessionNamespace,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('reported')
      expect((await db.select().from(matches).where(eq(matches.id, lobby.id)).limit(1))[0]?.status).toBe('completed')
      const reportedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, lobby.id))
      expect(reportedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
      const repairedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'broken-old'))
      expect(repairedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
      expect(draftingLobby?.id).toBe(lobby.id)
    }
    finally {
      sqlite.close()
    }
  })

  test('seeded report terminal failure rolls back D1 when SessionDO remains active', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelPlayers(db)
      await seedSeedRow(db, 10)

      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: HERO_ID,
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: HERO_ID, displayName: HERO_ID, avatarUrl: null, joinedAt: NOW }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, [HERO_ID, VILLAIN_ID], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: HERO_ID, displayName: HERO_ID, avatarUrl: null, joinedAt: NOW },
          { playerId: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, joinedAt: NOW },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
      })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: NOW })
      await db.update(matches).set({
        status: 'active',
        draftData: JSON.stringify({
          completedAt: NOW,
          state: {
            seats: [
              { playerId: HERO_ID, displayName: HERO_ID, avatarUrl: null, team: 0 },
              { playerId: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, team: 1 },
            ],
          },
        }),
      }).where(eq(matches.id, lobby.id))

      const result = await reportMatch(db, kv, {
        matchId: lobby.id,
        reporterId: HERO_ID,
        placements: `<@${HERO_ID}>`,
      }, {
        sessionNamespace: failTerminalLifecycleForSession(runtime.sessionNamespace, lobby.id),
      })

      expect('error' in result).toBe(true)
      if (!('error' in result)) return
      expect(result.error).toContain('terminal lifecycle failed')
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('active')

      const [rolledBackMatch] = await db.select().from(matches).where(eq(matches.id, lobby.id)).limit(1)
      expect(rolledBackMatch?.status).toBe('active')
      expect(rolledBackMatch?.completedAt).toBeNull()

      const rolledBackParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, lobby.id))
      expect(rolledBackParticipants.every(participant => participant.placement == null && participant.ratingBeforeMu == null && participant.ratingAfterMu == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('boundary recalculation works with live seed fade without replaying the full ladder', async () => {
    const { db: boundaryDb, sqlite: boundarySqlite } = await createTestDatabase()
    const { db: fullDb, sqlite: fullSqlite } = await createTestDatabase()

    try {
      await seedDuelPlayers(boundaryDb)
      await seedDuelPlayers(fullDb)
      await seedSeedRow(boundaryDb, 10)
      await seedSeedRow(fullDb, 10)

      await seedCompletedDuel(boundaryDb, { matchId: 'm1', completedAt: NOW - 10_000, isOld: false })
      await seedCompletedDuel(fullDb, { matchId: 'm1', completedAt: NOW - 10_000, isOld: false })

      const initialBoundaryReplay = await recalculateLeaderboardMode(boundaryDb, 'duel')
      const initialFullReplay = await recalculateLeaderboardMode(fullDb, 'duel')
      expect('error' in initialBoundaryReplay).toBe(false)
      expect('error' in initialFullReplay).toBe(false)
      if ('error' in initialBoundaryReplay || 'error' in initialFullReplay) return

      await seedCompletedDuel(boundaryDb, { matchId: 'm2', completedAt: NOW, isOld: false })
      await seedCompletedDuel(fullDb, { matchId: 'm2', completedAt: NOW, isOld: false })

      const boundaryReplay = await recalculateLeaderboardMode(boundaryDb, 'duel', {
        fromMatchId: 'm2',
        includeFromMatch: true,
      })
      const fullReplay = await recalculateLeaderboardMode(fullDb, 'duel')

      expect('error' in boundaryReplay).toBe(false)
      expect('error' in fullReplay).toBe(false)
      if ('error' in boundaryReplay || 'error' in fullReplay) return

      expect(boundaryReplay.matchIds).toEqual(['m2'])
      expect(fullReplay.matchIds).toEqual(['m1', 'm2'])

      const boundaryM2 = await loadParticipant(boundaryDb, 'm2', HERO_ID)
      const fullM2 = await loadParticipant(fullDb, 'm2', HERO_ID)
      const boundaryHero = await loadPlayerRating(boundaryDb, HERO_ID)
      const fullHero = await loadPlayerRating(fullDb, HERO_ID)
      const boundaryVillain = await loadPlayerRating(boundaryDb, VILLAIN_ID)
      const fullVillain = await loadPlayerRating(fullDb, VILLAIN_ID)

      expect(boundaryM2?.ratingBeforeMu).toBeCloseTo(fullM2?.ratingBeforeMu ?? 0, 6)
      expect(boundaryM2?.ratingAfterMu).toBeCloseTo(fullM2?.ratingAfterMu ?? 0, 6)
      expect(boundaryHero?.mu).toBeCloseTo(fullHero?.mu ?? 0, 6)
      expect(boundaryHero?.gamesPlayed).toBe(fullHero?.gamesPlayed)
      expect(boundaryHero?.wins).toBe(fullHero?.wins)
      expect(boundaryVillain?.mu).toBeCloseTo(fullVillain?.mu ?? 0, 6)
      expect(boundaryVillain?.gamesPlayed).toBe(fullVillain?.gamesPlayed)
    }
    finally {
      boundarySqlite.close()
      fullSqlite.close()
    }
  })
})

async function seedDuelPlayers(db: Awaited<ReturnType<typeof createTestDatabase>>['db']): Promise<void> {
  await db.insert(players).values([
    { id: HERO_ID, displayName: HERO_ID, avatarUrl: null, createdAt: NOW },
    { id: VILLAIN_ID, displayName: VILLAIN_ID, avatarUrl: null, createdAt: NOW },
  ]).onConflictDoNothing()
}

function failTerminalLifecycleForSession(namespace: DurableObjectNamespace, sessionId: string): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return namespace.idFromName(name)
    },
    get(id: DurableObjectId) {
      const stub = namespace.get(id)
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          if (String(id) === sessionId && new URL(request.url).pathname === '/commands/session-lifecycle') {
            return Promise.resolve(new Response(JSON.stringify({ error: 'terminal lifecycle failed' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }))
          }
          return stub.fetch(request)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

async function seedSeedRow(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  fadeGamesRemaining: number | null,
): Promise<void> {
  await db.insert(playerRatingSeeds).values({
    playerId: HERO_ID,
    mode: 'duel',
    mu: INITIAL_SEED_MU,
    sigma: DEFAULT_SIGMA,
    eligibleForRanked: false,
    fadeGamesRemaining,
    source: 'manual-role',
    note: 'Legion',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function seedCompletedDuel(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: { matchId: string, completedAt: number, isOld: boolean },
): Promise<void> {
  await db.insert(matches).values({
    id: input.matchId,
    gameMode: '1v1',
    status: 'completed',
    isOld: input.isOld,
    createdAt: input.completedAt - 1_000,
    completedAt: input.completedAt,
    seasonId: null,
    draftData: null,
  })
  await db.insert(matchParticipants).values([
    { matchId: input.matchId, playerId: HERO_ID, team: 0, civId: 'babylon-hammurabi', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: input.matchId, playerId: VILLAIN_ID, team: 1, civId: 'rome-trajan', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function seedActiveDuel(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  createdAt: number,
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    gameMode: '1v1',
    status: 'active',
    isOld: false,
    createdAt,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: createdAt }),
  })
  await db.insert(matchParticipants).values([
    { matchId, playerId: HERO_ID, team: 0, civId: 'babylon-hammurabi', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId, playerId: VILLAIN_ID, team: 1, civId: 'rome-trajan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function loadParticipant(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
  playerId: string,
) {
  const [row] = await db
    .select()
    .from(matchParticipants)
    .where(and(
      eq(matchParticipants.matchId, matchId),
      eq(matchParticipants.playerId, playerId),
    ))
    .limit(1)
  return row ?? null
}

async function loadPlayerRating(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  playerId: string,
) {
  const [row] = await db
    .select()
    .from(playerRatings)
    .where(and(
      eq(playerRatings.playerId, playerId),
      eq(playerRatings.mode, 'duel'),
    ))
    .limit(1)
  return row ?? null
}

function expectParticipantRatingSnapshotsToMatch(
  actual: Awaited<ReturnType<typeof loadParticipant>>,
  expected: Awaited<ReturnType<typeof loadParticipant>>,
): void {
  expect(actual?.ratingBeforeMu).toBeCloseTo(expected?.ratingBeforeMu ?? 0, 6)
  expect(actual?.ratingBeforeSigma).toBeCloseTo(expected?.ratingBeforeSigma ?? 0, 6)
  expect(actual?.ratingAfterMu).toBeCloseTo(expected?.ratingAfterMu ?? 0, 6)
  expect(actual?.ratingAfterSigma).toBeCloseTo(expected?.ratingAfterSigma ?? 0, 6)
}

function expectPlayerRatingsToMatch(
  actual: Awaited<ReturnType<typeof loadPlayerRating>>,
  expected: Awaited<ReturnType<typeof loadPlayerRating>>,
): void {
  expect(actual?.mu).toBeCloseTo(expected?.mu ?? 0, 6)
  expect(actual?.sigma).toBeCloseTo(expected?.sigma ?? 0, 6)
  expect(actual?.gamesPlayed).toBe(expected?.gamesPlayed)
  expect(actual?.wins).toBe(expected?.wins)
}
