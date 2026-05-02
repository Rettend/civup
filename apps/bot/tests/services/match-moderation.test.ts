import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { buildLeaderboard } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { cancelMatchByModerator, correctMatchLeadersByModerator, recalculateLeaderboardMode, reportMatch, resolveMatchByModerator } from '../../src/services/match/index.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand, runSessionTerminalLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import { createLobby, getTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match moderation recalculation', () => {
  const directTerminalOptions = { allowDirectTerminalWriteForTests: true }

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
      })

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
      })

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

  test('resolve on a newly completed mid-history 1v1 match replays from that match onward', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedThreeCompletedDuels(db)
      await db.insert(matches).values({
        id: 'm1a',
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

  test('resolve repairs an earlier completed squad match with missing rating snapshots', async () => {
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
        { id: 'corrupt-squad', gameMode: '3v3', status: 'completed', createdAt: 1000, completedAt: 1500, seasonId: null, draftData: null },
        { id: 'later-squad', gameMode: '3v3', status: 'active', createdAt: 2000, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 2100 }) },
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
      expect(result.recalculatedMatchIds).toEqual(['corrupt-squad', 'later-squad'])

      const repairedParticipants = await db
        .select()
        .from(matchParticipants)
      expect(repairedParticipants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)

      const ratings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'squad'))
      expect(ratings.find(row => row.playerId === 'p1')?.gamesPlayed).toBe(2)
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

      const duoResult = await recalculateLeaderboardMode(db, 'duo')
      const squadResult = await recalculateLeaderboardMode(db, 'squad')

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
    { id: 'm1', gameMode: '1v1', status: 'completed', createdAt: 1000, completedAt: 2000, seasonId: null, draftData: null },
    { id: 'm2', gameMode: '1v1', status: 'completed', createdAt: 3000, completedAt: 4000, seasonId: null, draftData: null },
    { id: 'm3', gameMode: '1v1', status: 'completed', createdAt: 5000, completedAt: 6000, seasonId: null, draftData: null },
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

  await db.insert(playerRatings).values([
    { playerId: 'p1', mode: 'duel', mu: 26, sigma: 7.2, gamesPlayed: 3, wins: 2, lastPlayedAt: 6000 },
    { playerId: 'p2', mode: 'duel', mu: 24, sigma: 7.2, gamesPlayed: 3, wins: 1, lastPlayedAt: 6000 },
  ])
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
    gameMode: 'ffa',
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    seasonId: null,
    draftData: JSON.stringify({ completedAt: 1000 }),
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
    { id: 'duo-1', gameMode: '2v2', status: 'completed', createdAt: 1000, completedAt: 2000, seasonId: null, draftData: null },
    { id: 'squad-1', gameMode: '3v3', status: 'completed', createdAt: 3000, completedAt: 4000, seasonId: null, draftData: null },
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

  await db.insert(playerRatings).values([
    { playerId: 'p1', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
    { playerId: 'p2', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
    { playerId: 'p3', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 1, lastPlayedAt: 1000 },
    { playerId: 'p4', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
    { playerId: 'p5', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
    { playerId: 'p6', mode: 'squad', mu: 25, sigma: 8.333, gamesPlayed: 1, wins: 0, lastPlayedAt: 1000 },
  ])
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
