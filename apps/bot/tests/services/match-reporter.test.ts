import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getReporterIdentityFromDraftData } from '../../src/services/match/draft-data.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand, runSessionTerminalLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import { createLobby, getLobbyById, getTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match reporter identity', () => {
  const directTerminalOptions = { allowDirectTerminalWriteForTests: true }

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
      })

      expect(result).toEqual({ error: 'SessionDO binding is required to validate match lifecycle.' })
      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'missing-session-do'))
      expect(participants.every(participant => participant.placement == null)).toBe(true)
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

  test('reportMatch clears activity residue but leaves the lobby available for message sync', async () => {
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
      })
      const matchId = lobby.id
      await db.insert(matches).values({
        id: matchId,
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

      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby)
      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby)

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
      })).resolves.toEqual({
        error: 'Match **m4** is not ready to report until the draft is complete.',
      })
    }
    finally {
      sqlite.close()
    }
  })
})

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
