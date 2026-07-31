import { matchBans, matches, matchParticipants, players, scopedMatchPlayerCivStatContributions as matchPlayerCivStatContributions, scopedPlayerCivStats as playerCivStats, scopedPlayerRatingEvents as playerRatingEvents, scopedPlayerRatings as playerRatings, sessionDirectory, tournamentMatches, tournaments } from '@civup/db'
import { allLeaderIds, getLeaders } from '@civup/game'
import { buildLeaderboard, displayRating } from '@civup/rating'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { cancelMatchByModerator, correctMatchLeadersByModerator, createManualReportedMatch, recalculateLeaderboardMode, reportMatch, resolveMatchByModerator, substituteMatchPlayerByModerator } from '../../src/services/match/index.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand, runSessionTerminalLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import { createLobby, getTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const GUILD_ID = '111111111111111111'
const STATS_CONTEXT = createStatsContext(GUILD_ID, GUILD_ID)
const STATS_KEY = STATS_CONTEXT.statsKey
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function withStatsKey<T extends Record<string, unknown>>(rows: T[]): Array<T & { statsKey: typeof STATS_KEY }> {
  return rows.map(row => ({ ...row, statsKey: STATS_KEY }))
}

function allowDiscordMembershipLookup(): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch
}

function acceptingTerminalSessionNamespace(requestedSessionIds: string[]): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      requestedSessionIds.push(name)
      return name as unknown as DurableObjectId
    },
    get() {
      return {
        async fetch() {
          return Response.json({ record: { id: 'canonical-session', matchId: 'distinct-match', phase: 'cancelled' } })
        },
      } as DurableObjectStub
    },
  } as DurableObjectNamespace
}

describe('match moderation recalculation', () => {
  const directTerminalOptions = { allowDirectTerminalWriteForTests: true, primaryGuildId: GUILD_ID }

  test('creates a manual completed team match with leaders and ratings', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const result = await createManualReportedMatch(db, kv, {
        matchId: 'manual-2v2',
        guildId: GUILD_ID,
        primaryGuildId: GUILD_ID,
        mode: '2v2',
        reporterId: 'mod',
        reportedAt: 10_000,
        players: buildManualPlayers(getLeaders('live').slice(0, 4).map(leader => leader.id)),
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.match.status).toBe('completed')
      expect(JSON.parse(result.match.draftData ?? '{}').manualReport).toBe(true)
      expect(result.recalculatedMatchIds).toEqual(['manual-2v2'])

      const firstTeam = result.participants.filter(participant => participant.team === 0)
      const secondTeam = result.participants.filter(participant => participant.team === 1)
      expect(firstTeam).toHaveLength(2)
      expect(secondTeam).toHaveLength(2)
      expect(firstTeam.every(participant => participant.placement === 1)).toBe(true)
      expect(secondTeam.every(participant => participant.placement === 2)).toBe(true)
      expect(result.participants.every(participant => participant.civId && participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const ratingRows = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duo'))
      expect(ratingRows).toHaveLength(4)
      expect(ratingRows.every(row => row.gamesPlayed === 1)).toBe(true)
      const globalRatingRows = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'global'))
      expect(globalRatingRows).toHaveLength(4)
      expect(globalRatingRows.every(row => row.gamesPlayed === 1)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('creates a manual match with beta-only leaders as beta leader data', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const liveLeaderIds = new Set(getLeaders('live').map(leader => leader.id))
      const betaOnlyLeaderId = getLeaders('beta').find(leader => !liveLeaderIds.has(leader.id))?.id
      expect(typeof betaOnlyLeaderId).toBe('string')
      if (!betaOnlyLeaderId) return

      const liveLeaderIdsForMatch = getLeaders('live').slice(0, 3).map(leader => leader.id)
      const result = await createManualReportedMatch(db, kv, {
        matchId: 'manual-beta-leader',
        guildId: GUILD_ID,
        primaryGuildId: GUILD_ID,
        mode: '2v2',
        reporterId: 'mod',
        reportedAt: 10_000,
        players: buildManualPlayers([betaOnlyLeaderId, ...liveLeaderIdsForMatch]),
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(JSON.parse(result.match.draftData ?? '{}').leaderDataVersion).toBe('beta')
      expect(result.participants.map(participant => participant.civId)).toContain(betaOnlyLeaderId)
    }
    finally {
      sqlite.close()
    }
  })

  test('creates a manual odd-player FFA match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const result = await createManualReportedMatch(db, kv, {
        matchId: 'manual-ffa-9',
        guildId: GUILD_ID,
        primaryGuildId: GUILD_ID,
        mode: 'ffa',
        reporterId: 'mod',
        reportedAt: 10_000,
        players: buildManualPlayers(getLeaders('live').slice(0, 9).map(leader => leader.id)),
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.match.status).toBe('completed')
      expect(result.recalculatedMatchIds).toEqual(['manual-ffa-9'])
      expect(result.participants).toHaveLength(9)
      expect(result.participants.map(participant => participant.placement)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(result.participants.every(participant => participant.team == null)).toBe(true)
      const globalRatingRows = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'global'))
      expect(globalRatingRows).toHaveLength(9)
    }
    finally {
      sqlite.close()
    }
  })

  test('creates a manual Permanent Ally FFA match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const result = await createManualReportedMatch(db, kv, {
        matchId: 'manual-pa-ffa',
        guildId: GUILD_ID,
        primaryGuildId: GUILD_ID,
        mode: 'ffa',
        permanentAlly: true,
        reporterId: 'mod',
        reportedAt: 10_000,
        players: buildManualPlayers(getLeaders('live').slice(0, 8).map(leader => leader.id)),
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(JSON.parse(result.match.draftData ?? '{}').permanentAlly).toBe(true)
      expect(result.participants).toHaveLength(8)
      expect(result.participants.map(participant => participant.placement)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
      expect(result.participants.every(participant => participant.team == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolves a manual match without a session aggregate', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const created = await createManualReportedMatch(db, kv, {
        matchId: 'manual-resolve',
        guildId: GUILD_ID,
        primaryGuildId: GUILD_ID,
        mode: '2v2',
        reporterId: 'mod',
        reportedAt: 10_000,
        players: buildManualPlayers(getLeaders('live').slice(0, 4).map(leader => leader.id)),
      })
      expect('error' in created).toBe(false)
      if ('error' in created) return

      const resolved = await resolveMatchByModerator(db, kv, {
        matchId: 'manual-resolve',
        placements: '<@p3>',
        resolvedAt: 11_000,
      }, directTerminalOptions)

      expect('error' in resolved).toBe(false)
      if ('error' in resolved) return
      expect(resolved.recalculatedMatchIds).toEqual(['manual-resolve'])

      const p1 = resolved.participants.find(participant => participant.playerId === 'p1')
      const p3 = resolved.participants.find(participant => participant.playerId === 'p3')
      expect(p1?.placement).toBe(2)
      expect(p3?.placement).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('mod leader correction sets a reported participant to a live leader outside the original draft', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedThreeCompletedDuels(db)
      const leaderId = allLeaderIds.find(id => id !== 'rome' && id !== 'greece') ?? allLeaderIds[0]!

      const result = await correctMatchLeadersByModerator(db, {
        matchId: 'm1',
        playerId: 'p1',
        leaderId,
        correctedAt: 10_000,
      }, { primaryGuildId: GUILD_ID })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.corrections).toEqual([{ playerId: 'p1', previousCivId: 'rome', nextCivId: leaderId }])

      const p1 = result.participants.find(participant => participant.playerId === 'p1')
      const p2 = result.participants.find(participant => participant.playerId === 'p2')
      expect(p1?.civId).toBe(leaderId)
      expect(p1?.placement).toBe(1)
      expect(p2?.civId).toBe('greece')
      expect(result.recalculatedMatchIds).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('mod leader correction swaps two reported participants leaders', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedThreeCompletedDuels(db)

      const result = await correctMatchLeadersByModerator(db, {
        matchId: 'm1',
        playerId: 'p1',
        swapWithPlayerId: 'p2',
        correctedAt: 10_000,
      }, { primaryGuildId: GUILD_ID })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.corrections).toEqual([
        { playerId: 'p1', previousCivId: 'rome', nextCivId: 'greece' },
        { playerId: 'p2', previousCivId: 'greece', nextCivId: 'rome' },
      ])

      const p1 = result.participants.find(participant => participant.playerId === 'p1')
      const p2 = result.participants.find(participant => participant.playerId === 'p2')
      expect(p1?.civId).toBe('greece')
      expect(p2?.civId).toBe('rome')
      expect(p1?.ratingAfterMu).toBe(27)
      expect(p2?.ratingAfterMu).toBe(23)
    }
    finally {
      sqlite.close()
    }
  })

  test('mod player sub replaces a reported participant and removes stale ratings for the old player', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedCompletedDuelWithRatingEvents(db)
      allowDiscordMembershipLookup()

      const result = await substituteMatchPlayerByModerator(db, kv, {
        matchId: 'sub-duel',
        playerId: 'p1',
        subPlayer: { playerId: 'p3', displayName: 'P3', avatarUrl: null },
        correctedAt: 3_000,
      }, { primaryGuildId: GUILD_ID, discordToken: 'token' })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.recalculatedMatchIds).toEqual(['sub-duel'])
      expect(result.substitutions).toEqual([{ seatIndex: 0, previousPlayerId: 'p1', nextPlayerId: 'p3', team: 0, civId: 'rome', placement: 1 }])

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'sub-duel'))
      expect(participants.find(participant => participant.playerId === 'p1')).toBeUndefined()
      const p3 = participants.find(participant => participant.playerId === 'p3')
      expect(p3?.team).toBe(0)
      expect(p3?.civId).toBe('rome')
      expect(p3?.placement).toBe(1)
      expect(p3?.ratingBeforeMu).not.toBeNull()
      expect(p3?.ratingAfterMu).not.toBeNull()

      const [match] = await db.select().from(matches).where(eq(matches.id, 'sub-duel')).limit(1)
      const draftData = JSON.parse(match?.draftData ?? '{}')
      expect(draftData.hostId).toBe('p3')
      expect(draftData.state.seats.map((seat: any) => seat.playerId)).toEqual(['p3', 'p2'])

      const bans = await db.select().from(matchBans).where(eq(matchBans.matchId, 'sub-duel'))
      expect(bans).toEqual([{ matchId: 'sub-duel', civId: 'aztec', bannedBy: 'p3', phase: 0 }])

      const duelRatings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))
      expect(duelRatings.find(row => row.playerId === 'p1')).toBeUndefined()
      expect(duelRatings.find(row => row.playerId === 'p3')?.gamesPlayed).toBe(1)

      const p1Events = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.playerId, 'p1'))
      expect(p1Events).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('mod player sub swaps existing participants across teams by draft seat', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedCompletedDuoForSub(db)
      allowDiscordMembershipLookup()

      const result = await substituteMatchPlayerByModerator(db, kv, {
        matchId: 'sub-duo',
        playerId: 'p1',
        subPlayer: { playerId: 'p3', displayName: 'P3', avatarUrl: null },
        correctedAt: 3_000,
      }, { primaryGuildId: GUILD_ID, discordToken: 'token' })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.substitutions).toEqual([
        { seatIndex: 0, previousPlayerId: 'p1', nextPlayerId: 'p3', team: 0, civId: 'rome', placement: 1 },
        { seatIndex: 1, previousPlayerId: 'p3', nextPlayerId: 'p1', team: 1, civId: 'india', placement: 2 },
      ])

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'sub-duo'))
      const p1 = participants.find(participant => participant.playerId === 'p1')
      const p3 = participants.find(participant => participant.playerId === 'p3')
      expect(p3?.team).toBe(0)
      expect(p3?.civId).toBe('rome')
      expect(p3?.placement).toBe(1)
      expect(p1?.team).toBe(1)
      expect(p1?.civId).toBe('india')
      expect(p1?.placement).toBe(2)

      const [match] = await db.select().from(matches).where(eq(matches.id, 'sub-duo')).limit(1)
      const draftData = JSON.parse(match?.draftData ?? '{}')
      expect(draftData.hostId).toBe('p1')
      expect(draftData.state.seats.map((seat: any) => [seat.playerId, seat.team])).toEqual([
        ['p3', 0],
        ['p1', 1],
        ['p2', 0],
        ['p4', 1],
      ])
    }
    finally {
      sqlite.close()
    }
  })

  test('mod player sub updates a draft-complete active match without replaying ratings', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActiveDraftCompleteDuelForSub(db)
      allowDiscordMembershipLookup()

      const result = await substituteMatchPlayerByModerator(db, kv, {
        matchId: 'sub-active',
        playerId: 'p1',
        subPlayer: { playerId: 'p3', displayName: 'P3', avatarUrl: null },
        correctedAt: 3_000,
      }, { primaryGuildId: GUILD_ID, discordToken: 'token' })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('active')
      expect(result.recalculatedMatchIds).toEqual([])

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'sub-active'))
      expect(participants.find(participant => participant.playerId === 'p1')).toBeUndefined()
      const p3 = participants.find(participant => participant.playerId === 'p3')
      expect(p3?.civId).toBe('rome')
      expect(p3?.placement).toBeNull()
      expect(p3?.ratingBeforeMu).toBeNull()

      const ratings = await db.select().from(playerRatings)
      expect(ratings).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('mod leader correction keeps tournament matches out of player leader aggregates', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedThreeCompletedDuels(db)
      await db.insert(tournaments).values({
        id: 'tournament-1',
        name: 'Tournament 1',
        mode: '1v1',
        status: 'qualifier',
        scoring: 'open_win_rate',
        rematchPolicy: 'warn',
        minGames: 1,
        topCut: 2,
        roleId: null,
        createdById: 'mod',
        createdAt: 1,
        updatedAt: 1,
      })
      await db.insert(tournamentMatches).values({
        sessionId: 'tournament-session-1',
        tournamentId: 'tournament-1',
        matchId: 'm1',
        stage: 'qualifier',
        status: 'reported',
        playerOneId: 'p1',
        playerTwoId: 'p2',
        winnerId: 'p1',
        createdAt: 1,
        updatedAt: 1,
      })

      const leaderId = allLeaderIds.find(id => id !== 'rome' && id !== 'greece') ?? allLeaderIds[0]!
      const result = await correctMatchLeadersByModerator(db, {
        matchId: 'm1',
        playerId: 'p1',
        leaderId,
        correctedAt: 10_000,
      }, { primaryGuildId: GUILD_ID })

      expect('error' in result).toBe(false)
      expect(await db.select().from(playerCivStats)).toEqual([])
      expect(await db.select().from(matchPlayerCivStatContributions)).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('reporting a 5v5 match records squad ratings', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const playerIds = Array.from({ length: 10 }, (_, index) => `p${index + 1}`)
      await db.insert(players).values(playerIds.map(playerId => ({
        id: playerId,
        displayName: playerId,
        avatarUrl: null,
        createdAt: 1,
      })))
      await db.insert(matches).values({
        id: '5v5-1',
        guildId: GUILD_ID,
        gameMode: '5v5',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 1,
          state: {
            seats: playerIds.map((playerId, index) => ({
              playerId,
              team: index < 5 ? 0 : 1,
            })),
          },
        }),
      })
      await db.insert(matchParticipants).values(playerIds.map((playerId, index) => ({
        matchId: '5v5-1',
        playerId,
        team: index < 5 ? 0 : 1,
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      })))

      const result = await reportMatch(db, kv, {
        matchId: '5v5-1',
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.match.status).toBe('completed')
      expect(result.participants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
      expect(result.participants.every(participant => participant.leaderboardBeforeRank == null && participant.leaderboardAfterRank == null)).toBe(true)

      const ratingRows = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'squad'))

      expect(ratingRows).toHaveLength(10)
      expect(ratingRows.every(row => row.gamesPlayed === 1)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve on a past 1v1 match recalculates downstream ratings and keeps leaderboard populated', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1',
        placements: 'B',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual(['m1', 'm2', 'm3'])

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      expect(duelRatings).toHaveLength(2)
      expect(duelRatings.every(row => row.gamesPlayed === 3)).toBe(true)

      const p1 = duelRatings.find(row => row.playerId === 'p1')
      const p2 = duelRatings.find(row => row.playerId === 'p2')
      expect(p1?.wins).toBe(1)
      expect(p2?.wins).toBe(2)

      const leaderboardEntries = buildLeaderboard(
        duelRatings.map(row => ({
          playerId: row.playerId,
          mu: row.mu,
          sigma: row.sigma,
          gamesPlayed: row.gamesPlayed,
          wins: row.wins,
        })),
        3,
      )
      expect(leaderboardEntries.length).toBeGreaterThan(0)

      const [m2p1] = await db
        .select({
          ratingBeforeMu: matchParticipants.ratingBeforeMu,
        })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.matchId, 'm2'),
          eq(matchParticipants.playerId, 'p1'),
        ))
        .limit(1)

      expect(m2p1?.ratingBeforeMu).not.toBeCloseTo(27, 5)

      const resolvedM1 = await db
        .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'm1'))

      const m1P1 = resolvedM1.find(row => row.playerId === 'p1')
      const m1P2 = resolvedM1.find(row => row.playerId === 'p2')
      expect(m1P1?.placement).toBe(2)
      expect(m1P2?.placement).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve excludes 1v1 CivBlitz matches from duel replay history', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)
      await db.insert(matches).values([
        { id: 'civ-blitz-before', guildId: GUILD_ID, gameMode: '1v1', status: 'completed', createdAt: 500, completedAt: 600, seasonId: null, draftData: JSON.stringify({ civBlitz: true }) },
        { id: 'civ-blitz-after', guildId: GUILD_ID, gameMode: '1v1', status: 'completed', createdAt: 2500, completedAt: 2600, seasonId: null, draftData: JSON.stringify({ civBlitz: true }) },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'civ-blitz-before', playerId: 'p1', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'civ-blitz-before', playerId: 'p2', team: 1, civId: 'greece', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'civ-blitz-after', playerId: 'p1', team: 0, civId: 'rome', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'civ-blitz-after', playerId: 'p2', team: 1, civId: 'greece', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1',
        placements: 'B',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.recalculatedMatchIds).toEqual(['m1', 'm2', 'm3'])

      const civBlitzParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'civ-blitz-after'))
      expect(civBlitzParticipants.every(participant => participant.ratingAfterMu == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve does not recalculate again when replay validation fails', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)
      await db.insert(matches).values({
        id: 'invalid-history',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'completed',
        createdAt: 2500,
        completedAt: 2600,
        seasonId: null,
        draftData: null,
      })
      await db.insert(matchParticipants).values([
        { matchId: 'invalid-history', playerId: 'p1', team: 0, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'invalid-history', playerId: 'p2', team: 1, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])
      const originalEvents = await db
        .select()
        .from(playerRatingEvents)
        .where(and(
          eq(playerRatingEvents.matchId, 'm1'),
          eq(playerRatingEvents.mode, 'duel'),
        ))
      const originalRatings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1',
        placements: 'B',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect(result).toEqual({ error: 'Completed match **invalid-history** has missing placements.' })

      const restoredParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'm1'))
      expect(restoredParticipants.find(participant => participant.playerId === 'p1')?.placement).toBe(1)
      expect(restoredParticipants.find(participant => participant.playerId === 'p2')?.placement).toBe(2)

      const preservedEvents = await db
        .select()
        .from(playerRatingEvents)
        .where(and(
          eq(playerRatingEvents.matchId, 'm1'),
          eq(playerRatingEvents.mode, 'duel'),
        ))
      expect(preservedEvents).toEqual(originalEvents)

      const preservedRatings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))
      expect(preservedRatings).toEqual(originalRatings)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve on a newly completed mid-history 1v1 match replays from that match onward', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)
      await db.insert(matches).values({
        id: 'm1a',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 2500,
        completedAt: null,
        seasonId: null,
        draftData: null,
      })
      await db.insert(matchParticipants).values([
        { matchId: 'm1a', playerId: 'p1', team: 0, civId: 'aztec', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'm1a', playerId: 'p2', team: 1, civId: 'egypt', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1a',
        placements: 'B',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual(['m1a', 'm2', 'm3'])

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      expect(duelRatings).toHaveLength(2)
      expect(duelRatings.every(row => row.gamesPlayed === 4)).toBe(true)

      const [m1aP1] = await db
        .select({
          ratingBeforeMu: matchParticipants.ratingBeforeMu,
          ratingAfterMu: matchParticipants.ratingAfterMu,
        })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.matchId, 'm1a'),
          eq(matchParticipants.playerId, 'p1'),
        ))
        .limit(1)

      expect(m1aP1?.ratingBeforeMu).not.toBeNull()
      expect(m1aP1?.ratingAfterMu).not.toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve on a cancelled mid-history 1v1 match replays from that match onward', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)
      await db.insert(matches).values({
        id: 'm1a',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'cancelled',
        createdAt: 2500,
        completedAt: 2600,
        seasonId: null,
        draftData: JSON.stringify({ completedAt: 2100 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'm1a', playerId: 'p1', team: 0, civId: 'aztec', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'm1a', playerId: 'p2', team: 1, civId: 'egypt', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1a',
        placements: 'B',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.previousStatus).toBe('cancelled')
      expect(result.match.status).toBe('completed')
      expect(result.recalculatedMatchIds).toEqual(['m1a', 'm2', 'm3'])

      const [m2p1] = await db
        .select({ ratingBeforeMu: matchParticipants.ratingBeforeMu })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.matchId, 'm2'),
          eq(matchParticipants.playerId, 'p1'),
        ))
        .limit(1)

      expect(m2p1?.ratingBeforeMu).not.toBeCloseTo(27, 5)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve does not infer scoped rating history from an earlier match without rating events', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const playerIds = Array.from({ length: 11 }, (_, index) => `p${index + 1}`)
      await db.insert(players).values(playerIds.map(playerId => ({
        id: playerId,
        displayName: playerId,
        avatarUrl: null,
        createdAt: 1,
      })))
      await db.insert(matches).values([
        { id: 'corrupt-squad', guildId: GUILD_ID, gameMode: '3v3', status: 'completed', createdAt: 1000, completedAt: 1500, seasonId: null, draftData: null },
        { id: 'later-squad', guildId: GUILD_ID, gameMode: '3v3', status: 'active', createdAt: 2000, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 2100 }) },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'corrupt-squad', playerId: 'p1', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'corrupt-squad', playerId: 'p2', team: 0, civId: 'greece', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'corrupt-squad', playerId: 'p3', team: 0, civId: 'india', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'corrupt-squad', playerId: 'p4', team: 1, civId: 'china', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'corrupt-squad', playerId: 'p5', team: 1, civId: 'japan', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'corrupt-squad', playerId: 'p6', team: 1, civId: 'france', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'later-squad', playerId: 'p1', team: 0, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'later-squad', playerId: 'p7', team: 0, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'later-squad', playerId: 'p8', team: 0, civId: 'india', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'later-squad', playerId: 'p9', team: 1, civId: 'china', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'later-squad', playerId: 'p10', team: 1, civId: 'japan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'later-squad', playerId: 'p11', team: 1, civId: 'france', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'later-squad',
        placements: '<@p1>',
        resolvedAt: 3000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.recalculatedMatchIds).toEqual(['later-squad'])

      const participants = await db
        .select()
        .from(matchParticipants)
      const earlierParticipants = participants.filter(participant => participant.matchId === 'corrupt-squad')
      const reportedParticipants = participants.filter(participant => participant.matchId === 'later-squad')
      expect(earlierParticipants.every(participant => participant.ratingBeforeMu == null && participant.ratingAfterMu == null)).toBe(true)
      expect(reportedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const ratings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'squad'))
      expect(ratings.find(row => row.playerId === 'p1')?.gamesPlayed).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve on the latest completed 1v1 match only recalculates that match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm3',
        placements: 'A',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual(['m3'])
    }
    finally {
      sqlite.close()
    }
  })

  test('cancel on a completed 1v1 match removes it from track and recalculates later matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await cancelMatchByModerator(db, kv, {
        matchId: 'm1',
        cancelledAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual(['m2', 'm3'])

      const [matchRow] = await db
        .select({ status: matches.status })
        .from(matches)
        .where(eq(matches.id, 'm1'))
        .limit(1)

      expect(matchRow?.status).toBe('cancelled')

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      const p1 = duelRatings.find(row => row.playerId === 'p1')
      const p2 = duelRatings.find(row => row.playerId === 'p2')
      expect(p1?.gamesPlayed).toBe(2)
      expect(p2?.gamesPlayed).toBe(2)
      expect(p1?.wins).toBe(1)
      expect(p2?.wins).toBe(1)

      const [m2p1] = await db
        .select({
          ratingBeforeMu: matchParticipants.ratingBeforeMu,
        })
        .from(matchParticipants)
        .where(and(
          eq(matchParticipants.matchId, 'm2'),
          eq(matchParticipants.playerId, 'p1'),
        ))
        .limit(1)

      expect(m2p1?.ratingBeforeMu).not.toBeCloseTo(27, 5)
    }
    finally {
      sqlite.close()
    }
  })

  test('cancel resumes cleanup for already-cancelled matches with stale rating events', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)
      await db.update(matches).set({ status: 'cancelled', completedAt: 10_000 }).where(eq(matches.id, 'm1'))
      await db
        .update(matchParticipants)
        .set({ placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null })
        .where(eq(matchParticipants.matchId, 'm1'))
      await db.insert(playerRatings).values(withStatsKey([
        { playerId: 'p1', mode: 'global', mu: 26, sigma: 7.2, gamesPlayed: 3, wins: 2, lastPlayedAt: 6000 },
        { playerId: 'p2', mode: 'global', mu: 24, sigma: 7.2, gamesPlayed: 3, wins: 1, lastPlayedAt: 6000 },
      ]))
      const result = await cancelMatchByModerator(db, kv, {
        matchId: 'm1',
        cancelledAt: 11_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.previousStatus).toBe('cancelled')
      expect(result.recalculatedMatchIds).toEqual(['m2', 'm3'])

      const staleEvents = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'm1'))
      expect(staleEvents).toHaveLength(0)

      const globalRatings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'global'))
      expect(globalRatings).toHaveLength(2)
      expect(globalRatings.every(row => row.gamesPlayed === 2)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('cancel on the latest completed 1v1 match does not replay downstream matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await cancelMatchByModerator(db, kv, {
        matchId: 'm3',
        cancelledAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.recalculatedMatchIds).toEqual([])

      const duelRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duel'))

      expect(duelRatings).toHaveLength(2)
      expect(duelRatings.every(row => row.gamesPlayed === 2)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('cancel on a reported SessionDO clears completed participant results', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 },
          { playerId: 'p2', displayName: 'P2', avatarUrl: null, joinedAt: 1 },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, { db, sessionNamespace: runtime.sessionNamespace })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: 2 })
      await db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: 2 }) }).where(eq(matches.id, lobby.id))
      await runSessionTerminalLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'mark-reported', matchId: lobby.id, at: 3 })
      await db.update(matchParticipants).set({ placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8, ratingAfterMu: 27, ratingAfterSigma: 7 }).where(eq(matchParticipants.matchId, lobby.id))

      const result = await cancelMatchByModerator(db, kv, {
        matchId: lobby.id,
        cancelledAt: 4,
      }, {
        sessionNamespace: runtime.sessionNamespace,
        primaryGuildId: GUILD_ID,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.previousStatus).toBe('completed')
      expect(result.match.status).toBe('cancelled')
      expect(result.recalculatedMatchIds).toEqual([])
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('cancelled')

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, lobby.id))
      expect(participants.every(participant => participant.placement == null)).toBe(true)
      expect(participants.every(participant => participant.ratingBeforeMu == null && participant.ratingAfterMu == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('moderation routes terminal lifecycle through the canonical session ID', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const requestedSessionIds: string[] = []

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', createdAt: 1 })
      await db.insert(matches).values({ id: 'distinct-match', guildId: GUILD_ID, gameMode: '1v1', status: 'active', createdAt: 1 })
      await db.insert(matchParticipants).values({ matchId: 'distinct-match', playerId: 'p1', team: 0 })
      await db.insert(sessionDirectory).values({
        sessionId: 'canonical-session',
        phase: 'active',
        mode: '1v1',
        guildId: GUILD_ID,
        channelId: 'channel',
        hostId: 'p1',
        messageId: 'message',
        matchId: 'distinct-match',
        version: 1,
        rosterJson: '{}',
        configJson: '{}',
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      })

      const result = await cancelMatchByModerator(db, kv, {
        matchId: 'distinct-match',
        cancelledAt: 2,
      }, {
        sessionNamespace: acceptingTerminalSessionNamespace(requestedSessionIds),
        primaryGuildId: GUILD_ID,
      })

      expect('error' in result).toBe(false)
      expect(requestedSessionIds).toEqual(['canonical-session'])
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve reports a cancelled SessionDO match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 },
          { playerId: 'p2', displayName: 'P2', avatarUrl: null, joinedAt: 1 },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, { db, sessionNamespace: runtime.sessionNamespace })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: 2 })
      await db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: 2 }) }).where(eq(matches.id, lobby.id))

      const cancelled = await cancelMatchByModerator(db, kv, {
        matchId: lobby.id,
        cancelledAt: 3,
      }, {
        sessionNamespace: runtime.sessionNamespace,
        primaryGuildId: GUILD_ID,
      })
      expect('error' in cancelled).toBe(false)
      if ('error' in cancelled) return
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('cancelled')
      expect(cancelled.match.status).toBe('cancelled')

      const result = await resolveMatchByModerator(db, kv, {
        matchId: lobby.id,
        placements: '<@p2>',
        resolvedAt: 4,
      }, {
        sessionNamespace: runtime.sessionNamespace,
        primaryGuildId: GUILD_ID,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.previousStatus).toBe('cancelled')
      expect(result.recalculatedMatchIds).toEqual([lobby.id])
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('reported')
      expect(result.match.status).toBe('completed')

      const p1 = result.participants.find(participant => participant.playerId === 'p1')
      const p2 = result.participants.find(participant => participant.playerId === 'p2')
      expect(p1?.placement).toBe(2)
      expect(p2?.placement).toBe(1)
      expect(p1?.ratingBeforeMu).not.toBeNull()
      expect(p2?.ratingAfterMu).not.toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve corrects results when SessionDO is already reported', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 },
          { playerId: 'p2', displayName: 'P2', avatarUrl: null, joinedAt: 1 },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, { db, sessionNamespace: runtime.sessionNamespace })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: 2 })
      await db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: 2 }) }).where(eq(matches.id, lobby.id))
      await runSessionTerminalLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'mark-reported', matchId: lobby.id, at: 3 })

      const result = await resolveMatchByModerator(db, kv, {
        matchId: lobby.id,
        placements: '<@p2>',
        resolvedAt: 4,
      }, {
        sessionNamespace: runtime.sessionNamespace,
        primaryGuildId: GUILD_ID,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.recalculatedMatchIds).toEqual([lobby.id])
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('reported')
      expect(result.match.status).toBe('completed')

      const p1 = result.participants.find(participant => participant.playerId === 'p1')
      const p2 = result.participants.find(participant => participant.playerId === 'p2')
      expect(p1?.placement).toBe(2)
      expect(p2?.placement).toBe(1)
      expect(p1?.ratingBeforeMu).not.toBeNull()
      expect(p2?.ratingAfterMu).not.toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve terminal failure rolls back D1 when SessionDO remains active', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: 'p1', displayName: 'P1', avatarUrl: null, joinedAt: 1 },
          { playerId: 'p2', displayName: 'P2', avatarUrl: null, joinedAt: 1 },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, { db, sessionNamespace: runtime.sessionNamespace })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: 2 })
      await db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: 2 }) }).where(eq(matches.id, lobby.id))

      const result = await resolveMatchByModerator(db, kv, {
        matchId: lobby.id,
        placements: '<@p2>',
        resolvedAt: 4,
      }, {
        sessionNamespace: failTerminalLifecycleForSession(runtime.sessionNamespace, lobby.id),
        primaryGuildId: GUILD_ID,
      })

      expect('error' in result).toBe(true)
      if (!('error' in result)) return
      expect(result.error).toContain('terminal lifecycle failed')
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('active')

      const [rolledBackMatch] = await db.select().from(matches).where(eq(matches.id, lobby.id)).limit(1)
      expect(rolledBackMatch?.status).toBe('active')
      expect(rolledBackMatch?.completedAt).toBeNull()

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, lobby.id))
      expect(participants.every(participant => participant.placement == null && participant.ratingBeforeMu == null && participant.ratingAfterMu == null)).toBe(true)

      const ratings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))
      expect(ratings).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('resolve accepts winner mention for 1v1 moderation', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)

      const result = await resolveMatchByModerator(db, kv, {
        matchId: 'm1',
        placements: '<@p2>',
        resolvedAt: 10_000,
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const resolvedM1 = await db
        .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'm1'))

      const m1P1 = resolvedM1.find(row => row.playerId === 'p1')
      const m1P2 = resolvedM1.find(row => row.playerId === 'p2')
      expect(m1P1?.placement).toBe(2)
      expect(m1P2?.placement).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('report rejects FFA users not in the match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActiveFfaMatch(db)

      const result = await reportMatch(db, kv, {
        matchId: 'ffa1',
        reporterId: 'p1',
        placements: '<@p1>\n<@p2>\n<@p3>\n<@p4>\n<@p5>\n<@p6>\n<@outsider>',
      }, directTerminalOptions)

      expect('error' in result).toBe(true)
      if (!('error' in result)) return
      expect(result.error).toContain('is not part of match')
    }
    finally {
      sqlite.close()
    }
  })

  test('report allows a non-host participant to report an active match', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActiveFfaMatch(db)

      const result = await reportMatch(db, kv, {
        matchId: 'ffa1',
        reporterId: 'p2',
        placements: '<@p1>\n<@p2>\n<@p3>\n<@p4>\n<@p5>\n<@p6>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('completed')
    }
    finally {
      sqlite.close()
    }
  })

  test('report resolves Permanent Ally FFA placements from adjacent player clicks', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActivePermanentAllyFfaMatch(db)

      const result = await reportMatch(db, kv, {
        matchId: 'ffa-pa',
        reporterId: 'p2',
        placements: '<@p3>\n<@p4>\n<@p1>\n<@p2>\n<@p5>\n<@p6>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      const placementByPlayer = new Map(result.participants.map(participant => [participant.playerId, participant.placement]))
      expect(placementByPlayer.get('p3')).toBe(1)
      expect(placementByPlayer.get('p4')).toBe(1)
      expect(placementByPlayer.get('p1')).toBe(2)
      expect(placementByPlayer.get('p2')).toBe(2)
      expect(placementByPlayer.get('p5')).toBe(3)
      expect(placementByPlayer.get('p6')).toBe(3)
      expect(result.participants.every(participant => participant.team == null)).toBe(true)

      expect(displayDelta(result.participants, 'p1')).toBeCloseTo(displayDelta(result.participants, 'p2'), 10)
      expect(displayDelta(result.participants, 'p3')).toBeCloseTo(displayDelta(result.participants, 'p4'), 10)
      expect(displayDelta(result.participants, 'p5')).toBeCloseTo(displayDelta(result.participants, 'p6'), 10)
    }
    finally {
      sqlite.close()
    }
  })

  test('report rejects one-click-per-team Permanent Ally FFA placements', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActivePermanentAllyFfaMatch(db)

      const result = await reportMatch(db, kv, {
        matchId: 'ffa-pa',
        reporterId: 'p2',
        placements: '<@p3>\n<@p1>\n<@p5>',
      }, directTerminalOptions)

      expect('error' in result).toBe(true)
      if (!('error' in result)) return
      expect(result.error).toContain('include every player exactly once')
    }
    finally {
      sqlite.close()
    }
  })

  test('report resolves ordered team placements for multi-team 2v2 matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActiveMultiTeamDuoMatch(db)

      const result = await reportMatch(db, kv, {
        matchId: 'duo-multi-active',
        reporterId: 'p1',
        placements: '<@p5>\n<@p1>\n<@p3>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('completed')

      const resolved = await db
        .select({ playerId: matchParticipants.playerId, placement: matchParticipants.placement })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, 'duo-multi-active'))

      expect(resolved.find(row => row.playerId === 'p5')?.placement).toBe(1)
      expect(resolved.find(row => row.playerId === 'p6')?.placement).toBe(1)
      expect(resolved.find(row => row.playerId === 'p1')?.placement).toBe(2)
      expect(resolved.find(row => row.playerId === 'p2')?.placement).toBe(2)
      expect(resolved.find(row => row.playerId === 'p3')?.placement).toBe(3)
      expect(resolved.find(row => row.playerId === 'p4')?.placement).toBe(3)
    }
    finally {
      sqlite.close()
    }
  })

  test('report rebuilds leaderboard snapshot before writing ratings', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedActiveSquadMatch(db)
      await kv.put(leaderboardModeSnapshotKey('squad'), JSON.stringify({
        updatedAt: 1,
        rows: [
          { playerId: 'p1', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
          { playerId: 'p2', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
          { playerId: 'p3', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
          { playerId: 'p4', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
          { playerId: 'p5', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
        ],
      }))

      const result = await reportMatch(db, kv, {
        matchId: 'squad-active',
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('completed')

      const [p6Rating] = await db
        .select()
        .from(playerRatings)
        .where(and(
          eq(playerRatings.playerId, 'p6'),
          eq(playerRatings.mode, 'squad'),
        ))
        .limit(1)

      expect(p6Rating?.gamesPlayed).toBe(2)
    }
    finally {
      sqlite.close()
    }
  })

  test('recalculateLeaderboardMode splits 2v2 into duo and 3v3 into squad', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedCompletedTeamMatches(db)

      const duoResult = await recalculateLeaderboardMode(db, 'duo', STATS_CONTEXT)
      const squadResult = await recalculateLeaderboardMode(db, 'squad', STATS_CONTEXT)

      expect('error' in duoResult).toBe(false)
      expect('error' in squadResult).toBe(false)
      if ('error' in duoResult || 'error' in squadResult) return

      expect(duoResult.matchIds).toEqual(['duo-1'])
      expect(squadResult.matchIds).toEqual(['squad-1'])

      const duoRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'duo'))

      const squadRatings = await db
        .select()
        .from(playerRatings)
        .where(eq(playerRatings.mode, 'squad'))

      expect(duoRatings).toHaveLength(4)
      expect(squadRatings).toHaveLength(6)
      expect(duoRatings.every(row => row.gamesPlayed === 1)).toBe(true)
      expect(squadRatings.every(row => row.gamesPlayed === 1)).toBe(true)
      expect(duoRatings.some(row => row.playerId.startsWith('s'))).toBe(false)
      expect(squadRatings.some(row => row.playerId.startsWith('d'))).toBe(false)
    }
    finally {
      sqlite.close()
    }
  })
})

async function seedThreeCompletedDuels(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values([
    { id: 'm1', guildId: GUILD_ID, gameMode: '1v1', status: 'completed', createdAt: 1000, completedAt: 2000, seasonId: null, draftData: null },
    { id: 'm2', guildId: GUILD_ID, gameMode: '1v1', status: 'completed', createdAt: 3000, completedAt: 4000, seasonId: null, draftData: null },
    { id: 'm3', guildId: GUILD_ID, gameMode: '1v1', status: 'completed', createdAt: 5000, completedAt: 6000, seasonId: null, draftData: null },
  ])

  await db.insert(matchParticipants).values([
    // m1: p1 beats p2
    { matchId: 'm1', playerId: 'p1', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 27, ratingAfterSigma: 7.9 },
    { matchId: 'm1', playerId: 'p2', team: 1, civId: 'greece', placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 23, ratingAfterSigma: 7.9 },

    // m2: p1 beats p2 again
    { matchId: 'm2', playerId: 'p1', team: 0, civId: 'india', placement: 1, ratingBeforeMu: 27, ratingBeforeSigma: 7.9, ratingAfterMu: 28, ratingAfterSigma: 7.5 },
    { matchId: 'm2', playerId: 'p2', team: 1, civId: 'japan', placement: 2, ratingBeforeMu: 23, ratingBeforeSigma: 7.9, ratingAfterMu: 22, ratingAfterSigma: 7.5 },

    // m3: p2 beats p1
    { matchId: 'm3', playerId: 'p1', team: 0, civId: 'france', placement: 2, ratingBeforeMu: 28, ratingBeforeSigma: 7.5, ratingAfterMu: 26, ratingAfterSigma: 7.2 },
    { matchId: 'm3', playerId: 'p2', team: 1, civId: 'china', placement: 1, ratingBeforeMu: 22, ratingBeforeSigma: 7.5, ratingAfterMu: 24, ratingAfterSigma: 7.2 },
  ])

  await db.insert(playerRatings).values(withStatsKey([
    { playerId: 'p1', mode: 'duel', mu: 26, sigma: 7.2, gamesPlayed: 3, wins: 2, lastPlayedAt: 6000 },
    { playerId: 'p2', mode: 'duel', mu: 24, sigma: 7.2, gamesPlayed: 3, wins: 1, lastPlayedAt: 6000 },
  ]))
  await db.insert(playerRatingEvents).values([
    ratingEvent('m1', 'p1', 'duel', 1),
    ratingEvent('m1', 'p2', 'duel', 0),
    ratingEvent('m1', 'p1', 'global', 1),
    ratingEvent('m1', 'p2', 'global', 0),
    ratingEvent('m2', 'p1', 'duel', 1, { ratingBeforeMu: 27, ratingBeforeSigma: 7.9, ratingAfterMu: 28, ratingAfterSigma: 7.5, matchCreatedAt: 3000, matchCompletedAt: 4000, updatedAt: 4000 }),
    ratingEvent('m2', 'p2', 'duel', 0, { ratingBeforeMu: 23, ratingBeforeSigma: 7.9, ratingAfterMu: 22, ratingAfterSigma: 7.5, matchCreatedAt: 3000, matchCompletedAt: 4000, updatedAt: 4000 }),
    ratingEvent('m2', 'p1', 'global', 1, { ratingBeforeMu: 27, ratingBeforeSigma: 7.9, ratingAfterMu: 28, ratingAfterSigma: 7.5, matchCreatedAt: 3000, matchCompletedAt: 4000, updatedAt: 4000 }),
    ratingEvent('m2', 'p2', 'global', 0, { ratingBeforeMu: 23, ratingBeforeSigma: 7.9, ratingAfterMu: 22, ratingAfterSigma: 7.5, matchCreatedAt: 3000, matchCompletedAt: 4000, updatedAt: 4000 }),
  ])
}

async function seedCompletedDuelWithRatingEvents(db: any): Promise<void> {
  const seats = [
    { playerId: 'p1', displayName: 'P1', avatarUrl: null, team: 0 },
    { playerId: 'p2', displayName: 'P2', avatarUrl: null, team: 1 },
  ]
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
  ])
  await db.insert(matches).values({
    id: 'sub-duel',
    guildId: GUILD_ID,
    gameMode: '1v1',
    status: 'completed',
    createdAt: 1_000,
    completedAt: 2_000,
    seasonId: null,
    draftData: buildStoredDraftData('sub-duel', seats, ['rome', 'greece'], [{ civId: 'aztec', seatIndex: 0, stepIndex: 0 }]),
  })
  await db.insert(matchParticipants).values([
    { matchId: 'sub-duel', playerId: 'p1', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 27, ratingAfterSigma: 7.9 },
    { matchId: 'sub-duel', playerId: 'p2', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 1, civId: 'greece', placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 23, ratingAfterSigma: 7.9 },
  ])
  await db.insert(matchBans).values({ matchId: 'sub-duel', civId: 'aztec', bannedBy: 'p1', phase: 0 })
  await db.insert(playerRatings).values(withStatsKey([
    { playerId: 'p1', mode: 'duel', mu: 27, sigma: 7.9, gamesPlayed: 1, wins: 1, lastPlayedAt: 2_000 },
    { playerId: 'p2', mode: 'duel', mu: 23, sigma: 7.9, gamesPlayed: 1, wins: 0, lastPlayedAt: 2_000 },
    { playerId: 'p1', mode: 'global', mu: 27, sigma: 7.9, gamesPlayed: 1, wins: 1, lastPlayedAt: 2_000 },
    { playerId: 'p2', mode: 'global', mu: 23, sigma: 7.9, gamesPlayed: 1, wins: 0, lastPlayedAt: 2_000 },
  ]))
  await db.insert(playerRatingEvents).values([
    ratingEvent('sub-duel', 'p1', 'duel', 1),
    ratingEvent('sub-duel', 'p2', 'duel', 0),
    ratingEvent('sub-duel', 'p1', 'global', 1),
    ratingEvent('sub-duel', 'p2', 'global', 0),
  ])
}

async function seedCompletedDuoForSub(db: any): Promise<void> {
  const seats = [
    { playerId: 'p1', displayName: 'P1', avatarUrl: null, team: 0 },
    { playerId: 'p3', displayName: 'P3', avatarUrl: null, team: 1 },
    { playerId: 'p2', displayName: 'P2', avatarUrl: null, team: 0 },
    { playerId: 'p4', displayName: 'P4', avatarUrl: null, team: 1 },
  ]
  await db.insert(players).values(['p1', 'p2', 'p3', 'p4'].map(playerId => ({ id: playerId, displayName: playerId.toUpperCase(), avatarUrl: null, createdAt: 1 })))
  await db.insert(matches).values({
    id: 'sub-duo',
    guildId: GUILD_ID,
    gameMode: '2v2',
    status: 'completed',
    createdAt: 1_000,
    completedAt: 2_000,
    seasonId: null,
    draftData: buildStoredDraftData('sub-duo', seats, ['rome', 'india', 'greece', 'china']),
  })
  await db.insert(matchParticipants).values([
    { matchId: 'sub-duo', playerId: 'p1', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'sub-duo', playerId: 'p3', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 1, civId: 'india', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'sub-duo', playerId: 'p2', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 0, civId: 'greece', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'sub-duo', playerId: 'p4', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 1, civId: 'china', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function seedActiveDraftCompleteDuelForSub(db: any): Promise<void> {
  const seats = [
    { playerId: 'p1', displayName: 'P1', avatarUrl: null, team: 0 },
    { playerId: 'p2', displayName: 'P2', avatarUrl: null, team: 1 },
  ]
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
  ])
  await db.insert(matches).values({
    id: 'sub-active',
    guildId: GUILD_ID,
    gameMode: '1v1',
    status: 'active',
    createdAt: 1_000,
    completedAt: null,
    seasonId: null,
    draftData: buildStoredDraftData('sub-active', seats, ['rome', 'greece']),
  })
  await db.insert(matchParticipants).values([
    { matchId: 'sub-active', playerId: 'p1', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 0, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'sub-active', playerId: 'p2', sourceGuildId: GUILD_ID, sourceKind: 'legacy_primary', team: 1, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

function buildStoredDraftData(
  matchId: string,
  seats: Array<{ playerId: string, displayName: string, avatarUrl: string | null, team?: number }>,
  civIds: string[],
  bans: Array<{ civId: string, seatIndex: number, stepIndex: number }> = [],
): string {
  return JSON.stringify({
    completedAt: 2_000,
    hostId: seats[0]?.playerId,
    leaderDataVersion: 'live',
    mapVoteResult: null,
    redDeath: false,
    civBlitz: false,
    permanentAlly: false,
    hiddenDraft: false,
    state: {
      matchId,
      formatId: 'test-draft',
      seats,
      steps: [],
      currentStepIndex: -1,
      submissions: {},
      bans,
      picks: civIds.map((civId, seatIndex) => ({ civId, seatIndex, stepIndex: seatIndex })),
      availableCivIds: [],
      duplicateFactions: false,
      status: 'complete',
      cancelReason: null,
      pendingBlindBans: [],
    },
  })
}

function ratingEvent(matchId: string, playerId: string, mode: 'duel' | 'global', winsDelta: number, overrides: Record<string, number | null> = {}) {
  return {
    statsKey: STATS_KEY,
    matchId,
    playerId,
    mode,
    gameMode: '1v1',
    ratingBeforeMu: 25,
    ratingBeforeSigma: 8.333,
    ratingAfterMu: winsDelta > 0 ? 27 : 23,
    ratingAfterSigma: 7.9,
    gamesDelta: 1,
    winsDelta,
    importedGamesDelta: 0,
    effectiveGamesDelta: 1,
    winsVsTier1Delta: 0,
    winsVsTier2PlusDelta: 0,
    effectiveWinsVsTier1Delta: 0,
    effectiveWinsVsTier2PlusDelta: 0,
    matchCreatedAt: 1_000,
    matchCompletedAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function buildManualPlayers(leaderIds: string[]) {
  return leaderIds.map((civId, index) => ({
    playerId: `p${index + 1}`,
    displayName: `P${index + 1}`,
    avatarUrl: null,
    civId,
  }))
}

function displayDelta(participants: Array<{ playerId: string, ratingBeforeMu: number | null, ratingBeforeSigma: number | null, ratingAfterMu: number | null, ratingAfterSigma: number | null }>, playerId: string): number {
  const participant = participants.find(row => row.playerId === playerId)
  expect(typeof participant?.ratingBeforeMu).toBe('number')
  expect(typeof participant?.ratingBeforeSigma).toBe('number')
  expect(typeof participant?.ratingAfterMu).toBe('number')
  expect(typeof participant?.ratingAfterSigma).toBe('number')
  return displayRating(participant!.ratingAfterMu!, participant!.ratingAfterSigma!) - displayRating(participant!.ratingBeforeMu!, participant!.ratingBeforeSigma!)
}

async function seedActiveFfaMatch(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
    { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
    { id: 'p4', displayName: 'P4', avatarUrl: null, createdAt: 1 },
    { id: 'p5', displayName: 'P5', avatarUrl: null, createdAt: 1 },
    { id: 'p6', displayName: 'P6', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values({
    id: 'ffa1',
    guildId: GUILD_ID,
    gameMode: 'ffa',
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: 1000, permanentAlly: false }),
  })

  await db.insert(matchParticipants).values([
    { matchId: 'ffa1', playerId: 'p1', team: null, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p2', team: null, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p3', team: null, civId: 'india', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p4', team: null, civId: 'china', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p5', team: null, civId: 'japan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa1', playerId: 'p6', team: null, civId: 'france', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function seedActivePermanentAllyFfaMatch(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
    { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
    { id: 'p4', displayName: 'P4', avatarUrl: null, createdAt: 1 },
    { id: 'p5', displayName: 'P5', avatarUrl: null, createdAt: 1 },
    { id: 'p6', displayName: 'P6', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values({
    id: 'ffa-pa',
    guildId: GUILD_ID,
    gameMode: 'ffa',
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: 1000, permanentAlly: true }),
  })

  await db.insert(matchParticipants).values([
    { matchId: 'ffa-pa', playerId: 'p1', team: null, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa-pa', playerId: 'p2', team: null, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa-pa', playerId: 'p3', team: null, civId: 'india', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa-pa', playerId: 'p4', team: null, civId: 'china', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa-pa', playerId: 'p5', team: null, civId: 'japan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'ffa-pa', playerId: 'p6', team: null, civId: 'france', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])

  await db.insert(playerRatings).values(withStatsKey([
    { playerId: 'p1', mode: 'ffa', mu: 31, sigma: 6.4, gamesPlayed: 4, wins: 1, lastPlayedAt: 900 },
    { playerId: 'p2', mode: 'ffa', mu: 22, sigma: 7.1, gamesPlayed: 4, wins: 0, lastPlayedAt: 900 },
    { playerId: 'p3', mode: 'ffa', mu: 27, sigma: 5.9, gamesPlayed: 4, wins: 1, lastPlayedAt: 900 },
    { playerId: 'p4', mode: 'ffa', mu: 24, sigma: 8.0, gamesPlayed: 4, wins: 0, lastPlayedAt: 900 },
    { playerId: 'p5', mode: 'ffa', mu: 29, sigma: 6.7, gamesPlayed: 4, wins: 1, lastPlayedAt: 900 },
    { playerId: 'p6', mode: 'ffa', mu: 20, sigma: 7.5, gamesPlayed: 4, wins: 0, lastPlayedAt: 900 },
  ]))
}

async function seedCompletedTeamMatches(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'd1', displayName: 'D1', avatarUrl: null, createdAt: 1 },
    { id: 'd2', displayName: 'D2', avatarUrl: null, createdAt: 1 },
    { id: 'd3', displayName: 'D3', avatarUrl: null, createdAt: 1 },
    { id: 'd4', displayName: 'D4', avatarUrl: null, createdAt: 1 },
    { id: 's1', displayName: 'S1', avatarUrl: null, createdAt: 1 },
    { id: 's2', displayName: 'S2', avatarUrl: null, createdAt: 1 },
    { id: 's3', displayName: 'S3', avatarUrl: null, createdAt: 1 },
    { id: 's4', displayName: 'S4', avatarUrl: null, createdAt: 1 },
    { id: 's5', displayName: 'S5', avatarUrl: null, createdAt: 1 },
    { id: 's6', displayName: 'S6', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values([
    { id: 'duo-1', guildId: GUILD_ID, gameMode: '2v2', status: 'completed', createdAt: 1000, completedAt: 2000, seasonId: null, draftData: null },
    { id: 'squad-1', guildId: GUILD_ID, gameMode: '3v3', status: 'completed', createdAt: 3000, completedAt: 4000, seasonId: null, draftData: null },
  ])

  await db.insert(matchParticipants).values([
    { matchId: 'duo-1', playerId: 'd1', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-1', playerId: 'd2', team: 0, civId: 'greece', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-1', playerId: 'd3', team: 1, civId: 'india', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-1', playerId: 'd4', team: 1, civId: 'china', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },

    { matchId: 'squad-1', playerId: 's1', team: 0, civId: 'rome', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-1', playerId: 's2', team: 0, civId: 'greece', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-1', playerId: 's3', team: 0, civId: 'india', placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-1', playerId: 's4', team: 1, civId: 'china', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-1', playerId: 's5', team: 1, civId: 'japan', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-1', playerId: 's6', team: 1, civId: 'france', placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
}

async function seedActiveSquadMatch(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
    { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
    { id: 'p4', displayName: 'P4', avatarUrl: null, createdAt: 1 },
    { id: 'p5', displayName: 'P5', avatarUrl: null, createdAt: 1 },
    { id: 'p6', displayName: 'P6', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values({
    id: 'squad-active',
    guildId: GUILD_ID,
    gameMode: '3v3',
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: 1000 }),
  })

  await db.insert(matchParticipants).values([
    { matchId: 'squad-active', playerId: 'p1', team: 0, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-active', playerId: 'p2', team: 0, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-active', playerId: 'p3', team: 0, civId: 'india', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-active', playerId: 'p4', team: 1, civId: 'china', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-active', playerId: 'p5', team: 1, civId: 'japan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'squad-active', playerId: 'p6', team: 1, civId: 'france', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])

  await db.insert(playerRatings).values(withStatsKey([
    { playerId: 'p1', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
    { playerId: 'p2', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
    { playerId: 'p3', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
    { playerId: 'p4', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
    { playerId: 'p5', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
    { playerId: 'p6', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
  ]))
}

async function seedActiveMultiTeamDuoMatch(db: any): Promise<void> {
  await db.insert(players).values([
    { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
    { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
    { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
    { id: 'p4', displayName: 'P4', avatarUrl: null, createdAt: 1 },
    { id: 'p5', displayName: 'P5', avatarUrl: null, createdAt: 1 },
    { id: 'p6', displayName: 'P6', avatarUrl: null, createdAt: 1 },
  ])

  await db.insert(matches).values({
    id: 'duo-multi-active',
    guildId: GUILD_ID,
    gameMode: '2v2',
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: 1000 }),
  })

  await db.insert(matchParticipants).values([
    { matchId: 'duo-multi-active', playerId: 'p1', team: 0, civId: 'rome', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-multi-active', playerId: 'p2', team: 0, civId: 'greece', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-multi-active', playerId: 'p3', team: 1, civId: 'india', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-multi-active', playerId: 'p4', team: 1, civId: 'china', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-multi-active', playerId: 'p5', team: 2, civId: 'japan', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId: 'duo-multi-active', playerId: 'p6', team: 2, civId: 'france', placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ])
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
