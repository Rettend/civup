import { matches, matchParticipants, playerRatings as legacyPlayerRatings, players, scopedPlayerRatingEvents as playerRatingEvents, scopedPlayerRatings as playerRatings } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getReporterIdentityFromDraftData } from '../../src/services/match/draft-data.ts'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand, runSessionTerminalLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import { createLobby, getLobbyById, getTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match reporter identity', () => {
  const GUILD_ID = '111111111111111111'
  const STATS_KEY = `server:${GUILD_ID}` as const
  const directTerminalOptions = { allowDirectTerminalWriteForTests: true, primaryGuildId: GUILD_ID }

  test('stores the reporter id in draft data and resolves footer identity from seats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        {
          id: 'p1',
          displayName: 'Player One',
          avatarUrl: 'https://cdn.discordapp.com/avatars/p1/avatar.png',
          createdAt: 1,
        },
        {
          id: 'p2',
          displayName: 'Player Two',
          avatarUrl: null,
          createdAt: 1,
        },
      ])
      await db.insert(matches).values({
        id: 'm1',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 1,
          state: {
            seats: [
              {
                playerId: 'p1',
                displayName: 'Fresh Reporter',
                avatarUrl: 'https://cdn.discordapp.com/avatars/p1/fresh.png',
                team: 0,
              },
              {
                playerId: 'p2',
                displayName: 'Player Two',
                avatarUrl: null,
                team: 1,
              },
            ],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        {
          matchId: 'm1',
          playerId: 'p1',
          team: 0,
          civId: null,
          placement: null,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
        {
          matchId: 'm1',
          playerId: 'p2',
          team: 1,
          civId: null,
          placement: null,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'm1',
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(getReporterIdentityFromDraftData(result.match.draftData)).toEqual({
        userId: 'p1',
        displayName: 'Fresh Reporter',
        avatarUrl: 'https://cdn.discordapp.com/avatars/p1/fresh.png',
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('reportMatch fails closed without SessionDO before mutating placements', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'missing-session-do',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({ completedAt: 1 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'missing-session-do', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'missing-session-do', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'missing-session-do',
        reporterId: 'p1',
        placements: '<@p1>',
      }, { primaryGuildId: GUILD_ID })

      expect(result).toEqual({ error: 'SessionDO binding is required to validate match lifecycle.' })
      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'missing-session-do'))
      expect(participants.every(participant => participant.placement == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('primary reports preserve legacy ratings before the scoped backfill runs', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'legacy-rating-cutover',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 10,
        draftData: JSON.stringify({ completedAt: 10 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'legacy-rating-cutover', playerId: 'p1', team: 0 },
        { matchId: 'legacy-rating-cutover', playerId: 'p2', team: 1 },
      ])
      await db.insert(legacyPlayerRatings).values([
        { playerId: 'p1', mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, wins: 7, updatedAt: 9 },
        { playerId: 'p1', mode: 'global', mu: 39, sigma: 6, gamesPlayed: 10, wins: 7, updatedAt: 9 },
        { playerId: 'p2', mode: 'duel', mu: 30, sigma: 7, gamesPlayed: 8, wins: 4, updatedAt: 9 },
        { playerId: 'p2', mode: 'global', mu: 29, sigma: 7, gamesPlayed: 8, wins: 4, updatedAt: 9 },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'legacy-rating-cutover',
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.participants.find(player => player.playerId === 'p1')?.ratingBeforeMu).toBe(40)
      expect(result.participants.find(player => player.playerId === 'p2')?.ratingBeforeMu).toBe(30)
      expect(await db.select().from(playerRatings)).toHaveLength(4)
    }
    finally {
      sqlite.close()
    }
  })

  test('current reports clear participant activity adjustment in before and after ranks', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const now = 200 * 86_400_000
    const statsContext = createStatsContext(GUILD_ID, GUILD_ID)

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'activity-reset',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        draftData: JSON.stringify({ completedAt: 2 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'activity-reset', playerId: 'p1', team: 0 },
        { matchId: 'activity-reset', playerId: 'p2', team: 1 },
      ])
      await db.insert(playerRatings).values([
        { statsKey: STATS_KEY, playerId: 'p1', mode: 'duel', mu: 40, sigma: 5, gamesPlayed: 10, wins: 7, lastPlayedAt: now - (120 * 86_400_000) },
        { statsKey: STATS_KEY, playerId: 'p1', mode: 'global', mu: 40, sigma: 5, gamesPlayed: 10, wins: 7, lastPlayedAt: now - (120 * 86_400_000) },
        { statsKey: STATS_KEY, playerId: 'p2', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 5, lastPlayedAt: now },
        { statsKey: STATS_KEY, playerId: 'p2', mode: 'global', mu: 30, sigma: 5, gamesPlayed: 10, wins: 5, lastPlayedAt: now },
      ])
      await kv.put(leaderboardModeSnapshotKey(statsContext, 'duel'), JSON.stringify({
        version: 3,
        updatedAt: 1,
        rows: [
          { playerId: 'p1', mu: 40, sigma: 5, gamesPlayed: 10, wins: 7, lastPlayedAt: now - (120 * 86_400_000) },
          { playerId: 'challenger', mu: 39, sigma: 5, gamesPlayed: 10, wins: 6, lastPlayedAt: now },
          { playerId: 'p2', mu: 30, sigma: 5, gamesPlayed: 10, wins: 5, lastPlayedAt: now },
        ],
      }))

      const result = await reportMatch(db, kv, {
        matchId: 'activity-reset',
        reporterId: 'p1',
        placements: '<@p1>',
      }, { ...directTerminalOptions, now })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.participants.find(player => player.playerId === 'p1')).toMatchObject({
        leaderboardBeforeRank: 2,
        leaderboardAfterRank: 1,
      })
      const modeRatings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))
      expect(modeRatings.find(row => row.playerId === 'p1')?.lastPlayedAt).toBe(now)
    }
    finally {
      sqlite.close()
    }
  })

  test('non-seed rated report terminal failure rolls back D1 and hidden leader mutations when SessionDO remains active', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 1 }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 1 },
          { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 1 },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, { db, sessionNamespace: runtime.sessionNamespace })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: 2 })
      await db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: 2, hiddenDraft: true }) }).where(eq(matches.id, lobby.id))

      const result = await reportMatch(db, kv, {
        matchId: lobby.id,
        reporterId: 'p1',
        placements: '<@p1>',
        leaderAssignments: {
          p1: allLeaderIds[0]!,
          p2: allLeaderIds[1]!,
        },
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
      expect(participants.every(participant => participant.civId == null && participant.placement == null && participant.ratingBeforeMu == null && participant.ratingAfterMu == null)).toBe(true)
      expect(await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('reported SessionDO retry finalizes D1 without applying placements again', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries: [{ playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 1 }],
      })
      const runtime = await getTestLobbyRuntime(kv, db)
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries: [
          { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 1 },
          { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 1 },
        ],
      })
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, { db, sessionNamespace: runtime.sessionNamespace })
      await runSessionDraftLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'draft-completed', at: 2 })
      await db.update(matches).set({ status: 'active', draftData: JSON.stringify({ completedAt: 2 }) }).where(eq(matches.id, lobby.id))
      await db.update(matchParticipants).set({ placement: 2 }).where(eq(matchParticipants.matchId, lobby.id))
      await runSessionTerminalLifecycleCommand(runtime.sessionNamespace, lobby.id, { type: 'mark-reported', matchId: lobby.id, at: 3 })
      await db.update(matches).set({ status: 'active', completedAt: null }).where(eq(matches.id, lobby.id))

      const result = await reportMatch(db, kv, {
        matchId: lobby.id,
        reporterId: 'p1',
        placements: '<@p1>',
      }, {
        sessionNamespace: runtime.sessionNamespace,
        primaryGuildId: GUILD_ID,
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.idempotent).toBe(true)
      expect(result.match.status).toBe('completed')
      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, lobby.id))
      expect(participants.every(participant => participant.placement === 2)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('active rated reports with existing rating events do not apply ratings again', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'active-existing-events',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 2,
          state: {
            seats: [
              { playerId: 'p1', displayName: 'Player One', avatarUrl: null, team: 0 },
              { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, team: 1 },
            ],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'active-existing-events', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'active-existing-events', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const first = await reportMatch(db, kv, {
        matchId: 'active-existing-events',
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)
      expect('error' in first).toBe(false)
      if ('error' in first) return

      const ratingsAfterFirst = sortByPlayerAndMode(await db.select().from(playerRatings))
      const eventsAfterFirst = sortByPlayerAndMode(await db.select().from(playerRatingEvents))
      expect(ratingsAfterFirst).toHaveLength(4)
      expect(eventsAfterFirst).toHaveLength(4)

      await db.update(matches).set({ status: 'active', completedAt: null }).where(eq(matches.id, 'active-existing-events'))

      const second = await reportMatch(db, kv, {
        matchId: 'active-existing-events',
        reporterId: 'p2',
        placements: '<@p2>',
      }, directTerminalOptions)

      expect('error' in second).toBe(false)
      if ('error' in second) return
      expect(second.idempotent).toBe(true)
      expect(second.match.status).toBe('completed')
      expect(sortByPlayerAndMode(await db.select().from(playerRatings))).toEqual(ratingsAfterFirst)
      expect(sortByPlayerAndMode(await db.select().from(playerRatingEvents))).toEqual(eventsAfterFirst)

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'active-existing-events'))
      const placementByPlayerId = new Map(participants.map(participant => [participant.playerId, participant.placement]))
      expect(placementByPlayerId.get('p1')).toBe(1)
      expect(placementByPlayerId.get('p2')).toBe(2)
    }
    finally {
      sqlite.close()
    }
  })

  test('active rated reports clean partial prepared rating state before retrying', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'partial-prepared-events',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({ completedAt: 2 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'partial-prepared-events', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 30, ratingAfterSigma: 7 },
        { matchId: 'partial-prepared-events', playerId: 'p2', team: 1, civId: null, placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 20, ratingAfterSigma: 7 },
      ])
      await db.insert(playerRatings).values({
        statsKey: STATS_KEY,
        playerId: 'p1',
        mode: 'duel',
        mu: 30,
        sigma: 7,
        gamesPlayed: 1,
        wins: 1,
        lastPlayedAt: 3,
        updatedAt: 3,
      })
      await db.insert(playerRatingEvents).values({
        statsKey: STATS_KEY,
        matchId: 'partial-prepared-events',
        playerId: 'p1',
        mode: 'duel',
        gameMode: '1v1',
        ratingBeforeMu: 25,
        ratingBeforeSigma: 8.333,
        ratingAfterMu: 30,
        ratingAfterSigma: 7,
        gamesDelta: 1,
        winsDelta: 1,
        importedGamesDelta: 0,
        effectiveGamesDelta: 1,
        winsVsTier1Delta: 0,
        winsVsTier2PlusDelta: 0,
        effectiveWinsVsTier1Delta: 0,
        effectiveWinsVsTier2PlusDelta: 0,
        matchCreatedAt: 1,
        matchCompletedAt: 3,
        updatedAt: 3,
      })

      const result = await reportMatch(db, kv, {
        matchId: 'partial-prepared-events',
        reporterId: 'p1',
        placements: '<@p2>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('completed')
      expect(await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'partial-prepared-events'))).toHaveLength(4)

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'partial-prepared-events'))
      const placementByPlayerId = new Map(participants.map(participant => [participant.playerId, participant.placement]))
      expect(placementByPlayerId.get('p1')).toBe(2)
      expect(placementByPlayerId.get('p2')).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('reportMatch clears activity residue but leaves the lobby available for message sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      const runtime = await getTestLobbyRuntime(kv, db)
      const queueEntries = [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 1 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 1 },
      ]
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        sessionNamespace: runtime.sessionNamespace,
        queueEntries,
      })
      const matchId = lobby.id
      await db.insert(matches).values({
        id: matchId,
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 1,
          state: {
            seats: [
              { playerId: 'p1', displayName: 'Player One', avatarUrl: null, team: 0 },
              { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, team: 1 },
            ],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        { matchId, playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId, playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const runtimeOptions = { db, sessionNamespace: runtime.sessionNamespace, queueEntries }
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, runtimeOptions)
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, runtimeOptions)

      const result = await reportMatch(db, kv, {
        matchId,
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
      expect(await kv.get('lobby:host:p1')).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('completed explicit report requests still use the idempotent repair path', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'm3',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'completed',
        createdAt: 1,
        completedAt: 2,
        seasonId: null,
        draftData: JSON.stringify({ completedAt: 1 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'm3', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'm3', playerId: 'p2', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'm3',
        reporterId: 'p1',
        placements: '',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.idempotent).toBe(true)
      expect(result.participants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('completed reports repair incomplete rating events even when snapshots exist', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'completed-incomplete-events',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'completed',
        createdAt: 1,
        completedAt: 3,
        seasonId: null,
        draftData: JSON.stringify({ completedAt: 2 }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'completed-incomplete-events', playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 30, ratingAfterSigma: 7 },
        { matchId: 'completed-incomplete-events', playerId: 'p2', team: 1, civId: null, placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 20, ratingAfterSigma: 7 },
      ])
      await db.insert(playerRatingEvents).values([
        {
          statsKey: STATS_KEY,
          matchId: 'completed-incomplete-events',
          playerId: 'p1',
          mode: 'duel',
          gameMode: '1v1',
          ratingBeforeMu: 25,
          ratingBeforeSigma: 8.333,
          ratingAfterMu: 30,
          ratingAfterSigma: 7,
          gamesDelta: 1,
          winsDelta: 1,
          importedGamesDelta: 0,
          effectiveGamesDelta: 1,
          winsVsTier1Delta: 0,
          winsVsTier2PlusDelta: 0,
          effectiveWinsVsTier1Delta: 0,
          effectiveWinsVsTier2PlusDelta: 0,
          matchCreatedAt: 1,
          matchCompletedAt: 3,
          updatedAt: 3,
        },
        {
          statsKey: STATS_KEY,
          matchId: 'completed-incomplete-events',
          playerId: 'p2',
          mode: 'duel',
          gameMode: '1v1',
          ratingBeforeMu: 25,
          ratingBeforeSigma: 8.333,
          ratingAfterMu: 20,
          ratingAfterSigma: 7,
          gamesDelta: 1,
          winsDelta: 0,
          importedGamesDelta: 0,
          effectiveGamesDelta: 1,
          winsVsTier1Delta: 0,
          winsVsTier2PlusDelta: 0,
          effectiveWinsVsTier1Delta: 0,
          effectiveWinsVsTier2PlusDelta: 0,
          matchCreatedAt: 1,
          matchCompletedAt: 3,
          updatedAt: 3,
        },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'completed-incomplete-events',
        reporterId: 'p1',
        placements: '',
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.idempotent).toBe(true)
      expect(await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'completed-incomplete-events'))).toHaveLength(4)
    }
    finally {
      sqlite.close()
    }
  })

  test('hidden draft reports require leader assignments for every participant', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'hidden-missing-leaders',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 1,
          hiddenDraft: true,
          state: {
            seats: [
              { playerId: 'p1', displayName: 'Player One', avatarUrl: null, team: 0 },
              { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, team: 1 },
            ],
            availableCivIds: allLeaderIds.slice(0, 2),
            bans: [],
            picks: [],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'hidden-missing-leaders', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'hidden-missing-leaders', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'hidden-missing-leaders',
        reporterId: 'p1',
        placements: '<@p1>',
      }, directTerminalOptions)

      expect(result).toEqual({ error: 'Hidden draft reports require leader assignments for every participant.' })
      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'hidden-missing-leaders'))
      expect(participants.every(participant => participant.civId == null && participant.placement == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('hidden draft reports store leader assignments while finalizing', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const leaderOne = allLeaderIds[0]!
    const leaderTwo = allLeaderIds[1]!

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'hidden-report',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 1,
          hiddenDraft: true,
          state: {
            seats: [
              { playerId: 'p1', displayName: 'Player One', avatarUrl: null, team: 0 },
              { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, team: 1 },
            ],
            availableCivIds: [leaderOne, leaderTwo],
            bans: [],
            picks: [],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'hidden-report', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'hidden-report', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'hidden-report',
        reporterId: 'p1',
        placements: '<@p1>',
        leaderAssignments: {
          p1: leaderOne,
          p2: leaderTwo,
        },
      }, directTerminalOptions)

      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.match.status).toBe('completed')

      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'hidden-report'))
      const civByPlayer = new Map(participants.map(participant => [participant.playerId, participant.civId]))
      expect(civByPlayer.get('p1')).toBe(leaderOne)
      expect(civByPlayer.get('p2')).toBe(leaderTwo)
    }
    finally {
      sqlite.close()
    }
  })

  test('active matches without draft completion cannot be reported yet', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'm4',
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({ state: { seats: [{ playerId: 'p1' }, { playerId: 'p2' }] } }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'm4', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'm4', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      await expect(reportMatch(db, kv, {
        matchId: 'm4',
        reporterId: 'p1',
        placements: '<@p1>',
      }, { primaryGuildId: GUILD_ID })).resolves.toEqual({
        error: 'Match **m4** is not ready to report until the draft is complete.',
      })
    }
    finally {
      sqlite.close()
    }
  })
})

function sortByPlayerAndMode<T extends { playerId: string, mode: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.playerId.localeCompare(b.playerId) || a.mode.localeCompare(b.mode))
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
