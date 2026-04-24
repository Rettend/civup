import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { createLobby, getLobbyById, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { getReporterIdentityFromDraftData } from '../../src/services/match/draft-data.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match reporter identity', () => {
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
      })

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
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
      expect(await kv.get('lobby:host:p1')).toBe(lobby.id)
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
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(result.idempotent).toBe(true)
      expect(result.participants.every(participant => participant.ratingBeforeMu != null && participant.ratingAfterMu != null)).toBe(true)
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
