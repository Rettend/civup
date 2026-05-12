import type { LobbyState } from '../../src/services/lobby/index.ts'
import { matches, players } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { storeMatchMessageMapping } from '../../src/services/match/message.ts'
import { syncReportedMatchDiscordMessages } from '../../src/services/match/report-discord.ts'
import { createTournament, createTournamentMatchLink, markTournamentMatchDrafting } from '../../src/services/tournament/index.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('reported match Discord sync', () => {
  test('falls back to the mapped draft message when lobby edit fails', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: string[] = []
    const originalConsoleError = console.error

    try {
      console.error = () => undefined
      await db.insert(matches).values({
        id: 'match-1',
        gameMode: '1v1',
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: null,
        createdAt: 1,
        completedAt: 2,
      })
      await storeMatchMessageMapping(db, 'draft-message', 'match-1')
      await kv.put('system:channel:draft', 'draft-channel')
      await kv.put('system:channel:archive', 'archive-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push(`${request.method} ${request.url}`)

        if (request.method === 'PATCH' && request.url.includes('/channels/lobby-channel/messages/lobby-message')) {
          return new Response('forbidden', { status: 403 })
        }
        if (request.method === 'PATCH' && request.url.includes('/channels/draft-channel/messages/draft-message')) {
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
        }
        if (request.method === 'POST' && request.url.includes('/channels/archive-channel/messages')) {
          return new Response(JSON.stringify({ id: 'archive-message' }), { headers: { 'Content-Type': 'application/json' } })
        }

        return new Response('unexpected request', { status: 500 })
      }) as typeof fetch

      const result = await syncReportedMatchDiscordMessages({
        db,
        kv,
        token: 'token',
        matchId: 'match-1',
        reportedMode: '1v1',
        reportedRedDeath: false,
        participants: [
          { matchId: 'match-1', playerId: 'player-1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
          { matchId: 'match-1', playerId: 'player-2', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        ],
        lobby: buildCompletedLobby(),
      })

      expect(result).toEqual({
        draftMessageUpdated: true,
        archiveMessageCreated: true,
        errors: [],
      })
      expect(calls).toContain('PATCH https://discord.com/api/v10/channels/lobby-channel/messages/lobby-message')
      expect(calls).toContain('PATCH https://discord.com/api/v10/channels/draft-channel/messages/draft-message')
      expect(calls).toContain('POST https://discord.com/api/v10/channels/archive-channel/messages')
    }
    finally {
      console.error = originalConsoleError
      sqlite.close()
    }
  })

  test('routes tournament reports to the tournament archive channel', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: string[] = []

    try {
      await db.insert(players).values([
        { id: 'player-1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'player-2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'match-1',
        gameMode: '1v1',
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: null,
        createdAt: 1,
        completedAt: 2,
      })
      const tournament = await createTournament(db, { name: 'Archive Cup', createdById: 'admin' })
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'session-1', hostId: 'player-1' })
      await markTournamentMatchDrafting(db, 'session-1', 'match-1')
      await storeMatchMessageMapping(db, 'draft-message', 'match-1')
      await kv.put('system:channel:tournament-draft', 'tournament-draft-channel')
      await kv.put('system:channel:tournament-archive', 'tournament-archive-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push(`${request.method} ${request.url}`)

        if (request.method === 'PATCH' && request.url.includes('/channels/tournament-draft-channel/messages/draft-message')) {
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
        }
        if (request.method === 'POST' && request.url.includes('/channels/tournament-archive-channel/messages')) {
          return new Response(JSON.stringify({ id: 'archive-message' }), { headers: { 'Content-Type': 'application/json' } })
        }

        return new Response('unexpected request', { status: 500 })
      }) as typeof fetch

      const result = await syncReportedMatchDiscordMessages({
        db,
        kv,
        token: 'token',
        matchId: 'match-1',
        reportedMode: '1v1',
        reportedRedDeath: false,
        participants: [
          { matchId: 'match-1', playerId: 'player-1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
          { matchId: 'match-1', playerId: 'player-2', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        ],
      })

      expect(result.archiveMessageCreated).toBe(true)
      expect(result.errors).toEqual([])
      expect(calls).toContain('POST https://discord.com/api/v10/channels/tournament-archive-channel/messages')
    }
    finally {
      sqlite.close()
    }
  })
})

function buildCompletedLobby(): LobbyState {
  return {
    id: 'match-1',
    mode: '1v1',
    status: 'completed',
    guildId: 'guild-1',
    hostId: 'player-1',
    channelId: 'lobby-channel',
    messageId: 'lobby-message',
    matchId: 'match-1',
    steamLobbyLink: null,
    minRole: null,
    maxRole: null,
    lastArrange: null,
    lastActivityAt: 1,
    memberPlayerIds: ['player-1', 'player-2'],
    slots: ['player-1', 'player-2'],
    draftConfig: {
      banTimerSeconds: null,
      pickTimerSeconds: null,
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      mapVoteEnabled: false,
      blindBans: true,
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    },
    createdAt: 1,
    updatedAt: 2,
    revision: 1,
  }
}
