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
        originGuildId: 'guild-1',
        legacyGuildId: 'guild-1',
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

  test('updates the current result and appends a moderated archive correction', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: Array<{ method: string, url: string, payload: DiscordPayload }> = []

    try {
      await storeMatchMessageMapping(db, '00-draft-message', 'match-1')
      await storeMatchMessageMapping(db, '01-existing-archive', 'match-1')
      await kv.put('system:channel:draft', 'draft-channel')
      await kv.put('system:channel:archive', 'archive-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push({
          method: request.method,
          url: request.url,
          payload: await readDiscordRequestPayload(request),
        })

        if (request.method === 'PATCH' && request.url.includes('/channels/draft-channel/messages/00-draft-message')) {
          return Response.json({})
        }
        if (request.method === 'POST' && request.url.includes('/channels/archive-channel/messages')) {
          return Response.json({ id: '02-corrected-archive' })
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
        participants: buildParticipants('match-1'),
        moderation: {
          actorId: '100010000000000099',
          reason: 'Corrected the winner.',
        },
        archivePolicy: 'always',
        originGuildId: 'guild-1',
        legacyGuildId: 'guild-1',
      })

      expect(result).toEqual({
        draftMessageUpdated: true,
        archiveMessageCreated: true,
        errors: [],
      })
      expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
        'PATCH https://discord.com/api/v10/channels/draft-channel/messages/00-draft-message',
        'POST https://discord.com/api/v10/channels/archive-channel/messages',
      ])
      expect(calls.map(call => findEmbedField(call.payload, 'Note'))).toEqual([
        '<@100010000000000099> - Corrected the winner.',
        '<@100010000000000099> - Corrected the winner.',
      ])
    }
    finally {
      sqlite.close()
    }
  })

  test('keeps ordinary retry embeds unmoderated and skips an existing archive', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: Array<{ method: string, url: string, payload: DiscordPayload }> = []

    try {
      await storeMatchMessageMapping(db, '00-draft-message', 'match-1')
      await storeMatchMessageMapping(db, '01-existing-archive', 'match-1')
      await kv.put('system:channel:draft', 'draft-channel')
      await kv.put('system:channel:archive', 'archive-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push({
          method: request.method,
          url: request.url,
          payload: await readDiscordRequestPayload(request),
        })
        if (request.method === 'PATCH' && request.url.includes('/channels/draft-channel/messages/00-draft-message')) {
          return Response.json({})
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
        participants: buildParticipants('match-1'),
        archivePolicy: 'if-missing',
        originGuildId: 'guild-1',
        legacyGuildId: 'guild-1',
      })

      expect(result).toEqual({
        draftMessageUpdated: true,
        archiveMessageCreated: false,
        errors: [],
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.method).toBe('PATCH')
      expect(findEmbedField(calls[0]?.payload, 'Note')).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('does not overwrite an archive-only mapping when draft and archive share a channel', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: Array<{ method: string, url: string, payload: DiscordPayload }> = []

    try {
      await storeMatchMessageMapping(db, 'existing-archive', 'match-1')
      await kv.put('system:channel:draft', 'shared-results-channel')
      await kv.put('system:channel:archive', 'shared-results-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push({
          method: request.method,
          url: request.url,
          payload: await readDiscordRequestPayload(request),
        })
        if (request.method === 'POST' && request.url.includes('/channels/shared-results-channel/messages')) {
          return Response.json({ id: 'corrected-archive' })
        }
        return new Response('historical archive messages must not be edited', { status: 500 })
      }) as typeof fetch

      const result = await syncReportedMatchDiscordMessages({
        db,
        kv,
        token: 'token',
        matchId: 'match-1',
        reportedMode: '1v1',
        reportedRedDeath: false,
        participants: buildParticipants('match-1'),
        moderation: { actorLabel: 'Moderator', reason: 'Corrected result.' },
        archivePolicy: 'always',
        originGuildId: 'guild-1',
        legacyGuildId: 'guild-1',
      })

      expect(result).toEqual({
        draftMessageUpdated: false,
        archiveMessageCreated: true,
        errors: [],
      })
      expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
        'POST https://discord.com/api/v10/channels/shared-results-channel/messages',
      ])
      expect(findEmbedField(calls[0]?.payload, 'Note')).toBe('Moderator - Corrected result.')
    }
    finally {
      sqlite.close()
    }
  })

  test('adds moderation context to tournament result image messages', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: Array<{ method: string, url: string, contentType: string | null, payload: DiscordPayload }> = []

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
      const tournament = await createTournament(db, { name: 'Correction Cup', createdById: 'admin' })
      await createTournamentMatchLink(db, { tournamentId: tournament.id, sessionId: 'session-1', hostId: 'player-1' })
      await markTournamentMatchDrafting(db, 'session-1', 'match-1')
      await storeMatchMessageMapping(db, '00-draft-message', 'match-1')
      await storeMatchMessageMapping(db, '01-existing-archive', 'match-1')
      await kv.put('system:channel:tournament-draft', 'tournament-draft-channel')
      await kv.put('system:channel:tournament-archive', 'tournament-archive-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push({
          method: request.method,
          url: request.url,
          contentType: request.headers.get('content-type'),
          payload: await readDiscordRequestPayload(request),
        })

        if (request.method === 'PATCH' && request.url.includes('/channels/tournament-draft-channel/messages/00-draft-message')) {
          return Response.json({})
        }
        if (request.method === 'POST' && request.url.includes('/channels/tournament-archive-channel/messages')) {
          return Response.json({ id: '02-corrected-archive' })
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
        participants: buildParticipants('match-1'),
        moderation: {
          actorLabel: 'Tournament Director',
          reason: 'Corrected the bracket result.',
        },
        archivePolicy: 'always',
        originGuildId: 'guild-1',
        legacyGuildId: 'guild-1',
      })

      expect(result).toEqual({
        draftMessageUpdated: true,
        archiveMessageCreated: true,
        errors: [],
      })
      expect(calls.map(call => call.method)).toEqual(['PATCH', 'POST'])
      expect(calls.every(call => call.contentType?.startsWith('multipart/form-data'))).toBe(true)
      expect(calls.map(call => call.payload.content)).toEqual([
        'Correction: Tournament Director - Corrected the bracket result.',
        'Correction: Tournament Director - Corrected the bracket result.',
      ])
      expect(calls.every(call => JSON.stringify(call.payload.allowed_mentions) === JSON.stringify({ parse: [] }))).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('routes tournament reports to the tournament archive channel', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: Array<{ method: string, url: string, contentType: string | null, payload: DiscordPayload }> = []

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
        calls.push({
          method: request.method,
          url: request.url,
          contentType: request.headers.get('content-type'),
          payload: await readDiscordRequestPayload(request),
        })

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
        originGuildId: 'guild-1',
        legacyGuildId: 'guild-1',
      })

      expect(result.archiveMessageCreated).toBe(true)
      expect(result.errors).toEqual([])
      expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', url: 'https://discord.com/api/v10/channels/tournament-archive-channel/messages' }))
      expect(calls.every(call => call.contentType?.startsWith('multipart/form-data'))).toBe(true)
      expect(calls.every(call => call.payload.content == null)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('uses the explicit immutable origin rather than lobby metadata for scoped channel repair', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const calls: string[] = []

    try {
      await storeMatchMessageMapping(db, 'draft-message', 'match-1')
      await kv.put('system:channel:origin-guild:draft', 'origin-draft-channel')
      await kv.put('system:channel:origin-guild:archive', 'origin-archive-channel')
      await kv.put('system:channel:stale-guild:draft', 'stale-draft-channel')
      await kv.put('system:channel:stale-guild:archive', 'stale-archive-channel')

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        calls.push(`${request.method} ${request.url}`)
        if (request.method === 'PATCH' && request.url.includes('/channels/lobby-channel/messages/lobby-message')) {
          return new Response('forbidden', { status: 403 })
        }
        if (request.method === 'PATCH' && request.url.includes('/channels/origin-draft-channel/messages/draft-message')) {
          return Response.json({})
        }
        if (request.method === 'POST' && request.url.includes('/channels/origin-archive-channel/messages')) {
          return Response.json({ id: 'archive-message' })
        }
        return new Response('unexpected request', { status: 500 })
      }) as typeof fetch

      const lobby = { ...buildCompletedLobby(), guildId: 'stale-guild' }
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
        lobby,
        originGuildId: 'origin-guild',
        legacyGuildId: 'primary-guild',
      })

      expect(result.errors).toEqual([])
      expect(calls.some(call => call.includes('origin-draft-channel'))).toBe(true)
      expect(calls.some(call => call.includes('origin-archive-channel'))).toBe(true)
      expect(calls.some(call => call.includes('stale-draft-channel') || call.includes('stale-archive-channel'))).toBe(false)
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

interface DiscordPayload {
  content?: string | null
  embeds?: Array<{ fields?: Array<{ name?: string, value?: string }> }>
  allowed_mentions?: { parse?: string[] }
}

function buildParticipants(matchId: string) {
  return [
    { matchId, playerId: 'player-1', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
    { matchId, playerId: 'player-2', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
  ]
}

async function readDiscordRequestPayload(request: Request): Promise<DiscordPayload> {
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await request.formData()
    return JSON.parse(String(form.get('payload_json'))) as DiscordPayload
  }
  return await request.json() as DiscordPayload
}

function findEmbedField(payload: DiscordPayload | undefined, name: string): string | null {
  return payload?.embeds?.flatMap(embed => embed.fields ?? []).find(field => field.name === name)?.value ?? null
}
